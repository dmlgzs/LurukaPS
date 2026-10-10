import { repairSavedElevatorVisibility } from './world-elevator.js'
import { recordWorldDiscovery } from '../world-discovery.js'
import { expireTaskTrialGroup, trialPayload } from './trial-groups.js'
import { validateTaskTransfer } from '../task-scenes.js'
import { heroBattleLimits, heroModules, syncBattle } from '../battle.js'
import { ensure, group, pet } from './common.js'
import { mountPayload, clearSceneMount } from '../mounts.js'
import { restoreLegacyHomeFormation } from '../home-formation.js'
import { repairMainHeroType } from '../main-hero.js'
import { campaignSnapshot, entrustChestSnapshot } from '../entrust.js'
import { u64 } from '../combat-state.js'
import { recoverFormationHp } from '../transpoint-recovery.js'
import {
    storyCampaignSnapshot,
    resetCampaignTasks,
    preserveCampaignTaskTransfer,
    ensureStoryCampaignScene,
} from '../story-campaign.js'
import { taskSnapshot } from '../tasks.js'
import { beginSceneTransition, isPreviousSceneMovement, endSceneTransition } from '../scene-transition.js'
import { playableSnapshot } from './playable-lifecycle.js'
import {
    addWorldMark,
    deleteWorldMarks,
    setWorldMarkTrace,
    updateWorldMarks,
    worldMarkPayload,
} from '../world-marks.js'

export const WORLD_MAP_CMD_ENTER = 256

function mapPlayer(c) {
    const s = c.state,
        w = s.world,
        g = group(s),
        ids = g.heros.filter((h) => h.hero_id && h.hero_id !== '0').map((h) => h.hero_id)
    const move = { pos: w.pos, angle: w.angle, area_id: w.area_id, move_status: 1, timestamp: String(c.now * 1000) }
    return {
        player_id: c.id,
        move: [move],
        status: w.status ?? 0,
        host: true,
        name: s.player.basic_info.name,
        face: s.player.basic_info.wardrobe,
        group: { heros: ids, hero_mid: ids, control: g.control },
        mount: w.mount,
        mount_status: w.mount_status ?? 0,
        ...(w.mount && w.mount !== '0' ? { mount_move: move } : {}),
        apparel_info: s.player.basic_info.apparel_info,
        clothes_info: s.player.basic_info.clothes_info,
    }
}
function playerStatusSync(c, cmd) {
    const w = c.state.world,
        mount = w.mount,
        move = { pos: w.pos, angle: w.angle, area_id: w.area_id, move_status: 1, timestamp: String(c.now * 1000) }
    // Status deltas must not resend the formation: that can rebuild the local
    // party and select its first hero during a mount transition.
    // SyncMyPlayerMapStatus treats a leave packet with move_status=1 as forced
    // dismount. Omit movement on the status=0 delta so the normal animation runs.
    const moving = (w.status ?? 0) !== 0
    const player = {
        player_id: c.id,
        status: w.status ?? 0,
        mount,
        mount_status: w.mount_status ?? 0,
        ...(moving ? { move: [move] } : {}),
        ...(moving && mount && mount !== '0' ? { mount_move: move } : {}),
    }
    c.push('CSProtoWorldMapSync', {
        cmd,
        creator_id: c.id,
        map_id: w.map_id,
        player_id: c.id,
        notify_id: c.id,
        zone_id: 0,
        map_info: { creator_id: c.id, map_id: w.map_id, exist: true, area_id: w.area_id, players: [player] },
    })
}
function transientMarkGuid(state, requested) {
    if (requested > 0) return requested
    const used = new Set((state.worldMarks ?? []).map((mark) => mark.guid))
    let guid = Number(state.worldMarkNextGuid ?? 1)
    while (used.has(guid)) {
        guid++
        ensure(guid <= 0xffffffff, 'Map mark identity exhausted')
    }
    return guid
}
function teleportFromTestMark(c, mark) {
    if (mark.notes !== '/tp') return null
    const x = Number(mark.pos_x),
        y = Number(mark.pos_y),
        z = Number(mark.pos_z)
    ensure([x, y, z].every(Number.isFinite), 'Invalid test teleport mark position')
    const height = Number(c.tables.get('game').find((row) => row.title === 'MAP_MARK_HEIGHT_DIFFERENCE')?.value ?? 4.5)
    ensure(Number.isFinite(height) && height > 0, 'Invalid map mark teleport height', 1007)
    const guid = transientMarkGuid(c.state, mark.guid ?? 0)
    if (mark.guid) deleteWorldMarks(c.state, [mark.guid])
    c.state.world.pos = {
        x: Math.round(x * 100),
        y: Math.round((y + height) * 100),
        z: Math.round(z * 100),
    }
    c.state.world.angle = 0
    worldSync(c)
    // The response is transient too: remove a possible client-side echo of
    // the command marker immediately after the teleport sync.
    c.push('CSProtoWorldMapMarkListSync', worldMarkPayload(c.state, [guid]))
    syncBattle(c)
    return { ...mark, guid }
}
export function repairLegacyMountState(state, tables) {
    const w = state.world
    if (w.pendingMountExit) delete w.pendingMountExit
    // CBT3 MountUtil.CheckSceneCanMount reads world_city.mountAvailable.
    // Recover saves already transferred before scene-local riding was cleared.
    if (tables?.find('world_city', w.map_id)?.mountAvailable === 0) return clearSceneMount(state)
    if (w.status !== 1 || w.mountSyncVersion || !w.mount || w.mount === '0') return false
    w.status = 0
    w.status_arg = '0'
    w.mount = '0'
    w.mount_status = 0
    return true
}
export function worldSync(c, r = {}, cmd = WORLD_MAP_CMD_ENTER, includeMarks = true) {
    repairSavedElevatorVisibility(c.tables, c.state)
    const restoredFormation = restoreLegacyHomeFormation(c.state),
        repairedMainHero = repairMainHeroType(c.tables, c.state)
    if (restoredFormation || repairedMainHero)
        c.push('CSProtoSyncPlayerData', {
            ...(restoredFormation ? { group_mgrs: c.state.player.group_mgrs } : {}),
            ...(repairedMainHero ? { heros_info: c.state.player.heros_info } : {}),
        })
    if (expireTaskTrialGroup(c.tables, c.state)) {
        c.push('CSProtoTrialDatas', trialPayload(c.state))
        c.push('CSProtoSyncPlayerData', {
            heros_info: c.state.player.heros_info,
            group_mgrs: c.state.player.group_mgrs,
        })
    }
    const s = c.state,
        w = s.world
    if ([WORLD_MAP_CMD_ENTER, 49, 19].includes(cmd)) beginSceneTransition(s, c.previousMapId, c.now, cmd)
    const departedEntrust = s.entrust?.run
    if (departedEntrust && departedEntrust.map_id !== w.map_id) {
        // Teleports/GM transfers may bypass CampaignQuit. Do not leave a
        // commission manager alive after entering a different world.
        c.push('CSProtoCurMultiCampaignInfoSync', {
            dungeon_id: departedEntrust.dungeon_id,
            dungeon_scene_id: departedEntrust.map_id,
            map_id: departedEntrust.map_id,
            status: 1,
        })
        c.push('CSProtoCampaignInfoSync', {
            status: 1,
            dungeon_id: departedEntrust.dungeon_id,
            cur_scene_id: departedEntrust.map_id,
        })
        delete s.entrust.run
    }
    if (s.storyCampaign && s.storyCampaign.map_id !== w.map_id) {
        c.push('CSProtoCampaignInfoSync', { ...storyCampaignSnapshot(s), status: 1 })
        const reset = resetCampaignTasks(c.tables, s, s.storyCampaign)
        if (reset) {
            c.push('CSProtoTaskSync', reset)
            c.push('CSProtoTaskSync', taskSnapshot(c.tables, s))
            c.push('CSProtoPlayableSync', playableSnapshot(s))
        }
        delete s.storyCampaign
        delete s.combat
    }
    c.push('CSProtoWorldMapPointSync', { u32s: w.points })
    if (includeMarks) c.push('CSProtoWorldMapMarkListSync', worldMarkPayload(s))
    c.push('CSProtoWorldMapSync', {
        cmd,
        creator_id: c.id,
        map_id: w.map_id,
        player_id: c.id,
        notify_id: c.id,
        zone_id: 0,
        client_trans_data: r.client_trans_data || 0,
        map_info: {
            creator_id: c.id,
            map_id: w.map_id,
            exist: true,
            area_id: w.area_id,
            ...(r.campaign_start ? { campaign_start: r.campaign_start } : {}),
            objs: Object.entries(s.worldObjects ?? {})
                .filter(([key]) => key.startsWith(w.map_id + ':'))
                .map(([, record]) => {
                    const { claims, ...obj } = record
                    return obj
                }),
            players: [mapPlayer(c)],
        },
    })
    // CutWorld creates the destination SceneProxy synchronously before its
    // loading flow. Retain the dungeon AOI/preload protocol on reconnect;
    // the entrust handler assigns the active group's control separately.
    if ([WORLD_MAP_CMD_ENTER, 49].includes(cmd) && s.entrust?.run?.map_id === w.map_id) {
        const single = c.tables.find('world_city', w.map_id)?.type === 2
        c.push('CSProtoOnlineModeChange', { mode: single ? 5 : 4 })
        // Disposing the previous scene can clear DungeonManager's cached
        // server info. Rebind it after CutWorld selected the destination.
        if (single) {
            c.push('CSProtoCampaignInfoSync', campaignSnapshot(s.entrust.run))
            if (s.entrust.run.battle_complete) c.push('CSProtoStaminaBoxSync', entrustChestSnapshot(c.tables, s))
        }
    }
    if ([WORLD_MAP_CMD_ENTER, 49].includes(cmd) && s.storyCampaign?.map_id === w.map_id) {
        c.push('CSProtoOnlineModeChange', { mode: 5 })
        c.push('CSProtoCampaignInfoSync', storyCampaignSnapshot(s))
    }
}
export function rememberMap(c, destination) {
    const w = c.state.world
    if (w.map_id === destination) return
    const history = (c.state.worldHistory ??= [])
    history.push({ map_id: w.map_id, point_id: w.point_id, area_id: w.area_id, pos: { ...w.pos }, angle: w.angle })
    if (history.length > 8) history.shift()
}
export function registerWorld(on) {
    on('WorldMapExtraStatus', (c, r) => {
        const status = r.status ?? 0
        ensure(Number.isInteger(status) && status >= 0 && status < 6, 'Invalid extra player status')
        const arg = u64(r.arg)
        // 9119 acknowledges temporary modes such as SIGHTSEE. The client owns
        // its temporary mount; echoing 9117/WMCT_PLAYER_STATUS here would rebuild it.
        c.setExtraStatus({ status, arg, time: c.now })
        return {}
    })
    on('WorldMapActiveBehavior', (c, r) => {
        ensure(r.type === 3, 'Active behavior type is not implemented', 1021)
        recoverFormationHp(c)
        return {}
    })
    on('EnterWorldMap', (c, r) => {
        const w = c.state.world,
            taskPoint = validateTaskTransfer(c.tables, c.state, r)
        if (c.state.pendingTaskScene && !taskPoint && (!(r.point_id > 0) || r.reconnect)) {
            r = { ...r, map_id: w.map_id, point_id: 0 }
        }
        delete c.state.pendingTaskScene
        if ((r.map_id && r.map_id !== w.map_id) || r.point_id > 0) {
            const p =
                taskPoint ??
                (r.point_id > 0
                    ? c.tables.find('world_borthpos', r.point_id)
                    : c.tables.get('world_borthpos').find((p) => p.cityId === r.map_id))
            ensure(p && (!r.map_id || p.cityId === r.map_id), 'Invalid map/point')
            const mapChanged = w.map_id !== p.cityId
            rememberMap(c, p.cityId)
            Object.assign(w, c.tables.position(p))
            if (mapChanged) delete c.state.combat
            if (taskPoint && preserveCampaignTaskTransfer(c.tables, c.state, r, taskPoint)) {
                ensureStoryCampaignScene(c.tables, c.state, c.now)
                c.pushBefore('CSProtoCampaignInfoSync', storyCampaignSnapshot(c.state))
            }
        }
        const homeMapId = Number(c.tables.get('game').find((row) => row.title === 'HOME_ID')?.value)
        if (w.map_id === homeMapId) {
            const area = c.tables.get('world_area').find((row) => row.sceneId === homeMapId)
            ensure(area, 'Missing home world area', 1007)
            if (w.area_id !== area.id) delete c.state.combat
            w.area_id = area.id
        }
        worldSync(c, r)
        syncBattle(c)
        return {}
    })
    on('WorldPoint', (c, r) => {
        const p = c.tables.find('world_borthpos', r.point_id)
        ensure(p && c.state.world.points.includes(p.id), 'Point is not unlocked')
        rememberMap(c, p.cityId)
        Object.assign(c.state.world, c.tables.position(p))
        worldSync(c, r, 19)
        syncBattle(c)
        return {}
    })
    on('WorldQuitHome', (c) => {
        const homeMapId = Number(c.tables.get('game').find((row) => row.title === 'HOME_ID')?.value)
        ensure(Number.isInteger(homeMapId) && homeMapId > 0, 'Missing home map id', 1007)
        const isHomeScene = (mapId) => mapId === homeMapId || c.tables.find('world_city', mapId)?.playModule === 'Home'
        if (!isHomeScene(c.state.world.map_id)) return {}

        const history = c.state.worldHistory ?? []
        let previous
        while (history.length) {
            const candidate = history.pop(),
                city = c.tables.find('world_city', candidate.map_id)
            // Task transfers add home and performance scenes to the same stack.
            // A home exit must not re-enter one of those intermediate scenes.
            if (!city || isHomeScene(candidate.map_id) || city.type === 28) continue
            if (!c.tables.get('world_borthpos').some((point) => point.cityId === candidate.map_id)) continue
            previous = candidate
            break
        }
        if (previous) {
            Object.assign(c.state.world, previous)
        } else {
            const fallback = c.tables.find('world_borthpos', 10045)
            ensure(fallback, 'Missing exploration return point', 1007)
            Object.assign(c.state.world, c.tables.position(fallback))
        }

        delete c.state.combat
        delete c.state.pendingTaskScene
        const sceneContext = { ...c, push: c.pushBefore }
        worldSync(sceneContext, {}, WORLD_MAP_CMD_ENTER)
        syncBattle(sceneContext)
        return {}
    })
    on('WorldPointAck', (c) => {
        endSceneTransition(c.state, 19)
        c.state.world.last_point_ack = { map_id: c.state.world.map_id, point_id: c.state.world.point_id, time: c.now }
    })
    on('WorldObjDiscovery', (c, r) => {
        const result = recordWorldDiscovery(c.tables, c.state, r.u32s)
        if (result.changed) c.push('CSProtoWorldMapMarkListSync', worldMarkPayload(c.state))
        return { u32s: result.ids }
    })
    on('WorldMapMarkAdd', (c, r) => {
        const testTeleport = teleportFromTestMark(c, r)
        if (testTeleport) return testTeleport
        const mark = addWorldMark(c.state, r)
        c.push('CSProtoWorldMapMarkListSync', worldMarkPayload(c.state))
        return mark
    })
    on('WorldMapMarkDel', (c, r) => {
        const deleted = deleteWorldMarks(c.state, r.guids ?? [])
        c.push('CSProtoWorldMapMarkListSync', worldMarkPayload(c.state, deleted))
        return {}
    })
    on('WorldMapTracePointSet', (c, r) => {
        setWorldMarkTrace(c.state, r.u32 ?? 0)
        c.push('CSProtoWorldMapMarkListSync', worldMarkPayload(c.state))
        return {}
    })
    on('WorldMapMarkUpdate', (c, r) => {
        const infos = updateWorldMarks(c.state, r.infos ?? [])
        c.push('CSProtoWorldMapMarkListSync', worldMarkPayload(c.state))
        return { infos }
    })
    on('WorldMapPlayerRevive', (c) => {
        const heroes = [...(c.state.player.heros_info.heros ?? []), ...(c.state.trialGroup?.heroes ?? [])],
            seen = new Set()
        for (const hero of heroes) {
            if (seen.has(hero.guid)) continue
            seen.add(hero.guid)
            const battle = c.state.player.heros_info.battle_infos.find((info) => info.hero_id === hero.guid)
            if (!battle) continue
            const max = heroBattleLimits(heroModules(c.tables, c.state, hero))
            Object.assign(battle, { hp: max.hp, sp: max.sp, alive_state: 0 })
        }
        syncBattle(c)
        return {}
    })
    on('WorldMapReturnLast', (c) => {
        const previous = c.state.worldHistory?.pop()
        const fallback = previous ? null : c.tables.find('world_borthpos', 10045)
        ensure(previous || fallback, 'No return destination')
        const target = previous ?? c.tables.position(fallback)
        ensure(
            c.tables.get('world_borthpos').some((p) => p.cityId === target.map_id),
            'Return map unavailable',
        )
        Object.assign(c.state.world, target)
        worldSync(c)
        syncBattle(c)
        return {}
    })
    on('StateUpdate', (c, r) => {
        const m = r.move_msg
        if (!m) return
        const w = c.state.world
        if (m.map_id !== w.map_id && isPreviousSceneMovement(c.state, m.map_id)) return
        ensure(m.map_id === w.map_id, 'Wrong map')
        const g = group(c.state),
            activeMount = w.status === 1 ? w.mount : null,
            mounted = activeMount && activeMount !== '0'
        ensure((m.move ?? []).length <= 256, 'Too many movement records')
        let heroMove, mountMove
        for (const item of m.move ?? []) {
            if (item.uuid !== g.control && (!mounted || item.uuid !== activeMount)) continue
            const i = item.info
            ensure(i?.pos, 'Missing movement position')
            const pos = Object.fromEntries(['x', 'y', 'z'].map((k) => [k, i.pos[k] ?? 0]))
            ensure(
                Object.values(pos).every((v) => Number.isInteger(v) && Math.abs(v) < 100000000),
                'Invalid coordinates',
            )
            const confirmed = { uuid: item.uuid, info: { ...i, pos, angle: i.angle ?? 0 } }
            if (mounted && item.uuid === activeMount) mountMove = confirmed
            else heroMove = confirmed
        }
        const confirmed = mountMove ?? heroMove
        if (!confirmed) return
        endSceneTransition(c.state)
        w.pos = confirmed.info.pos
        w.angle = confirmed.info.angle
        if (confirmed.info.area_id !== undefined) w.area_id = confirmed.info.area_id
        c.push('CSProtoStateUpdateBC', { move_msg: { map_id: m.map_id, move: [confirmed] } })
    })
    on('DayWeatherSync', (c, r) => {
        ensure(r.weather > 0, 'Invalid weather')
        c.state.world.weather = r.weather
        return { weather: r.weather }
    })
    on('WorldMapPlayerMountStatus', (c, r) => {
        ensure(r.u32 <= 10)
        c.state.world.mount_status = r.u32
        if (c.state.world.status === 1) playerStatusSync(c, 17)
        return {}
    })
    on('WorldMapPlayerStatus', (c, r) => {
        ensure(Number.isInteger(r.status) && r.status >= 0 && r.status < 6, 'Invalid player status')
        const w = c.state.world,
            arg = String(r.arg ?? '0'),
            previousMount = w.mount
        if (r.status === 1) {
            delete w.pendingMountExit
            const mount = pet(c.state, arg)
            ensure(!mount.work_status, 'Stationed pet cannot be mounted')
            w.mount = mount.guid
            if (c.state.mountRideId !== mount.guid) {
                c.state.mountRideId = mount.guid
                c.push('CSProtoRideMountInfo', mountPayload(c.tables, c.state))
            }
        } else {
            w.mount = '0'
            w.mount_status = 0
        }
        w.status = r.status
        w.status_arg = arg
        w.mountSyncVersion = 1
        if (w.mount !== previousMount) playerStatusSync(c, 17)
        playerStatusSync(c, 25)
        return {}
    })
    on('WorldMapPlayerPlayerAction', (c, r) => {
        ensure([1, 2, 3].includes(r.action), 'Invalid mount action')
        const w = c.state.world
        ensure(w.status === 1 && w.mount && w.mount !== '0', 'Player is not mounted')
        pet(c.state, w.mount)
        // TODO: Reconstruct official mount satiety drain/recovery and sync semantics.
        // Until then satiety is intentionally not part of local action validation.
        w.last_mount_action = { action: r.action, time: c.now }
        return {}
    })
}
