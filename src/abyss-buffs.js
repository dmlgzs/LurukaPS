import { abyssTables } from './abyss-catalog.js'
import { arenaElementMetadata } from './npc-kibo-elements.js'
import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'

export function abyssBuffPlan(external, run) {
    const tables = abyssTables(external),
        level = tables.find('abbys_level', run.level_id),
        ids = [level?.buffId ?? 0, run.challenges[run.part_index]?.buff_id ?? 0].filter(Boolean),
        monster = new Set(),
        heroPending = new Set()
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
        // The hero consumer and complete dynamic effect path are still under
        // analysis. Never relabel these configured elements as learned skills.
        if (row.buffid) heroPending.add(row.buffid)
    }
    return { monster: [...monster].sort((a, b) => a - b), heroPending: [...heroPending].sort((a, b) => a - b) }
}
export function publishAbyssMonsterBuffs(c) {
    const plan = abyssBuffPlan(c.tables, c.state.abyssRun)
    c.pushBefore('SCProtoAbyssDungeonMonsterBuffSync', { buff_ids: plan.monster })
    return plan
}
