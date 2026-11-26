import { ensure } from './handlers/common.js'
import { WorldObjectCatalog } from './world-objects.js'
import { TaskGraphs, asList } from './tasks.js'
import { taskOverrideNodeIds } from './task-action-data.js'
const catalogs = new WeakMap()
function definedIn(value, id, map, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 12) return false
    if (value.createNpcId === id && value.sceneId === map) return true
    return Object.values(value).some((child) => definedIn(child, id, map, depth + 1))
}
export function recordWorldDiscovery(tables, state, ids) {
    ensure(Array.isArray(ids) && ids.length > 0 && ids.length <= 256, 'Invalid discovery object batch')
    ensure(
        ids.every((id) => Number.isSafeInteger(id) && id > 0 && id <= 0xffffffff),
        'Invalid discovery object id',
    )
    let catalog = catalogs.get(tables)
    if (!catalog)
        catalogs.set(tables, (catalog = { world: new WorldObjectCatalog(tables), graphs: new TaskGraphs(tables) }))
    const map = state.world.map_id,
        unique = [...new Set(ids)]
    for (const id of unique) {
        let known = catalog.world.find('worldmap_' + map, id)
        if (!known)
            known = (state.tasks ?? []).some((task) => {
                const graph = catalog.graphs.get(task.task_id),
                    nodes = new Set(task.nodes.map((n) => n.node_id))
                return (
                    task.nodes.some((node) => definedIn(graph.nodes.get(node.node_id), id, map)) ||
                    asList(graph.npcs).some(
                        (data) =>
                            taskOverrideNodeIds(data, 'field_520407').some((node) => nodes.has(node)) &&
                            definedIn(data, id, map),
                    ) ||
                    graph.controllers.some(
                        (data) => taskOverrideNodeIds(data).some((node) => nodes.has(node)) && definedIn(data, id, map),
                    )
                )
            })
        ensure(known, 'Discovery object is not in current map')
    }
    const discoveries = (state.worldDiscoveredObjects ??= []),
        keys = new Set(discoveries.map((obj) => obj.map_id + ':' + obj.obj_id))
    let changed = false
    for (const id of unique) {
        const key = map + ':' + id
        if (!keys.has(key)) {
            discoveries.push({ map_id: map, obj_id: id })
            keys.add(key)
            changed = true
        }
    }
    return { ids: unique, changed }
}
