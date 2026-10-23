import { abyssTables } from './abyss-catalog.js'
import { arenaElementMetadata } from './npc-kibo-elements.js'
import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'

export function abyssBuffPlan(external, run) {
    const tables = abyssTables(external),
        level = tables.find('abbys_level', run.level_id),
        ids = [level?.buffId ?? 0, run.challenges[run.part_index]?.buff_id ?? 0].filter(Boolean),
        monster = new Set(),
        hero = new Set()
    ensure(level, 'Abyss level buff configuration is missing', ErrorCode.AbyssInvalidLevel)
    for (const id of ids) {
        const row = tables.find('abbys_buff', id)
        ensure(
            row && [row.buffid, row.monsterbuffid].every((n) => Number.isSafeInteger(n) && n >= 0),
            'Abyss buff binding is malformed',
            ErrorCode.GameConfig,
        )
        for (const value of [row.buffid, row.monsterbuffid].filter(Boolean))
            ensure(
                arenaElementMetadata(value).status === 'resolved',
                'Abyss buff element resource is unavailable',
                ErrorCode.GameConfig,
            )
        if (row.monsterbuffid) monster.add(row.monsterbuffid)
        // These are runtime element configurations, not learned skill IDs or
        // static attribute bonuses. AliveElementSystem executes map hero elements.
        if (row.buffid) hero.add(row.buffid)
    }
    return { monster: [...monster].sort((a, b) => a - b), hero: [...hero].sort((a, b) => a - b) }
}
export function abyssHeroMapElements(external, run) {
    const plan = abyssBuffPlan(external, run)
    const previous = run.map_hero_element_ids ?? []
    ensure(
        Array.isArray(previous) && previous.every((id) => Number.isSafeInteger(id) && id > 0),
        'Saved abyss map hero elements are malformed',
        ErrorCode.GameConfig,
    )
    // Empty repeated fields become null in the current nullable-array client.
    // Explicit del/add also preserves unrelated map element producers.
    return {
        hero_ele: {
            del: [...new Set([...previous, ...plan.hero])].sort((a, b) => a - b),
            add: plan.hero,
        },
    }
}
export function publishAbyssHeroMapElements(c, clear = false) {
    const run = c.state.abyssRun
    if (!run) return
    // Exit must remain possible if static tables are removed or changed while
    // the run is open. The durable list records exactly what we published.
    const elements = clear
        ? {
              hero_ele: {
                  del: (Array.isArray(run.map_hero_element_ids) ? run.map_hero_element_ids : []).filter(
                      (id) => Number.isSafeInteger(id) && id > 0,
                  ),
              },
          }
        : abyssHeroMapElements(c.tables, run)
    c.push('CSProtoWorldMapSync', {
        cmd: 47,
        map_id: c.state.world.map_id,
        map_info: { map_id: c.state.world.map_id, map_ele: elements },
    })
    run.map_hero_element_ids = clear ? [] : elements.hero_ele.add.slice()
}
export function publishAbyssMonsterBuffs(c) {
    const plan = abyssBuffPlan(c.tables, c.state.abyssRun)
    c.pushBefore('SCProtoAbyssDungeonMonsterBuffSync', { buff_ids: plan.monster })
    return plan
}
