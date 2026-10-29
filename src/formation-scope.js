// Server-known effective formation scope, shared by actor and medicine users.
export function effectiveFormationManager(state) {
    const type =
        state.abyssRun && state.abyssRun.map_id === state.world.map_id
            ? 7
            : state.cultTrial && state.cultTrial.map_id === state.world.map_id
              ? 8
              : 1
    return state.player.group_mgrs.find((manager) => manager.type === type)
}
