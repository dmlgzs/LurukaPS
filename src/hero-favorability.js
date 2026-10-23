import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { temporaryHeroes } from './trial-actors.js'

const uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
const positive = (value) => uint(value) && value > 0
const guid = (value) => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) && BigInt(value) <= 0xffffffffffffffffn

function configuration(tables, heroId) {
    const rows = tables.get('hero_favorability_exp')
    ensure(
        Array.isArray(rows) && rows.length > 0,
        'Hero favorability curve is unavailable',
        ErrorCode.HeroFavorConfNone,
    )
    const levels = new Map()
    for (const row of rows) {
        ensure(
            row && uint(row.favorabilityLevel) && uint(row.favorabilityExp),
            'Malformed hero favorability curve',
            ErrorCode.GameConfig,
        )
        ensure(!levels.has(row.favorabilityLevel), 'Duplicate hero favorability level', ErrorCode.GameConfig)
        levels.set(row.favorabilityLevel, row.favorabilityExp)
    }
    const maximum = Math.max(...levels.keys())
    ensure(
        maximum > 0 && maximum + 1 === rows.length && levels.has(0),
        'Hero favorability curve has missing levels',
        ErrorCode.HeroFavorConfNone,
    )
    let total = 0
    for (let level = 0; level <= maximum; level++) {
        ensure(levels.has(level), 'Hero favorability level is unavailable', ErrorCode.HeroFavorConfNone)
        const required = levels.get(level)
        ensure(
            level === maximum ? required === 0 : required > 0,
            'Invalid hero favorability threshold',
            ErrorCode.GameConfig,
        )
        total += required
        ensure(uint(total), 'Hero favorability curve exceeds wire limits', ErrorCode.GameConfig)
    }
    const info = new Map(),
        ids = new Set(),
        infoRows = tables.get('hero_favorability_info')
    ensure(
        Array.isArray(infoRows) && infoRows.every((row) => row && typeof row === 'object'),
        'Malformed hero favorability reward table',
        ErrorCode.GameConfig,
    )
    for (const row of infoRows.filter((row) => row.heroId === heroId)) {
        ensure(
            positive(row.id) &&
                positive(row.favorabilityLevel) &&
                row.favorabilityLevel <= maximum &&
                typeof row.reward === 'string',
            'Malformed hero favorability reward configuration',
            ErrorCode.GameConfig,
        )
        ensure(
            !info.has(row.favorabilityLevel) && !ids.has(row.id),
            'Duplicate hero favorability reward configuration',
            ErrorCode.GameConfig,
        )
        info.set(row.favorabilityLevel, row)
        ids.add(row.id)
    }
    ensure(info.size === maximum, 'Hero favorability rewards have missing levels', ErrorCode.HeroFavorConfNone)
    return { levels, maximum, info }
}

// The caller selects one recipient explicitly. This helper never selects the
// current hero, a formation, a dungeon roster or a reward-sharing policy.
export function heroFavorabilityPlan(tables, state, heroGuid, amount) {
    ensure(guid(heroGuid) && uint(amount), 'Invalid personal hero favorability reward', ErrorCode.InvalidArgument)
    const owned = state.player?.heros_info?.heros
    ensure(Array.isArray(owned), 'Owned hero data is unavailable', ErrorCode.GameConfig)
    const matches = owned.filter((hero) => hero.guid === heroGuid)
    ensure(matches.length > 0, 'Hero is not owned', ErrorCode.HeroNotExist)
    ensure(matches.length === 1, 'Owned hero identity is duplicated', ErrorCode.GameConfig)
    const actor = matches[0]
    ensure(positive(actor.conf_id), 'Malformed owned hero configuration identity', ErrorCode.GameConfig)
    for (const list of [state.trialGroup?.heroes, state.cultTrial?.heroes])
        ensure(list === undefined || Array.isArray(list), 'Malformed trial hero ownership data', ErrorCode.GameConfig)
    ensure(
        actor.trail === undefined || typeof actor.trail === 'boolean',
        'Malformed hero trial flag',
        ErrorCode.GameConfig,
    )
    ensure(
        !actor.trail && !temporaryHeroes(state).some((hero) => hero?.guid === heroGuid),
        'Temporary hero cannot receive permanent favorability',
        ErrorCode.HeroFavorExpLocked,
    )
    const heroRows = tables.get('hero')
    ensure(
        Array.isArray(heroRows) && heroRows.every((row) => row && typeof row === 'object'),
        'Malformed hero qualification table',
        ErrorCode.GameConfig,
    )
    const heroes = heroRows.filter((row) => row.id === actor.conf_id)
    ensure(heroes.length > 0, 'Hero favorability qualification is unavailable', ErrorCode.HeroFavorConfNone)
    ensure(
        heroes.length === 1 && [0, 1].includes(heroes[0].favor),
        'Malformed hero favorability qualification',
        ErrorCode.GameConfig,
    )
    ensure(heroes[0].favor === 1, 'Hero favorability is not unlocked', ErrorCode.HeroFavorExpLocked)
    const { levels, maximum, info } = configuration(tables, actor.conf_id)
    // Optional HeroItemInfo fields use protobuf zero defaults. Curve
    // structure remains mandatory and is never synthesized.
    const beforeLevel = actor.favorability_lv === undefined ? 0 : actor.favorability_lv,
        beforeExp = actor.favorability_exp === undefined ? 0 : actor.favorability_exp
    ensure(
        uint(beforeLevel) && levels.has(beforeLevel) && uint(beforeExp),
        'Malformed personal hero favorability state',
        ErrorCode.GameConfig,
    )
    ensure(
        beforeLevel === maximum ? beforeExp === 0 : beforeExp < levels.get(beforeLevel),
        'Noncanonical personal hero favorability remainder',
        ErrorCode.GameConfig,
    )
    const pending = actor.store_favor_rewards === undefined ? [] : actor.store_favor_rewards
    ensure(
        Array.isArray(pending) && pending.every(positive) && new Set(pending).size === pending.length,
        'Malformed hero favorability reward receipts',
        ErrorCode.GameConfig,
    )
    for (const id of pending) {
        const row = [...info.values()].find((row) => row.id === id)
        ensure(
            row && row.favorabilityLevel <= beforeLevel && row.reward.length > 0,
            'Hero favorability reward receipt does not match its owner or level',
            ErrorCode.GameConfig,
        )
    }
    let level = beforeLevel,
        exp = beforeExp,
        left = amount,
        applied = 0
    const unlockedRewardIds = []
    while (left > 0 && level < maximum) {
        const delta = Math.min(left, levels.get(level) - exp)
        exp += delta
        left -= delta
        applied += delta
        if (exp === levels.get(level)) {
            level++
            exp = 0
            const reward = info.get(level)
            if (reward.reward.length > 0 && !pending.includes(reward.id)) unlockedRewardIds.push(reward.id)
        }
    }
    // Preserve the existing home-dorm convention: maximum level has no
    // remainder. Expose any capped amount to the caller instead of inventing
    // a global balance or deciding how another recipient should receive it.
    return {
        heroGuid,
        amount,
        applied,
        capped: left,
        beforeLevel,
        beforeExp,
        level,
        exp,
        unlockedRewardIds,
        updates: {
            favorability_lv: level,
            favorability_exp: exp,
            store_favor_rewards: [...pending, ...unlockedRewardIds],
        },
    }
}

export function grantHeroFavorability(tables, state, heroGuid, amount) {
    const plan = heroFavorabilityPlan(tables, state, heroGuid, amount)
    const actor = state.player.heros_info.heros.find((hero) => hero.guid === heroGuid)
    if (plan.applied > 0) Object.assign(actor, plan.updates)
    return plan
}
