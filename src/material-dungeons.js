import { materialClearCatalogue, materialClearFacts, materialClearRevision } from './material-clear-progress.js'
import { recordBattlePassMaterialClear } from './battle-pass-tasks.js'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

export function materialDungeonSnapshot(state) {
    return { infos: Object.values(state.materialDungeonRecords ?? {}) }
}

export function materialDungeonUnlocked(rule, state) {
    return String(rule || '')
        .split('|')
        .filter(Boolean)
        .every((token) => {
            const parts = token.split('#').map(Number),
                [kind, id, target] = parts
            ensure(
                parts.every(Number.isSafeInteger) && id > 0,
                'Invalid material unlock configuration',
                ErrorCode.GameConfig,
            )
            if (kind === 2004) {
                ensure(parts.length === 2, 'Invalid material level condition', ErrorCode.GameConfig)
                return state.player.basic_info.lv >= id
            }
            ensure(kind === 13112, 'Material unlock condition is not implemented', ErrorCode.FunctionClosed)
            ensure(parts.length === 3 && target > 0, 'Invalid material clear condition', ErrorCode.GameConfig)
            const record = state.materialDungeonRecords?.[id]
            if (!record?.success_count) return false
            ensure(
                Number.isInteger(record.material_star) &&
                    record.material_star >= 0 &&
                    record.material_star <= 0xffffffff,
                'Invalid saved material star mask',
                ErrorCode.GameConfig,
            )
            if (target === 1) return true // Current MaterialStarFinishCond accepts an existing zero-star clear.
            let mask = record.material_star ?? 0,
                count = 0
            while (mask) {
                count += mask & 1
                mask >>>= 1
            }
            return count >= target
        })
}

export function recordMaterialVictory(tables, state, run, mask, now, freshMaterialVictory = false) {
    materialClearFacts(tables, state)
    const material = tables.find('dungeon_material', run.entrust_id)
    ensure(
        material?.dungeonId === run.dungeon_id,
        'Material dungeon configuration unavailable',
        ErrorCode.DungeonConfNotExist,
    )
    // A battle request can use a narrow deferred draft. Copy this small record
    // map only on a clear, never mutate a shared map on the per-hit path.
    const records = (state.materialDungeonRecords = { ...state.materialDungeonRecords }),
        old = records[material.id]
    const count = (old?.success_count ?? 0) + 1
    ensure(Number.isSafeInteger(count) && count <= 0xffffffff, 'Material clear count overflow', ErrorCode.GameConfig)
    records[material.id] = {
        material_id: material.id,
        material_star: (old?.material_star ?? 0) | mask,
        success_time: String(run.end_time),
        difficulty_id: material.diff,
        success_count: count,
    }
    const revision = materialClearRevision(state) + 1
    ensure(revision <= 0xffffffff, 'Material clear revision overflow', ErrorCode.GameConfig)
    state.materialClearRevision = revision
    // Recovery can preserve lifetime records, but only a fresh actual clear
    // belongs to the current task period. Missing legacy receipts do not count.
    if (freshMaterialVictory && now === run.end_time) {
        const tuple = materialClearCatalogue(tables).rows.get(material.id)
        recordBattlePassMaterialClear(tables, state, tuple, now)
    }
}
