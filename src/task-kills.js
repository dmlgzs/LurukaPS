import { TaskGraphs, asList, nodeConditions } from './tasks.js'
import { recordActiveProgress } from './daily-active.js'
import { guidedKillRule } from './guided-conditions.js'
import { deliveryKey } from './task-delivery.js'
import { WorldObjectCatalog } from './world-objects.js'
import { taskEnemyGroups } from './task-enemy-groups.js'
const catalogs = new WeakMap()
function catalog(tables) {
    let value = catalogs.get(tables)
    if (!value)
        catalogs.set(tables, (value = { graphs: new TaskGraphs(tables), world: new WorldObjectCatalog(tables) }))
    return value
}
function matches(tables, state, entity, rule, world) {
    if (entity.captured || entity.hp !== 0 || entity.alive_state !== 1) return false
    const pack = tables.find('enemy_pack', entity.pack_id),
        enemy = tables.find('enemy', entity.config_id)
    if (!enemy || pack?.specialCreateType === 1 || pack?.ECampType === 2) return false
    const sceneType = tables.find('world_city', state.world.map_id)?.type
    if ([1, 2].includes(rule.sceneType) && rule.sceneType !== sceneType) return false
    if (rule.monsterId && rule.monsterId !== enemy.id) return false
    if (rule.monsterType && rule.monsterType !== enemy.enemyType) return false
    if (rule.groupId) {
        const runtime = state.worldObjects?.[state.world.map_id + ':' + entity.object_id]
        let groupId = runtime?.expand_data?.battle_group?.monsters?.find((m) => m.uid === entity.uuid)?.obj_key
            ?.group_id
        if (!groupId) groupId = taskEnemyGroups(tables, state).find((g) => g.objectId === entity.object_id)?.groupId
        if (!groupId) {
            try {
                groupId = world.find('worldmap_' + state.world.map_id, entity.object_id)?.expandId
            } catch (e) {
                if (e.code !== 'ENOENT') throw e
            }
        }
        if (groupId !== rule.groupId) return false
    }
    return true
}
function eachKillGoal(tables, state, fn) {
    const { graphs, world } = catalog(tables)
    for (const task of state.tasks ?? []) {
        const graph = graphs.get(task.task_id)
        for (const node of task.nodes ?? []) {
            if (!node.client_before) continue
            const config = graph.nodes.get(node.node_id)
            nodeConditions(config).forEach((q, index) => {
                if (q.conditionId !== 2518) return
                const base = q.__type_TaskConditionBaseData,
                    rule = guidedKillRule(base?.__type_TaskCondGuidedAchievementsData?.achievId)
                if (!rule || (base.mapData?.sceneId && base.mapData.sceneId !== state.world.map_id)) return
                fn({
                    task,
                    node,
                    config,
                    graph,
                    base,
                    rule,
                    index,
                    world,
                    key: deliveryKey(state, task.task_id, node.node_id, index),
                })
            })
        }
    }
}
// Called once on the authoritative alive->dead transition, never on repeated
// reports against an already dead enemy. Counts are scoped to the active node.
export function recordGuidedKill(tables, state, entity, now) {
    let activityChanged = false
    if (now !== undefined) {
        activityChanged = recordActiveProgress(tables, state, 12002, 1, now)
        if ([1, 2].includes(tables.find('enemy', entity.config_id)?.enemyType))
            activityChanged = recordActiveProgress(tables, state, 15014, 1, now) || activityChanged
    }
    eachKillGoal(tables, state, ({ rule, key, world }) => {
        if (!matches(tables, state, entity, rule, world)) return
        const events = (state.taskEvents ??= {})
        events[key] = Math.min(rule.count, (events[key] ?? 0) + 1)
    })
    return activityChanged
}
// Old servers saved death but lacked this condition. Recover only the first
// condition of an active dungeon task, with its actual target and run-time
// proof; deaths before a later node cannot be retroactively counted.
export function recoverInitialDungeonKills(tables, state) {
    const run = state.storyCampaign
    if (run?.status !== 2 || run.map_id !== state.world.map_id || state.combat?.map_id !== run.map_id) return
    eachKillGoal(tables, state, ({ task, config, graph, base, rule, key, world }) => {
        if (
            !run.task_ids?.includes(task.task_id) ||
            !base.mapData?.targetId ||
            !asList(config.prevNodeIdList).length ||
            !asList(config.prevNodeIdList).every((id) => graph.nodes.get(id)?.nodeType === 10)
        )
            return
        const count = Object.values(state.combat.entities ?? {}).filter(
            (entity) =>
                entity.object_id === base.mapData.targetId &&
                entity.updated_at >= run.start_time &&
                matches(tables, state, entity, rule, world),
        ).length
        if (!count) return
        const events = (state.taskEvents ??= {})
        events[key] = Math.min(rule.count, Math.max(events[key] ?? 0, count))
    })
}
