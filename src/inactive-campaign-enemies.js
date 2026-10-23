import { WorldObjectCatalog } from './world-objects.js'
import { TaskGraphs, asList, nodeConditions } from './tasks.js'
import { abyssTables } from './abyss-catalog.js'
const catalogs = new WeakMap()
export function inactiveCampaignEnemyGroup(tables, state, uuid) {
    const id = BigInt(uuid),
        run = state.storyCampaign
    if (Number(id >> 56n) === 3 && state.abyssRun?.map_id === state.world.map_id) {
        const objectId = Number(id & 0xffffffffn),
            record = state.worldObjects?.[state.world.map_id + ':' + objectId]
        if (record?.active !== false) return null
        const scoped = abyssTables(tables),
            row = scoped.find('worldmap_' + state.world.map_id, objectId)
        if (!row || scoped.find('world_spawner', row.spawnerId)?.objectType !== 50) return null
        const count = String(scoped.find('world_enemy_group', row.expandId)?.enemyList ?? '')
            .split('|')
            .filter(Boolean).length
        if (!count || count > 256) return null
        const root = (id & ~(0xffffffn << 32n)).toString()
        return {
            root,
            members: Array.from({ length: count }, (_, slot) => (BigInt(root) | (BigInt(slot) << 32n)).toString()),
        }
    }
    if (Number(id >> 56n) !== 3 || !run?.task_ids?.length || run.map_id !== state.world.map_id) return null
    const objectId = Number(id & 0xffffffffn),
        record = state.worldObjects?.[state.world.map_id + ':' + objectId]
    if (record?.active !== false) return null
    let c = catalogs.get(tables)
    if (!c) catalogs.set(tables, (c = { world: new WorldObjectCatalog(tables), graphs: new TaskGraphs(tables) }))
    const row = c.world.find('worldmap_' + state.world.map_id, objectId)
    if (!row || c.world.find('world_spawner', row.spawnerId)?.objectType !== 50) return null
    // Client task controllers can explicitly reuse a static world enemy group.
    // Such groups are not classified as dormant solely from their default record.
    for (const task of state.tasks ?? [])
        for (const node of task.nodes ?? []) {
            const graph = c.graphs.get(task.task_id)
            if (
                nodeConditions(graph.nodes.get(node.node_id)).some((q) => {
                    const b = q.__type_TaskConditionBaseData,
                        d = b?.__type_TaskCondEnemiesGroupData
                    return (
                        b?.__type_TaskCondBattleTriggerData?.npcId === objectId ||
                        (d?.useExistEnemy && d.createNpcId === objectId)
                    )
                })
            )
                return null
            for (const controller of graph.controllers)
                if (asList(controller.field_530003).includes(node.node_id))
                    if (
                        asList(controller.__type_TaskCreateBattleUnitDataController?.enemiesDatas).some(
                            (d) => d.npcId === objectId || d.createNpcId === objectId,
                        )
                    )
                        return null
        }
    const count = String(tables.find('world_enemy_group', row.expandId)?.enemyList ?? '')
        .split('|')
        .filter(Boolean).length
    if (!count || count > 256) return null
    const root = (id & ~(0xffffffn << 32n)).toString()
    return {
        root,
        members: Array.from({ length: count }, (_, slot) => (BigInt(root) | (BigInt(slot) << 32n)).toString()),
    }
}
