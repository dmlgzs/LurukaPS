import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { parseRewards } from './rewards.js'

const indices = new WeakMap()
function levelsFor(tables, skill) {
    if (!indices.has(tables)) {
        const index = new Map()
        for (const row of tables.get('skill_level')) {
            if (!index.has(row.skillId)) index.set(row.skillId, new Map())
            const levels = index.get(row.skillId)
            // The shipped table contains duplicate non-hero skill keys.
            // Mark ambiguity locally; it must not disable unrelated valid skills.
            levels.set(row.level, levels.has(row.level) ? null : row)
        }
        indices.set(tables, index)
    }
    return indices.get(tables).get(skill)
}
export function heroSkillUpgrade(tables, hero, slot) {
    const config = tables.find('hero', hero.conf_id)
    ensure(config, 'Hero skill owner configuration unavailable', ErrorCode.GameConfig)
    const system = String(config.skillSystem || '')
        .split('|')
        .filter(Boolean)
        .map(Number)
    ensure(
        system.every((id) => Number.isInteger(id) && id >= 0),
        'Invalid hero system skill configuration',
        ErrorCode.GameConfig,
    )
    ensure(
        Number.isInteger(hero.hero_lv) && hero.hero_lv >= 1 && Number.isInteger(hero.hero_rank) && hero.hero_rank >= 0,
        'Invalid saved hero skill owner progression',
        ErrorCode.GameConfig,
    )
    ensure(
        Number.isInteger(slot) && slot >= 0 && slot < system.length && system[slot] > 0,
        'Hero skill slot cannot be upgraded',
        ErrorCode.HeroSkillUpCheckFailed,
    )
    const saved = hero.system_skill_levels ?? []
    ensure(
        Array.isArray(saved) &&
            saved.length <= system.length &&
            saved.every((level) => Number.isInteger(level) && level >= 1),
        'Invalid saved hero skill levels',
        ErrorCode.GameConfig,
    )
    const level = saved[slot] ?? 1,
        rows = levelsFor(tables, system[slot]),
        current = rows?.get(level)
    ensure(current, 'Hero skill level configuration unavailable', ErrorCode.GameConfig)
    ensure([0, 1].includes(current.canUp), 'Invalid hero skill upgrade flag', ErrorCode.GameConfig)
    ensure(current.canUp === 1, 'Hero skill has reached its upgrade limit', ErrorCode.HeroSkillUpCheckFailed)
    const next = rows.get(level + 1)
    ensure(next, 'Next hero skill level configuration unavailable', ErrorCode.GameConfig)
    for (const row of [current, next])
        ensure(
            Number.isInteger(row.heroLevel) &&
                row.heroLevel >= 0 &&
                Number.isInteger(row.heroRank) &&
                row.heroRank >= 0,
            'Invalid hero skill unlock requirements',
            ErrorCode.GameConfig,
        )
    ensure(
        hero.hero_lv >= Math.max(current.heroLevel, next.heroLevel) &&
            hero.hero_rank >= Math.max(current.heroRank, next.heroRank),
        'Hero skill upgrade requirements not met',
        ErrorCode.HeroSkillUpCheckFailed,
    )
    ensure(
        Number.isSafeInteger(current.gold) && current.gold >= 0,
        'Invalid hero skill gold cost',
        ErrorCode.GameConfig,
    )
    const costs = parseRewards(current.item)
    ensure(
        costs.every((row) => [3, 10].includes(row.itemtype)),
        'Unsupported hero skill cost category',
        ErrorCode.InvalidLogic,
    )
    return {
        slot,
        skill: system[slot],
        nextLevel: level + 1,
        levels: Array.from({ length: system.length }, (_, index) => saved[index] ?? 1),
        costs,
        gold: current.gold,
    }
}
