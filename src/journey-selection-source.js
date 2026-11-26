import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { parseRewards } from './rewards.js'
import { requireCustomSoulGiftCapacity } from './custom-soul-gift.js'

export function journeySelectionSource(tables, row) {
    ensure(
        Array.isArray(row.rewards) &&
            row.rewards.length === 1 &&
            row.rewards[0].itemtype === 3 &&
            row.rewards[0].itemnum === 1,
        'Journey special reward is not a single configured selection definition',
        ErrorCode.JourneyConfError,
    )
    const box = tables.find('common_item', row.rewards[0].itemid)
    ensure(
        box && typeof box.giftBagReward === 'string' && box.giftBagReward.length > 0,
        'Journey selection definition is unavailable',
        ErrorCode.JourneyConfError,
    )
    // Current PageJourneySoulEssenceSelect.SetOptions (0602da1a) reads the
    // configured giftBagReward directly, without using the bag useType router.
    // Validate the full soul UI definition before considering a user choice.
    const choices = parseRewards(box.giftBagReward)
    ensure(choices.length > 0, 'Journey selection definition is empty', ErrorCode.JourneyConfError)
    const identities = new Set()
    for (const choice of choices) {
        ensure(
            choice.itemtype === 9 && choice.itemnum === 1 && !identities.has(choice.itemid),
            'Journey soul selection definition is mixed, duplicated or nonunique',
            ErrorCode.JourneyConfError,
        )
        ensure(
            tables.find('soulessence', choice.itemid),
            'Journey soul selection member configuration is missing',
            ErrorCode.SoulEssenceConfNotExist,
        )
        identities.add(choice.itemid)
    }
    return { box, choices }
}
export function selectJourneySoulReward(tables, source, itemid, itemtype) {
    const matches = source.choices.filter((r) => r.itemid === itemid && r.itemtype === itemtype)
    ensure(
        itemtype === 9 && matches.length > 0,
        'Reward is not in the journey soul selection',
        ErrorCode.InvalidArgument,
    )
    ensure(
        matches.length === 1 && matches[0].itemnum === 1,
        'Journey soul selection is ambiguous or has an unsupported quantity',
        ErrorCode.JourneyConfError,
    )
    ensure(
        tables.find('soulessence', itemid),
        'Journey selected soul configuration is missing',
        ErrorCode.SoulEssenceConfNotExist,
    )
    return { ...matches[0] }
}
export function requireJourneySoulCapacity(tables, state, chosen) {
    // Manual selection uses the current published destination capacity, without
    // consuming a bag box or inventing an overflow-mail backend policy.
    requireCustomSoulGiftCapacity(tables, state, [chosen])
}
