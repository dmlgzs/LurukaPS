export function retireTrialActors(state, actors) {
    const ids = new Set(state.retiredTrialActors ?? [])
    for (const actor of actors) ids.add(actor.guid)
    state.retiredTrialActors = [...ids].slice(-128)
}
export function isRetiredTrialActor(state, id) {
    return (
        !!state.retiredTrialActors?.includes(String(id)) &&
        ![...temporaryHeroes(state), ...temporaryPets(state)].some((actor) => actor.guid === String(id))
    )
}
export function temporaryHeroes(state) {
    const arena = state.npcArenaTrialTrainer
    return [
        ...(state.trialGroup?.heroes ?? []),
        ...(state.cultTrial?.heroes ?? []),
        ...(state.abyssRun && state.abyssRun.map_id === state.world?.map_id ? (state.abyssRun.heroes ?? []) : []),
        ...(arena && arena.map_id === state.world?.map_id && arena.duel_id === state.multiCampaign?.duel_id
            ? [arena.hero]
            : []),
    ]
}
export function temporaryPets(state) {
    return [
        ...(state.trialGroup?.pets ?? []),
        ...(state.cultTrial?.pets ?? []),
        ...(state.abyssRun && state.abyssRun.map_id === state.world?.map_id ? (state.abyssRun.pets ?? []) : []),
    ]
}
export function activeFormationManager(state) {
    const type =
        state.abyssRun && state.abyssRun.map_id === state.world.map_id
            ? 7
            : state.cultTrial && state.cultTrial.map_id === state.world.map_id
              ? 8
              : 1
    return state.player.group_mgrs.find((manager) => manager.type === type)
}
