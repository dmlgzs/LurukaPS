import { TaskGraphs, nodeConditions } from './tasks.js'
const graphsByTables = new WeakMap()
// Compatibility for sandbox accounts prefilled with multiple ranks of a starter.
// The CBT3 task helper requires exactly one owned GUID in the selected group.
// Only the client presentation is narrowed; all stored pets remain untouched.
export function hiddenTaskPetGuids(tables, state) {
    let graphs = graphsByTables.get(tables)
    if (!graphs) graphsByTables.set(tables, (graphs = new TaskGraphs(tables)))
    for (const task of state.tasks ?? []) {
        const group = state.taskPetChoices?.[task.task_id]
        if (!group) continue
        for (const node of task.nodes) {
            const conditions = nodeConditions(graphs.get(task.task_id).nodes.get(node.node_id))
            const index = conditions.findIndex((c) => {
                const d = c.__type_TaskConditionBaseData?.__type_TaskCondOpenPageData
                // Exported page enum 97 resolves to pageGetPet in CBT3.
                return (
                    c.conditionId === 2508 &&
                    d?.openPageName?.attrButeInfos === 97 &&
                    d.autoOpen === 0 &&
                    d.isCloseOver === 1
                )
            })
            if (index < 0 || node.client_cond_after?.[index] || node.node_values?.[index] > 0) continue
            const prefix = task.task_id + ':' + (state.taskEpochs?.[task.task_id] ?? 0) + ':'
            const receipt = Object.entries(state.playableChoiceReceipts ?? {}).find(
                ([key, r]) => key.startsWith(prefix) && r.pet_group === group,
            )?.[1]
            const selected = state.pets.find((p) => p.guid === receipt?.pet_guid)
            if (
                !selected ||
                !tables.get('pet_rank').some((r) => r.petId === selected.config_id && r.petGroup === group)
            )
                continue
            const species = new Set(
                tables
                    .get('pet_rank')
                    .filter((r) => r.petGroup === group)
                    .map((r) => r.petId),
            )
            return state.pets.filter((p) => p.guid !== selected.guid && species.has(p.config_id)).map((p) => p.guid)
        }
    }
    return []
}
export function taskPetPresentation(tables, state, payload) {
    if (!payload?.pet_infos) return payload
    const hidden = hiddenTaskPetGuids(tables, state)
    if (!hidden.length) return payload
    const ids = new Set(hidden)
    return {
        ...payload,
        pet_infos: {
            ...payload.pet_infos,
            pets: (payload.pet_infos.pets ?? []).filter((p) => !ids.has(p.guid)),
            guid: [...new Set([...(payload.pet_infos.guid ?? []), ...hidden])],
        },
    }
}
