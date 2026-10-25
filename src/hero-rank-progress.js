import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'

const uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
const catalogues = new WeakMap()
function catalogue(tables) {
    if (!catalogues.has(tables)) {
        const ranks = new Set(),
            byHero = new Map()
        for (const row of tables.get('talent_rank')) {
            ranks.add(row.rank)
            if (!byHero.has(row.heroId)) byHero.set(row.heroId, new Set())
            byHero.get(row.heroId).add(row.rank)
        }
        catalogues.set(tables, { ranks, byHero })
    }
    return catalogues.get(tables)
}
function identity(guid) {
    ensure(
        (typeof guid === 'string' && /^\d{1,20}$/.test(guid)) ||
            (typeof guid === 'number' && Number.isSafeInteger(guid) && guid > 0),
        'Invalid permanent hero identity',
        ErrorCode.GameConfig,
    )
    const value = BigInt(guid)
    ensure(value > 0n && value <= 0xffffffffffffffffn, 'Permanent hero identity outside uint64', ErrorCode.GameConfig)
    // Legacy small IDs remain valid. Decimal aliases must share one identity;
    // never trust an unsafe JS Number or require a new UUID namespace here.
    return value.toString()
}

// HeroTalentRankNum is a current permanent-character property condition, not
// the number of rank-up requests. Repeated upgrades of one character count once.
export function heroRankProgressRule(tables, tokens) {
    if (!Array.isArray(tokens)) return false
    const [kind, rank, count] = tokens
    return (
        kind === 12055 &&
        tokens.length === 3 &&
        uint(rank) &&
        rank > 0 &&
        uint(count) &&
        count > 0 &&
        catalogue(tables).ranks.has(rank)
    )
}

export function heroRankProgressValue(tables, state, tokens, facts = new Map()) {
    if (!heroRankProgressRule(tables, tokens)) return null
    const [, rank] = tokens,
        key = `hero-rank:${rank}`
    if (facts.has(key)) return facts.get(key)
    const heroes = state.player?.heros_info?.heros
    ensure(Array.isArray(heroes), 'Invalid permanent hero roster', ErrorCode.GameConfig)
    const guids = new Set(),
        configs = new Set(),
        data = catalogue(tables)
    let count = 0
    for (const hero of heroes) {
        ensure(
            hero && typeof hero === 'object' && !Array.isArray(hero),
            'Malformed permanent hero record',
            ErrorCode.GameConfig,
        )
        if (hero.trail) continue
        const id = identity(hero.guid)
        ensure(
            !guids.has(id) && !configs.has(hero.conf_id),
            'Duplicate or invalid permanent hero identity',
            ErrorCode.GameConfig,
        )
        guids.add(id)
        configs.add(hero.conf_id)
        ensure(
            uint(hero.hero_rank) && hero.hero_rank > 0 && data.byHero.get(hero.conf_id)?.has(hero.hero_rank),
            'Invalid permanent hero rank progression',
            ErrorCode.GameConfig,
        )
        if (hero.hero_rank >= rank) count++
    }
    ensure(uint(count), 'Hero rank progress overflow', ErrorCode.GameConfig)
    facts.set(key, count)
    return count
}
