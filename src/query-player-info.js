import { teamV2QueryContexts, projectTeamV2QueryContexts } from './team-v2-eligibility.js'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { publicProfile } from './public-profile.js'

// Current friendAction batches player_ids in groups of100. Selectors are
// requested data areas, never permission to expose another account's wallet.
export const PLAYER_INFO_QUERY_LIMIT = 100
const uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function basicInfo(state, id) {
    const basic = state?.player?.basic_info
    ensure(object(basic) && basic.id === id, 'Saved profile identity is malformed', ErrorCode.GameConfig)
    ensure(
        basic.deleted === undefined || typeof basic.deleted === 'boolean',
        'Saved profile visibility is malformed',
        ErrorCode.GameConfig,
    )
    return basic
}

export function queryPlayerInfo(c, request, store) {
    const playerIds = request.player_ids ?? [],
        types = request.types ?? [],
        dungeonQueries = request.dungeon_query_list ?? []
    ensure(
        Array.isArray(playerIds) && Array.isArray(types) && Array.isArray(dungeonQueries),
        'Player query arrays are malformed',
    )
    ensure(playerIds.length <= PLAYER_INFO_QUERY_LIMIT, 'Too many queried players', ErrorCode.QueryPlayerTooMuch)
    ensure(
        playerIds.every((id) => uint(id) && id > 0),
        'Invalid queried player identity',
        ErrorCode.InvalidTarget,
    )
    // Current protocol enum PBQT_ALL0 through PBQT_SHOW_CASE17. Preserve the
    // existing self query's complete own basic-info response; peer responses
    // use the existing public whitelist for every recognized selector.
    ensure(
        types.every((type) => Number.isInteger(type) && type >= 0 && type <= 17),
        'Unknown player query selector',
    )
    ensure(uint(request.qtype ?? 0), 'Player query mode is malformed')
    ensure((request.qtype ?? 0) === 0, 'Player query mode is not implemented', ErrorCode.FunctionClosed)
    ensure(uint(c.id) && c.id > 0, 'Query account identity is malformed', ErrorCode.GameConfig)
    const contexts = dungeonQueries.length ? teamV2QueryContexts(c.tables, dungeonQueries) : []
    const ids = [...new Set(playerIds.length ? playerIds : [c.id])],
        playerInfos = []
    let deactivated = false
    for (const id of ids) {
        if (id === c.id) {
            playerInfos.push(
                projectTeamV2QueryContexts(c, structuredClone(basicInfo(c.state, id)), c.state, id, contexts),
            )
            continue
        }
        if (!store.hasPlayer(id)) continue
        const profile = store.read(id, (state) => {
            const basic = basicInfo(state, id)
            if (basic.deleted === true) return null
            // No borrowed pending object may escape this synchronous read.
            // No peer migration, flush, timestamp or online status is invented.
            return projectTeamV2QueryContexts(c, structuredClone(publicProfile(basic)), state, id, contexts)
        })
        if (profile === null) deactivated = true
        else playerInfos.push(profile)
    }
    ensure(playerInfos.length > 0 || !deactivated, 'Queried player is deactivated', ErrorCode.TargetPlayerDeactivated)
    return { player_infos: playerInfos }
}
