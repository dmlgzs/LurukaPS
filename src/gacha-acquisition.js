import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { grantRewards, parseRewards } from './rewards.js'
import { nextHeroAcquisitionCount, recordHeroAcquisition } from './hero-acquisition.js'

// Gacha.proto: GachaSurprise.SurpriseType.SURPRISE_TYPE_UNSPECIFIED.
const SURPRISE_TYPE_UNSPECIFIED = 0

export function gachaPresentationResult(result) {
    ensure(
        result && typeof result === 'object' && !Array.isArray(result),
        'Invalid saved gacha result',
        ErrorCode.GameConfig,
    )
    const surprise = result.gacha_surprise
    // CBT3 dereferences this optional object in CheckUpgradeSurprise. Supply
    // the defined normal state; do not manufacture a rarity upgrade animation.
    // Old paid receipts also omitted it, so normalize their wire copy only.
    if (surprise === undefined) return { ...result, gacha_surprise: { surprise_type: SURPRISE_TYPE_UNSPECIFIED } }
    ensure(
        surprise &&
            typeof surprise === 'object' &&
            !Array.isArray(surprise) &&
            [0, 1, 2].includes(surprise.surprise_type),
        'Invalid saved gacha surprise state',
        ErrorCode.GameConfig,
    )
    return result
}

export const gachaWireItem = ({ itemtype, itemid, itemnum }) => ({
    item_type: itemtype,
    item_id: itemid,
    item_num: itemnum,
})
function duplicateItem(tables, config, count, limitToProgression) {
    const rows = String(config.gradeUpItem || '')
        .split('|')
        .filter(Boolean)
        .map((token) => {
            const [itemid, itemnum, ...rest] = token.split('#').map(Number)
            ensure(
                !rest.length && [itemid, itemnum].every((n) => Number.isSafeInteger(n) && n > 0),
                'Invalid duplicate hero grade item',
                ErrorCode.GameConfig,
            )
            return { itemtype: 3, itemid, itemnum }
        })
    ensure(
        rows.length && tables.find('common_item', rows[0].itemid),
        'Duplicate hero item unavailable',
        ErrorCode.GameConfig,
    )
    ensure(
        rows.every((row) => row.itemid === rows[0].itemid && row.itemnum === rows[0].itemnum),
        'Nonuniform duplicate hero conversion is not implemented',
        ErrorCode.FunctionClosed,
    )
    // Each progression slot accounts for one repeat after the initial hero.
    // CBT3's observation description stops shards after those six slots.
    // Self-choice has a separate, unproven overflow conversion contract;
    // preserve its existing no-extra-currency conversion until verified.
    return limitToProgression && count > rows.length + 1 ? undefined : rows[0]
}
function extraRewards(tables, type, rarity, count) {
    const rows = tables.get('gacha_add_reward')
    ensure(
        rows.every((row) =>
            [row.type, row.rarity, row.minCount, row.maxCount].every((n) => Number.isInteger(n) && n >= 0),
        ),
        'Malformed gacha extra reward bands',
        ErrorCode.GameConfig,
    )
    const matching = rows.filter(
        (row) =>
            row.type === type &&
            row.rarity === rarity &&
            (!row.minCount || count >= row.minCount) &&
            (!row.maxCount || count <= row.maxCount),
    )
    ensure(matching.length === 1, 'Gacha extra reward band unavailable or ambiguous', ErrorCode.GameConfig)
    return parseRewards(matching[0].reward)
}
export function grantGachaAcquisition(tables, state, item, { extra = true } = {}) {
    ensure(
        [1, 9].includes(item.itemtype) && item.itemnum === 1,
        'Invalid gacha acquisition category',
        ErrorCode.GameConfig,
    )
    const config = tables.find(item.itemtype === 1 ? 'hero' : 'soulessence', item.itemid)
    ensure(
        config && Number.isInteger(config.rarity) && config.rarity > 0,
        'Gacha acquisition configuration unavailable',
        ErrorCode.GameConfig,
    )
    let transform,
        count = 0,
        newHero = false,
        delivered = []
    if (item.itemtype === 1) {
        const owned = state.player.heros_info.heros.some((hero) => hero.conf_id === item.itemid && !hero.trail)
        count = nextHeroAcquisitionCount(state, item.itemid, owned)
        if (owned) {
            transform = duplicateItem(tables, config, count, extra)
            if (transform) delivered.push(...grantRewards(tables, state, [transform]))
            recordHeroAcquisition(state, item.itemid, true)
        } else {
            delivered.push(...grantRewards(tables, state, [item]))
            newHero = true
        }
        ensure(
            state.heroAcquisitionCounts[item.itemid] === count,
            'Hero acquisition counter mismatch',
            ErrorCode.GameConfig,
        )
    } else delivered.push(...grantRewards(tables, state, [item]))
    const additions = extra ? extraRewards(tables, item.itemtype === 1 ? 1 : 2, config.rarity, count) : []
    delivered.push(...grantRewards(tables, state, additions))
    return {
        result: gachaPresentationResult({
            main_item: gachaWireItem(item),
            extra_item: additions.map(gachaWireItem),
            ...(transform ? { transform_item: gachaWireItem(transform) } : {}),
        }),
        delivered,
        newHero,
        rarity: config.rarity,
        count,
    }
}
