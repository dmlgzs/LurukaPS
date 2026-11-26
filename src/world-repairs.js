import { WorldObjectCatalog } from './world-objects.js'
import { createHash } from 'node:crypto'

function unavailableSavedRepair(tables, map, id, record) {
    // This 1.0.0 export retains recipe 10121, but removed world object
    // 2610017. Match the complete current map ID export before treating its
    // absence as legacy content; arbitrary missing current rows still fail.
    if (map !== 100 || id !== 2610017 || record.claims?.repair?.id !== 10121) return false
    const rows = tables.get('worldmap_100')
    return (
        !rows.some((row) => row.id === id) &&
        createHash('sha256')
            .update(JSON.stringify(rows.map((row) => row.id).sort((a, b) => a - b)))
            .digest('hex') === '7a8c24c143a5e4675957e0e290d8412215e06cf1c650400c6663d23b619d2881'
    )
}

export function isCurrentSavedWorldObject(tables, state, key) {
    const [map, id] = key.split(':').map(Number)
    return !unavailableSavedRepair(tables, map, id, state.worldObjects?.[key] ?? {})
}
export function applyRepairVisuals(tables, state, map, objectId, catalog = new WorldObjectCatalog(tables)) {
    const records = (state.worldObjects ??= {}),
        root = records[`${map}:${objectId}`]
    if (!root?.claims?.repair) return []
    const { row, spawner } = catalog.object(map, objectId)
    root.active = true
    root.complete = true
    root.state_data = { ...root.state_data, step: 1, complete: true }
    const fsm = tables.find('world_fsm', row.fsm || spawner.fsm)
    const output = [root]
    for (const token of String(fsm?.intParam ?? '').split('|')) {
        const [name, value] = token.split('#'),
            id = Number(value)
        if (!/^(repair_obj|damage_obj|repair_point)_\d+$/.test(name) || !Number.isSafeInteger(id) || id <= 0) continue
        catalog.object(map, id)
        const key = `${map}:${id}`,
            old = records[key]
        const record = {
            ...old,
            obj_id: id,
            active: name.startsWith('repair_obj_'),
            complete: false,
            state_data: { ...old?.state_data, step: 0, complete: false },
        }
        records[key] = record
        output.push(record)
    }
    return output.map(({ claims, ...obj }) => obj)
}
export function repairSavedWorldRepairs(tables, state) {
    const catalog = new WorldObjectCatalog(tables)
    for (const [key, record] of Object.entries(state.worldObjects ?? {})) {
        if (!record.claims?.repair) continue
        const [map, id] = key.split(':').map(Number),
            config = tables.find('common_world_repair', record.claims.repair.id)
        if (config?.cityId !== map || config.worldmapId !== id) continue
        if (unavailableSavedRepair(tables, map, id, record)) {
            state.compatibilityDiagnostics ??= {}
            state.compatibilityDiagnostics.worldRepairs ??= {}
            state.compatibilityDiagnostics.worldRepairs[key] = {
                version: '1.0.0',
                reason: 'unavailableCurrentObject',
                repairId: config.id,
            }
            continue
        }
        applyRepairVisuals(tables, state, map, id, catalog)
    }
}
