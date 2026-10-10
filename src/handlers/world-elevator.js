import fs from 'node:fs'
import { ensure } from './common.js'
import { WorldObjectCatalog } from '../world-objects.js'
const configured = JSON.parse(
    fs.readFileSync(new URL('../../configs/world-elevator-rules.json', import.meta.url), 'utf8'),
)
const blueprints = new Map(configured.blueprints.map((rule) => [rule.path, rule.target_steps]))
const catalogs = new WeakMap()
function objectCatalog(tables) {
    let catalog = catalogs.get(tables)
    if (!catalog) catalogs.set(tables, (catalog = new WorldObjectCatalog(tables)))
    return catalog
}
export function registerWorldElevator(on, tables) {
    const catalog = objectCatalog(tables)
    on('WorldMapTakeElevator', (c, r) => {
        const map = c.state.world.map_id
        const { row, spawner } = catalog.object(map, r.obj_id)
        const blueprint = tables.find('world_blueprint', row.blueprint || spawner.blueprint)
        const steps = blueprints.get(blueprint?.path)
        ensure(steps, 'World elevator or puzzle configuration unavailable', 1007)
        ensure(Number.isInteger(r.floor) && steps.includes(r.floor), 'Elevator target is not configured')
        const records = (c.state.worldObjects ??= {}),
            key = map + ':' + r.obj_id,
            old = records[key]
        const changed = old?.state_data?.step !== r.floor || old?.active === undefined
        const record = old ?? {
            obj_id: r.obj_id,
            active: true,
            complete: !!row.initialCompleteState,
            time: c.now,
            next_time: 0,
        }
        if (changed) {
            // A sparse 9103 object defaults active to false in CBT3 ServerMap.
            // Preserve explicitly configured visibility, repair only missing data.
            record.active ??= true
            record.state_data = { ...record.state_data, step: r.floor }
            records[key] = record
        }
        const { claims, ...obj } = record
        if (changed)
            c.pushBefore('CSProtoWorldMapSync', {
                cmd: 2,
                creator_id: c.id,
                player_id: c.id,
                notify_id: c.id,
                map_id: map,
                map_info: { creator_id: c.id, map_id: map, exist: true, area_id: c.state.world.area_id, objs: [obj] },
            })
        // Blueprint SendCallback reads this exact step, then calls its Out port.
        // Do not conflate the mechanism state with chest collection/completion.
        return { obj }
    })
}

export function repairSavedElevatorVisibility(tables, state) {
    const catalog = objectCatalog(tables)
    for (const [key, record] of Object.entries(state.worldObjects ?? {})) {
        if (record.active !== undefined || record.complete || record.claims?.complete) continue
        const [map, id] = key.split(':').map(Number)
        try {
            const { row, spawner } = catalog.object(map, id)
            const blueprint = tables.find('world_blueprint', row.blueprint || spawner.blueprint)
            if (blueprints.get(blueprint?.path)?.includes(record.state_data?.step)) record.active = true
        } catch {
            // Other dynamic/task object records are outside this repair scope.
        }
    }
}
