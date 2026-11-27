const caches = new WeakMap()
const positive = (value) => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff

// These are server delivery scopes, never new wire fields or shared-run
// admission. Existing dungeon handlers create independent owner-local runs;
// equal map IDs and equal local instance counters do not make them one room.
export function sceneRoute(tables, state, playerId, sharedRuns) {
    const map = state.world?.map_id,
        city = positive(map) ? tables.find('world_city', map) : null
    if (!positive(playerId) || !city) return Object.freeze({ map: null, scope: null })
    const shared = sharedRuns?.sceneRoute(state, playerId)
    if (shared) return shared
    const privateRun = !!(
        state.entrust?.run ||
        state.multiCampaign ||
        state.storyCampaign ||
        state.cultTrial ||
        state.abyssRun ||
        state.sharedTeamRun
    )
    return Object.freeze({
        map,
        scope: city.type === 1 && !privateRun ? `world:${map}` : `private:${playerId}:${map}`,
    })
}

export function sceneAudienceMetadata(tables, state, playerId, audience, sharedRuns) {
    if (audience.kind !== 'map') return { audience }
    const route = sceneRoute(tables, state, playerId, sharedRuns)
    return {
        audience,
        sceneScope: route.map === audience.map && audience.sender === playerId ? route.scope : null,
    }
}

// Store tokens change for both durable writes and deferred movement/combat.
// Cache only the small immutable route, never a borrowed player or run object.
export function sceneRoutingInfo(store, tables, playerId, sharedRuns) {
    let cache = caches.get(store)
    if (!cache || cache.tables !== tables || cache.sharedRuns !== sharedRuns) {
        cache = { tables, sharedRuns, entries: new Map() }
        caches.set(store, cache)
    }
    const token = store.readCacheToken(playerId),
        sharedToken = sharedRuns?.routeToken(playerId),
        cached = cache.entries.get(playerId)
    if (cached?.token === token && cached.sharedToken === sharedToken) return cached.route
    const route = store.read(playerId, (state) => sceneRoute(tables, state, playerId, sharedRuns))
    // LOCAL cache bound, unrelated to gameplay capacity.
    if (!cache.entries.has(playerId) && cache.entries.size >= 4096)
        cache.entries.delete(cache.entries.keys().next().value)
    cache.entries.set(playerId, { token, sharedToken, route })
    return route
}

export function sceneAudienceAllows(route, audience, sceneScope) {
    return (
        audience.kind === 'map' &&
        typeof route.scope === 'string' &&
        route.scope === sceneScope &&
        route.map === audience.map
    )
}
