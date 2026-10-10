import { finishEnemyGroupRelations } from './handlers/world-combat.js'
import fs from 'node:fs'
import { ensure } from './handlers/common.js'
import { TaskGraphs, nodeConditions, asList } from './tasks.js'
import { WorldObjectCatalog } from './world-objects.js'
import { enemyDefinition } from './enemy-state.js'
import { u64, combatState } from './combat-state.js'
import { createHash } from 'node:crypto'
import { guidedKillRule } from './guided-conditions.js'
import { recordGuidedKill } from './task-kills.js'
function activeStoryGroup(tables, state, def, world, graphs) {
    for (const task of state.tasks)
        for (const node of task.nodes) {
            if (!node.client_before) continue
            const graph = graphs.get(task.task_id)
            for (const q of nodeConditions(graph.nodes.get(node.node_id))) {
                const b = q.__type_TaskConditionBaseData,
                    battle = b?.__type_TaskCondBattleTriggerData
                if (
                    q.conditionId === 2500 &&
                    b.mapData?.sceneId === state.world.map_id &&
                    battle?.npcId === def.object_id &&
                    battle.checkNameType === 5
                ) {
                    const row = world.find('worldmap_' + state.world.map_id, def.object_id)
                    return { task, group: row && tables.find('world_enemy_group', row.expandId) }
                }
                if (
                    q.conditionId === 2518 &&
                    b?.mapData?.sceneId === state.world.map_id &&
                    b.mapData.targetId === def.object_id
                ) {
                    const rule = guidedKillRule(b.__type_TaskCondGuidedAchievementsData?.achievId)
                    const row = world.find('worldmap_' + state.world.map_id, def.object_id)
                    const group = row && tables.find('world_enemy_group', row.expandId)
                    const enemy = tables.find('enemy', def.config_id)
                    if (
                        rule &&
                        group &&
                        (!rule.monsterId || rule.monsterId === def.config_id) &&
                        (!rule.groupId || rule.groupId === group.id) &&
                        (!rule.monsterType || rule.monsterType === enemy?.enemyType) &&
                        (![1, 2].includes(rule.sceneType) ||
                            tables.find('world_city', state.world.map_id)?.type === rule.sceneType)
                    )
                        return { task, group }
                }
                const enemies = b?.__type_TaskCondEnemiesGroupData
                if (![2519, 2520].includes(q.conditionId) || !enemies) continue
                const groups = [...asList(enemies.enemiesDatas)]
                if (enemies.useExistEnemy && enemies.createNpcId === def.object_id)
                    groups.push(
                        ...graph.controllers
                            .filter((c) => asList(c.field_530003).includes(node.node_id))
                            .flatMap((c) => asList(c.__type_TaskCreateBattleUnitDataController?.enemiesDatas)),
                    )
                const data = groups.find((g) => g?.sceneId === state.world.map_id && g.createNpcId === def.object_id)
                if (data)
                    return {
                        task,
                        group: tables.find('world_enemy_group', data.__type_TaskEnemiesOverrideData?.enemiesGroupId),
                    }
            }
        }
    return null
}
const profiles = JSON.parse(
    fs.readFileSync(new URL('../configs/battle-config/story-kill-rules.json', import.meta.url)),
).profiles
export function registerStoryBattle(on, tables) {
    const world = new WorldObjectCatalog(tables),
        graphs = new TaskGraphs(tables)
    on('StoryKill', (c, r) => {
        const ids = [...new Set((r.guid ?? []).map(u64))]
        ensure(ids.length > 0 && ids.length <= 64, 'Invalid story-kill targets')
        const battle = combatState(c.state, c.now),
            infos = []
        for (const uuid of ids) {
            const key = `${c.state.world.map_id}:${uuid}`,
                existing = battle.entities[uuid]
            if (c.state.storyKillReceipts?.[key] && existing?.hp === 0) continue
            const def = enemyDefinition(tables, c.state, uuid)
            ensure(def, 'Unknown story-kill target')
            const target = activeStoryGroup(tables, c.state, def, world, graphs),
                group = target?.group
            const profile = profiles.find((p) => p.battleFsmType === group?.battleFsmType)
            ensure(group?.canForceKill === 1 && profile, 'Enemy group has no configured story kill')
            const rules = profile.rules.filter((rule) => !rule.validation || rule.validation === 'story')
            ensure(rules.length > 0, 'Story-kill client-condition validation is not implemented', 1007)
            const matchedRule = rules.find(
                (rule) => rule.stories.length && rule.stories.every((id) => c.state.storyIds?.includes(id)),
            )
            ensure(matchedRule, 'Required battle story has not played')
            ensure(target, 'Story-kill objective is not active')
            battle.entities[uuid] = { ...existing, ...def, uuid, hp: 0, alive_state: 1, updated_at: c.now }
            if ((existing?.hp ?? def.max_hp) > 0) recordGuidedKill(tables, c.state, battle.entities[uuid])
            c.state.storyKillReceipts ??= {}
            c.state.storyKillReceipts[key] = { story_ids: matchedRule.stories, time: c.now }
            infos.push({ uuid, hp: 0, sp: 0, alive_state: 1, reason: 0 })
        }
        if (infos.length) c.push('CSProtoObjBattleInfoSync', { infos })
        // Scripted kills must finish the same group relation as damage kills.
        // Only a fully defeated configured group emits the reset; retries can
        // also repair a prior death whose relation cleanup was omitted.
        for (const uuid of ids) finishEnemyGroupRelations(c, uuid)
        return {}
    })
}
export function recoverFailedStoryKills(c, protocol, filename, handler) {
    let records
    try {
        if (!filename || !fs.existsSync(filename) || fs.statSync(filename).size > 8 * 1024 * 1024) return 0
        records = fs
            .readFileSync(filename, 'utf8')
            .split(/\r?\n/)
            .flatMap((line) => {
                try {
                    return [JSON.parse(line)]
                } catch {
                    return []
                }
            })
    } catch {
        return 0
    }
    const graphs = new TaskGraphs(c.tables),
        world = new WorldObjectCatalog(c.tables)
    let count = 0
    for (const record of records) {
        if (
            record.phase !== 'dispatch' ||
            record.account_id !== c.id ||
            record.message_id !== 10799 ||
            record.error_code !== 1024 ||
            record.error !== 'Enemy group has no configured story kill' ||
            !Array.isArray(record.request?.guid)
        )
            continue
        const request = { guid: record.request.guid },
            time = Date.parse(record.time)
        try {
            if (!request.guid.length || request.guid.length > 64 || !Number.isFinite(time) || time > c.now * 1000)
                continue
            const hash = createHash('sha256')
                .update(protocol.encode(protocol.byId.get(10799).req, request))
                .digest('hex')
            if (hash !== record.payload_sha256) continue
            const targets = request.guid.map((id) => {
                const def = enemyDefinition(c.tables, c.state, u64(id))
                return def && activeStoryGroup(c.tables, c.state, def, world, graphs)
            })
            if (targets.some((target) => !target || time < (target.task.start_time ?? Infinity) * 1000)) continue
            if (request.guid.every((id) => c.state.storyKillReceipts?.[`${c.state.world.map_id}:${id}`])) continue
            // Reuse normal story/canForceKill/active-target checks; only restore
            // the exact request already rejected in this account's current run.
            const draft = {
                ...c.state,
                combat: c.state.combat
                    ? {
                          ...c.state.combat,
                          entities: { ...c.state.combat.entities },
                      }
                    : undefined,
                storyKillReceipts: { ...c.state.storyKillReceipts },
                taskEvents: { ...c.state.taskEvents },
            }
            handler({ ...c, state: draft, push: () => {} }, request)
            c.state.combat = draft.combat
            c.state.storyKillReceipts = draft.storyKillReceipts
            c.state.taskEvents = draft.taskEvents
            count++
        } catch {
            continue
        }
    }
    return count
}
