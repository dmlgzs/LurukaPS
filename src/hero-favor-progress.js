import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { permanentHeroFavorRecords } from './hero-favor-ownership.js'
import policy from '../configs/hero-favor-progress-policy.json' with { type: 'json' }
const uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
const catalogues = new WeakMap()
function levels(tables) {
    ensure(
        policy.version === 1 &&
            policy.condition === 13007 &&
            policy.measurement === 'current-permanent-qualified-hero-level' &&
            policy.levelParameter === 1 &&
            policy.countParameter === 2 &&
            policy.officiallyVerified === false,
        'Invalid hero favorability progress policy',
        ErrorCode.GameConfig,
    )
    if (!catalogues.has(tables)) {
        const result = new Set()
        for (const row of tables.get('hero_favorability_exp')) {
            ensure(
                row && uint(row.favorabilityLevel) && !result.has(row.favorabilityLevel),
                'Invalid hero favorability level catalogue',
                ErrorCode.GameConfig,
            )
            result.add(row.favorabilityLevel)
        }
        ensure(
            result.has(0) && result.size > 1 && Math.max(...result) + 1 === result.size,
            'Hero favorability level catalogue is incomplete',
            ErrorCode.HeroFavorConfNone,
        )
        catalogues.set(tables, result)
    }
    return catalogues.get(tables)
}
export function heroFavorProgressRule(tables, tokens) {
    return (
        Array.isArray(tokens) &&
        tokens.length === 3 &&
        tokens[0] === 13007 &&
        uint(tokens[1]) &&
        tokens[1] > 0 &&
        uint(tokens[2]) &&
        tokens[2] > 0 &&
        levels(tables).has(tokens[1])
    )
}
export function heroFavorProgressValue(tables, state, tokens, facts = new Map()) {
    if (!heroFavorProgressRule(tables, tokens)) return null
    const key = `hero-favor:${tokens[1]}`
    if (facts.has(key)) return facts.get(key)
    let count = 0
    for (const { actor, config } of permanentHeroFavorRecords(tables, state)) {
        if (config.favor !== 1) continue
        const level = actor.favorability_lv === undefined ? 0 : actor.favorability_lv
        ensure(
            uint(level) && levels(tables).has(level),
            'Invalid personal hero favorability level',
            ErrorCode.GameConfig,
        )
        if (level >= tokens[1]) count++
    }
    facts.set(key, count)
    return count
}
