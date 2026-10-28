import { createAbyssRun, installAbyssFormation, abyssDungeonInfo, abyssActorInfo } from '../abyss-run.js'
import { ensureAbyssScene } from '../abyss-scene.js'
import { abyssTables, abyssModeLevels } from '../abyss-catalog.js'
import { abyssDataSnapshot } from '../abyss-data.js'
import { worldSync, WORLD_MAP_CMD_ENTER } from './world.js'
import { syncBattle } from '../battle.js'
import { ensure } from './common.js'
import { ErrorCode } from '../error-codes.js'
import { startAbyssBattle, advanceAbyssCombat } from '../abyss-battle.js'
import { nextAbyssRoom, clearAbyssRuntime, retryAbyssRoom } from '../abyss-flow.js'
import { abyssModeRecord } from '../abyss-run.js'
import { finishAbyssIntro, publishAbyssIntro } from '../abyss-intro.js'
import { publishAbyssMonsterBuffs, publishAbyssHeroMapElements } from '../abyss-buffs.js'

export function publishAbyssEntry(c) {
    const run = c.state.abyssRun,
        tables = abyssTables(c.tables)
    // Prime map elements before group7 can create a new half's heroes. The
    // standard cmd47 map delta does not enter a scene or replace its objects.
    publishAbyssHeroMapElements({ ...c, push: c.pushBefore })
    installAbyssFormation(c.state)
    ensureAbyssScene(c.tables, c.state, c.now)
    // The copy records must precede formation activation. FO30/31 identities
    // populate separate client cache entries and keep real inventory intact.
    c.pushBefore('CSProtoAbyssHeroInfoSync', abyssActorInfo(c.state))
    c.pushBefore('CSProtoSyncPlayerData', { group_mgrs: [c.state.player.group_mgrs.find((x) => x.type === 7)] })
    syncBattle({ ...c, push: c.pushBefore })
    c.pushBefore('SCProtoAbyssDungeonInfoSync', abyssDungeonInfo(c.state))
    publishAbyssMonsterBuffs(c)
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
    publishAbyssIntro(c)
    advanceAbyssCombat(c)
    return {}
}
export function registerAbyssChallenge(on) {
    on('AbyssBossIntroDone', finishAbyssIntro)
    on('AbyssChallengeReset', (c, r) => {
        const tables = abyssTables(c.tables),
            context = abyssModeLevels(tables, r.mode, c.now),
            level = tables.find('abbys_level', r.abyss_level),
            run = c.state.abyssRun
        ensure(
            level?.mode === r.mode && context.levels.includes(level.id),
            'Invalid abyss reset level',
            ErrorCode.AbyssInvalidLevel,
        )
        ensure(
            !run || (run.mode === r.mode && run.level_id === level.id),
            'Cannot reset another active abyss challenge',
            ErrorCode.AbyssInvalidChallengeLevel,
        )
        let abyssExit = null
        if (run) {
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
            abyssExit = clearAbyssRuntime({ ...c, push: c.pushBefore })
        }
        const mode = abyssModeRecord(c.state, r.mode, context.rotation),
            saved = mode.levels[level.id]
        if (saved) {
            delete saved.resume
            saved.challenge_list = []
        }
        c.pushBefore('SCProtoAbyssLevelInfoUpdate', {
            mode: r.mode,
            level_info: abyssDataSnapshot(tables, c.state, c.now)[
                ['newer', 'persistent', 'rotation'][r.mode - 1] + '_mode_info'
            ].find((x) => x.cur_level === level.id),
        })
        if (run) worldSync({ ...c, push: c.pushBefore }, {}, WORLD_MAP_CMD_ENTER, true, { abyssExit })
        return {}
    })
    on('AbyssChallengeRetry', (c) => {
        const run = retryAbyssRoom(c)
        publishAbyssEntry(c)
        // is_retry tears down the old client manager, so it must be a one-shot
        // entry marker, never repeated by subsequent live wave updates.
        run.retry = false
        return {}
    })
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
        const abyssExit = clearAbyssRuntime({ ...c, push: c.pushBefore })
        worldSync({ ...c, push: c.pushBefore }, {}, WORLD_MAP_CMD_ENTER, true, { abyssExit })
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
