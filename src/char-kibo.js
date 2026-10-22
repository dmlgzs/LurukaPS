import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { grantRewards, parseRewards } from './rewards.js'
import { rewardSource } from './reward-source.js'

const validGuid = (guid) =>
    typeof guid === 'string' && /^[1-9]\d{0,19}$/.test(guid) && BigInt(guid) <= 0xffffffffffffffffn

function checkConditions(tables, state, value) {
    const tokens = typeof value === 'string' ? value.split('|') : []
    ensure(tokens.length > 0 && tokens.every(Boolean), 'Missing exclusive pet unlock conditions', ErrorCode.GameConfig)
    for (const token of tokens) {
        const args = token.split('#').map(Number)
        ensure(
            args.length === 3 && args.every(Number.isSafeInteger) && args[0] > 0 && args[1] > 0 && args[2] >= 0,
            'Malformed exclusive pet unlock condition',
            ErrorCode.GameConfig,
        )
        const [type, id, required] = args
        ensure(type === 13000, 'Exclusive pet unlock condition is not implemented', ErrorCode.InvalidProtoID)
        ensure(
            tables.find('common_condition', type)?.name === 'HeroFavorability' &&
                tables.find('hero', id) &&
                tables.get('hero_favorability_exp').some((r) => r.favorabilityLevel === required),
            'Invalid exclusive pet favorability condition',
            ErrorCode.GameConfig,
        )
        const actor = state.player.heros_info.heros.find((h) => h.conf_id === id && !h.trail)
        const level = actor?.favorability_lv ?? 0
        ensure(Number.isSafeInteger(level) && level >= 0, 'Invalid saved hero favorability', ErrorCode.GameConfig)
        ensure(actor && level >= required, 'Exclusive pet unlock conditions not met', ErrorCode.InvalidArgument)
    }
}

export function claimCharKibo(tables, state, request, now) {
    const guid = String(request.hero_guid ?? '0')
    const actor = state.player.heros_info.heros.find((h) => h.guid === guid && !h.trail)
    ensure(actor, 'Exclusive pet hero is not owned', ErrorCode.HeroNotExist)
    const hero = tables.find('hero', actor.conf_id)
    ensure(hero, 'Missing owned hero configuration', ErrorCode.GameConfig)
    const row = tables.find('char_kibo', actor.conf_id)
    ensure(row && row.getType === 1, 'Hero does not have a manually claimable exclusive pet', ErrorCode.InvalidArgument)
    const petId = Number(hero.kiboId)
    ensure(Number.isSafeInteger(petId) && petId > 0, 'Invalid hero exclusive pet reference', ErrorCode.GameConfig)
    ensure(request.config_id === petId, 'Exclusive pet does not match the hero', ErrorCode.InvalidArgument)
    checkConditions(tables, state, row.unlockCondition)
    const rewards = parseRewards(row.unlockReward)
    ensure(rewards.length > 0, 'Exclusive pet reward is empty', ErrorCode.HeroFavorRewardEmpty)
    ensure(
        rewards.every((r) => r.itemtype === 30),
        'Exclusive pet reward type is not implemented',
        ErrorCode.InvalidProtoID,
    )
    ensure(
        rewards.length === 1 &&
            rewards[0].itemnum === 1 &&
            tables.find('pet_customized', rewards[0].itemid)?.petId === petId,
        'Exclusive pet reward and hero configuration disagree',
        ErrorCode.GameConfig,
    )
    ensure(tables.find('pet', petId), 'Exclusive pet configuration does not exist', ErrorCode.PetConfNotExist)
    const claims = state.charKiboClaims ?? {}
    ensure(
        claims && typeof claims === 'object' && !Array.isArray(claims),
        'Invalid exclusive pet receipts',
        ErrorCode.GameConfig,
    )
    const receipt = claims[actor.conf_id]
    if (receipt !== undefined) {
        ensure(
            receipt &&
                receipt.hero_id === actor.conf_id &&
                receipt.pet_id === petId &&
                validGuid(receipt.guid) &&
                Number.isSafeInteger(receipt.time) &&
                receipt.time >= 0,
            'Invalid exclusive pet receipt',
            ErrorCode.GameConfig,
        )
        return { rewards: [], src: rewardSource(tables, 'heroExclusivePet') }
    }
    // Current UI switches to "view" whenever this permanent species exists.
    // Retain a private receipt as well: no undocumented char_kibo_state enum is
    // invented, and removal/import tools cannot accidentally reissue the reward.
    const existing = state.pets.find((p) => p.config_id === petId && p.type !== 2)
    ensure(!existing || validGuid(existing.guid), 'Invalid owned exclusive pet identity', ErrorCode.GameConfig)
    let granted = []
    if (!existing) {
        const boxCount = Number(tables.get('game').find((r) => r.title === 'PET_BOX_NUM')?.value)
        const boxSize = Number(tables.get('game').find((r) => r.title === 'PET_BOX_LIMIT')?.value)
        ensure(
            Number.isSafeInteger(boxCount) &&
                boxCount > 0 &&
                Number.isSafeInteger(boxSize) &&
                boxSize > 0 &&
                boxSize < 100,
            'Invalid pet box capacity configuration',
            ErrorCode.GameConfig,
        )
        ensure(
            state.pets.length < boxCount * boxSize,
            'Pet boxes are full; cannot claim exclusive pet',
            ErrorCode.MailPetFull,
        )
        granted = grantRewards(tables, state, rewards)
    }
    state.charKiboClaims = {
        ...claims,
        [actor.conf_id]: { hero_id: actor.conf_id, pet_id: petId, guid: existing?.guid ?? granted[0].guid, time: now },
    }
    return { rewards: granted, src: rewardSource(tables, 'heroExclusivePet') }
}
