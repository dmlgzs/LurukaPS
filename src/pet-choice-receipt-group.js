// Rekey a consistent saved choice against current owned-pet/customized/drop
// facts. No historical group map,asset grants or task completion are inferred.
export function reconcilePetChoiceReceiptGroup(tables, state, taskId = 106010, playId = 60001) {
    const receipt = state.playableChoiceReceipts?.[`${taskId}:${state.taskEpochs?.[taskId] ?? 0}:${playId}`],
        run = state.playableRuns?.[playId],
        finish = state.playableFinishes?.[playId],
        group = state.taskPetChoices?.[taskId]
    if (
        !receipt ||
        !run ||
        !Number.isSafeInteger(group) ||
        group <= 0 ||
        receipt.pet_group !== group ||
        run.selected_pet_group !== group ||
        run.selected_step !== receipt.step ||
        run.selected_pet_guid !== receipt.pet_guid ||
        (finish && (finish.selected_pet_group !== group || finish.selected_pet_guid !== receipt.pet_guid))
    )
        return false
    const pet = state.pets.find((pet) => pet.guid === receipt.pet_guid)
    if (!pet) return false
    const customized = tables.find('pet_customized', pet.customized_id)
    if (customized?.petId !== pet.config_id) return false
    const playable = tables.find('playable', playId)
    const drop = String(playable?.stepRewards ?? '')
        .split('|')
        .map((token) => token.split('#').map(Number))
        .find(([step]) => step === receipt.step)?.[1]
    if (drop !== receipt.drop_id) return false
    const rewards = tables.get('drop').filter((row) => row.dropId === drop)
    if (
        rewards.length !== 1 ||
        rewards[0].type !== 30 ||
        rewards[0].itemId !== customized.id ||
        rewards[0].minValue !== 1 ||
        rewards[0].maxValue !== 1
    )
        return false
    const groups = new Set(
        tables
            .get('pet_rank')
            .filter((rank) => rank.petId === pet.config_id)
            .map((rank) => rank.petGroup),
    )
    if (groups.size !== 1) return false
    const current = [...groups][0]
    if (!Number.isSafeInteger(current) || current <= 0 || current === group) return false
    receipt.pet_group = current
    run.selected_pet_group = current
    if (finish) finish.selected_pet_group = current
    state.taskPetChoices[taskId] = current
    state.compatibilityDiagnostics ??= {}
    state.compatibilityDiagnostics.petChoiceGroups ??= {}
    state.compatibilityDiagnostics.petChoiceGroups[`${taskId}:${playId}`] = {
        version: '1.0.0',
        previous: group,
        current,
        pet_guid: pet.guid,
        source: 'owned customized pet,current fixed choice drop and pet_rank',
    }
    return true
}
