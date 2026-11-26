import { resolveCurrentTrialGroup, currentSceneTrialRoster } from './current-scene-trials.js'
import { TaskGraphs, nodeConditions, asList } from './tasks.js'
import { taskOverrideNodeIds } from './task-action-data.js'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { currentBattleFsmTrialAdmission } from './current-battle-fsm-trials.js'

export function currentTrialAdmission(tables, state, groupId) {
    const roster = resolveCurrentTrialGroup(tables, groupId),
        scene = currentSceneTrialRoster(tables, state.world.map_id)
    const graphs = new TaskGraphs(tables)
    if (scene?.groupId === groupId) {
        const parent =
            state.storyCampaign?.map_id === state.world.map_id
                ? (state.tasks ?? []).find((task) =>
                      task.nodes.some((node) =>
                          nodeConditions(graphs.get(task.task_id).nodes.get(node.node_id)).some(
                              (condition) =>
                                  condition.__type_TaskConditionBaseData?.__type_TaskCondDungeonData?.dungeonId ===
                                  state.storyCampaign.dungeon_id,
                          ),
                      ),
                  )
                : null
        return { roster, source: 'scene', taskId: parent?.task_id ?? state.storyCampaign?.teaching_id }
    }
    const tasks = (state.tasks ?? []).filter((task) =>
        graphs.get(task.task_id).controllers.some((controller) => {
            const data = controller.__type_TaskTeamController
            return (
                data?.trialsId === groupId &&
                asList(data.stateScene).includes(state.world.map_id) &&
                task.nodes.some((node) => taskOverrideNodeIds(controller).includes(node.node_id))
            )
        }),
    )
    ensure(tasks.length <= 1, 'Current trial group has ambiguous active task authority', ErrorCode.GameConfig)
    return tasks.length
        ? { roster, source: 'task-controller', taskId: tasks[0].task_id }
        : currentBattleFsmTrialAdmission(tables, state, groupId)
}

export function currentTrialPetSlots(roster, resolvedHeroSlots) {
    return roster.pets.map((pet) => {
        if (pet.pos >= 0) return pet
        const automatic = roster.heroes.filter((hero) => hero.pos === -1)
        ensure(
            automatic.length === 1 && resolvedHeroSlots.has(automatic[0].id),
            'Automatic current trial pet has no unique same-source hero slot',
            ErrorCode.GameConfig,
        )
        return { ...pet, pos: resolvedHeroSlots.get(automatic[0].id) }
    })
}
