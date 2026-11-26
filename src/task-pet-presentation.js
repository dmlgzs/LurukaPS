import { TaskGraphs, nodeConditions } from './tasks.js'
import { requirePetModel } from './pet-model-eligibility.js'
const graphsByTables = new WeakMap()
// Compatibility for sandbox accounts prefilled with multiple ranks of a starter.
// Current1.0 TaskPetConditionHelper.TryGetOwnedPet0602f204 rejects two
// different owned GUIDs in the selected current pet_rank group.
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
                // 1.0 TaskCondOpenPageData stores the literal page name and
                // bool flags. Enum97 belongs only to old explicit graph exports.
                return (
                    c.conditionId === 2508 &&
                    (d?.openPageName === 'pageGetPet' || d?.openPageName?.attrButeInfos === 97) &&
                    [false, 0].includes(d.autoOpen) &&
                    [true, 1].includes(d.isCloseOver)
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
    const ids = new Set(hidden.map(String)),
        owned = new Map(state.pets.map((pet) => [String(pet.guid), pet])),
        profiles = new Map((payload.pet_infos.pets ?? []).map((pet) => [String(pet.guid), pet]))
    // Both native6517 and Lua rsp_syncPet populate rows before applying guid
    // removals. Supply each real owned profile so even a cold client has its
    // box index before deletion; never invent a replacement configuration.
    for (const id of ids) {
        const pet = requirePetModel(tables, owned.get(id))
        profiles.set(id, pet)
    }
    return {
        ...payload,
        pet_infos: {
            ...payload.pet_infos,
            pets: [...profiles.values()],
            ...(payload.pet_infos.add_guid
                ? { add_guid: payload.pet_infos.add_guid.filter((id) => !ids.has(String(id))) }
                : {}),
            guid: [...new Set([...(payload.pet_infos.guid ?? []), ...hidden])],
        },
    }
}
