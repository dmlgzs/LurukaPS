import { currentMapFormation } from './current-map-member.js'
import { heroModules, heroBattleLimits } from './battle.js'
import { ErrorCode } from './error-codes.js'
import { ensure, GameError } from './handlers/common.js'

const uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff

// Current UpdateTeamArr060015c4 changes MainHeroId from every attribute row.
// Publish the actual current control once per member,not every formation hero.
export function currentMapMemberAttribute(tables, state, playerId) {
    ensure(uint(playerId) && playerId > 0, 'Map member identity is malformed', ErrorCode.GameConfig)
    const { control } = currentMapFormation(state),
        rows = (state.player.heros_info.battle_infos ?? []).filter(
            (row) => String(row.hero_id) === String(control.guid),
        )
    ensure(
        uint(control.conf_id) && control.conf_id > 0,
        'Map member control config identity is malformed',
        ErrorCode.GameConfig,
    )
    ensure(rows.length === 1, 'Map member control battle state is unavailable or duplicated', ErrorCode.GameConfig)
    const saved = rows[0]
    ensure(
        uint(saved.hp) && uint(saved.sp) && uint(saved.alive_state),
        'Map member control vitals are malformed',
        ErrorCode.GameConfig,
    )
    let limits
    try {
        limits = heroBattleLimits(heroModules(tables, state, control))
    } catch (error) {
        if (error instanceof GameError) throw error
        throw new GameError(`Map member battle attributes unavailable: ${error.message}`, ErrorCode.GameConfig)
    }
    // Mirror the existing refreshBattleState upper-bound normalization without
    // mutating a borrowed peer or refilling its saved HP/SP.
    return {
        player_id: playerId,
        hero_id: control.conf_id,
        hp: Math.min(saved.hp, limits.hp),
        max_hp: limits.hp,
        sp: Math.min(saved.sp, limits.sp),
        max_sp: limits.sp,
        alive_state: saved.alive_state,
    }
}
