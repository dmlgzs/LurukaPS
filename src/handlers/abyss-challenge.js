import { createAbyssRun, installAbyssFormation, abyssDungeonInfo, abyssActorInfo } from '../abyss-run.js'
import { ensureAbyssScene } from '../abyss-scene.js'
import { abyssTables } from '../abyss-catalog.js'
import { abyssDataSnapshot } from '../abyss-data.js'
import { worldSync } from './world.js'
import { syncBattle } from '../battle.js'
import { ensure } from './common.js'
import { ErrorCode } from '../error-codes.js'
import { startAbyssBattle, advanceAbyssCombat } from '../abyss-battle.js'
import { nextAbyssRoom, clearAbyssRuntime } from '../abyss-flow.js'

export function publishAbyssEntry(c) {
    const run = c.state.abyssRun,
        tables = abyssTables(c.tables)
    installAbyssFormation(c.state)
    ensureAbyssScene(c.tables, c.state, c.now)
    // The copy records must precede formation activation. FO30/31 identities
    // populate separate client cache entries and keep real inventory intact.
    c.pushBefore('CSProtoAbyssHeroInfoSync', abyssActorInfo(c.state))
    c.pushBefore('CSProtoSyncPlayerData', { group_mgrs: [c.state.player.group_mgrs.find((x) => x.type === 7)] })
    syncBattle({ ...c, push: c.pushBefore })
    c.pushBefore('SCProtoAbyssDungeonInfoSync', abyssDungeonInfo(c.state))
    c.pushBefore('SCProtoAbyssLevelInfoUpdate', {
        mode: run.mode,
        level_info: abyssDataSnapshot(tables, c.state, c.now)[
            ['newer', 'persistent', 'rotation'][run.mode - 1] + '_mode_info'
        ].find((x) => x.cur_level === run.level_id),
    })
    worldSync({ ...c, push: c.pushBefore })
}
export function enterAbyssScene(c, r = {}) {
    ensure(
        c.state.abyssRun?.map_id === c.state.world.map_id && (!r.scene_id || r.scene_id === c.state.world.map_id),
        'Abyss scene is not active',
        ErrorCode.AbyssInvalidDungeonID,
    )
    publishAbyssEntry(c)
    advanceAbyssCombat(c)
    return {}
}
export function registerAbyssChallenge(on) {
    on('AbyssChallengeQuit', (c) => {
        const run = c.state.abyssRun
        if (!run) return {}
        const target = run.return_world
        ensure(
            target && [1, 3, 7].includes(c.tables.find('world_city', target.map_id)?.type),
            'Saved abyss entrance is unavailable',
            ErrorCode.InstanceSceneConfNotExist,
        )
        ensure(
            target.pos && ['x', 'y', 'z'].every((k) => Number.isSafeInteger(target.pos[k])),
            'Saved abyss entrance position is malformed',
            ErrorCode.GameConfig,
        )
        Object.assign(c.state.world, structuredClone(target))
        clearAbyssRuntime({ ...c, push: c.pushBefore })
        worldSync({ ...c, push: c.pushBefore })
        return {}
    })
    on('AbyssChallengeNext', (c) => {
        nextAbyssRoom(c)
        publishAbyssEntry(c)
        return {}
    })
    on('AbyssChallengeRealStart', startAbyssBattle)
    on('AbyssChallenge', (c, r) => {
        createAbyssRun(c, r)
        publishAbyssEntry(c)
        return {}
    })
}
