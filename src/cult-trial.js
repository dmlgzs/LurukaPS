import { ErrorCode } from './error-codes.js'
import { visibleEnemySlots } from './enemy-group-visibility.js'
import fs from 'node:fs'
import { ensure } from './handlers/common.js'
import { combatState } from './combat-state.js'
import { enemyDefinition } from './enemy-state.js'
import { WorldObjectCatalog } from './world-objects.js'
import { completedEnemyGroup } from './enemy-group-completion.js'
import { activityTables } from './activity-tables.js'
import { recordCultArchiveResult, cultArchiveEnemyDefinition } from './cult-archive-trial.js'
import { growupArchiveSnapshot } from './growup-archive.js'
import { recordCultTrialHistory } from './cult-trial-history.js'
const routes = new Map(
    JSON.parse(fs.readFileSync(new URL('../configs/cult-trial-routes.json', import.meta.url))).routes.map((x) => [
        x.trial_id,
        x,
    ]),
)
const waveTables = new WeakMap()
const scoreTables = new WeakMap()
function currentTables(tables) {
    let current = scoreTables.get(tables)
    if (!current) scoreTables.set(tables, (current = activityTables(tables)))
    return current
}
export function cultTrialStarMask(goals, score) {
    const thresholds = String(goals).split('|').map(Number)
    ensure(
        thresholds.length <= 31 && thresholds.every((x) => Number.isSafeInteger(x) && x >= 0),
        'Invalid cultivation score goals',
        ErrorCode.GameConfig,
    )
    return thresholds.reduce((mask, goal, index) => mask + (score >= goal ? 2 ** index : 0), 0)
}
export function refreshCultTrialResult(tables, state) {
    const run = state.cultTrial
    if (!run || run.map_id !== state.world.map_id || !run.current_wave) return false
    const current = currentTables(tables),
        trial = current.get('game_events_cul_trial').find((x) => x.trialId === run.trial_id),
        growup = run.archive ?? state.activities[run.activity_id].growup
    if (!run.score_rate) {
        const total = growup.growup_train_attr.reduce((n, x) => n + x.attr_value, 0)
        let rank = current.get('game_events_cul_rank')[0]
        for (const row of current.get('game_events_cul_rank')) if (total > row.needTotalAttr) rank = row
        run.score_rate = rank.coefficient
    }
    let base = 0
    for (const wave of current.get('game_events_cul_trial_wave').filter((x) => x.trialId === run.trial_id)) {
        const objects = String(wave.worldMapId).split('|').map(Number)
        for (const id of objects) {
            const members = Object.values(state.combat?.entities ?? {}).filter(
                (x) => x.object_id === id && x.hp === 0 && x.alive_state === 1 && !x.captured,
            )
            for (const member of members) {
                const type = tables.find('enemy', member.config_id)?.enemyType
                ensure([1, 2, 3].includes(type), 'Unknown cultivation scoring enemy type', ErrorCode.GameConfig)
                base += wave[type === 1 ? 'bossScore' : type === 2 ? 'eliteScore' : 'commonScore']
            }
        }
        if (wave.waveId <= (run.completed_waves ?? 0)) base += wave.waveScore
    }
    const score = Math.trunc((base * run.score_rate) / 10000),
        old = run.score
    run.score = score
    if (run.battle_complete) {
        if (run.archive_id) {
            run.star_mask = 0
            run.star = 0
            run.attr_changes = []
            if (run.status === 2) run.status = 3
            return old !== score
        }
        run.star_mask = cultTrialStarMask(trial.goal, score)
        run.star = String(trial.goal)
            .split('|')
            .map(Number)
            .filter((goal) => score >= goal).length
        run.status = run.star > 0 ? 3 : 4
        run.attr_changes = []
        if (run.star) {
            const effect = current
                .get('game_events_cul_effect')
                .find((x) => x.Id === Number(String(trial.effect1).split('|')[run.star - 1]))
            ensure(effect?.type === 3, 'Cultivation trial reward effect unavailable', ErrorCode.GameConfig)
            run.attr_changes = String(effect.param)
                .split('|')
                .map((x) => {
                    const [attr_id, attr_value, source] = x.split('#').map(Number)
                    ensure(
                        source === 3 && growup.growup_train_attr.some((x) => x.attr_id === attr_id),
                        'Unsupported cultivation trial attribute reward',
                        ErrorCode.GameConfig,
                    )
                    return { attr_id, attr_value }
                })
        }
    }
    return old !== score
}
export function cultTrialRoute(tables, catalog, activityId, trialId) {
    const activity = catalog.rows.find((x) => x.id === activityId && x.type === 60)
    const trial = catalog.tables
        .get('game_events_cul_trial')
        .find((x) => x.trialId === trialId && x.systemId === activity?.systemId)
    ensure(trial, 'Trial does not belong to cultivation activity')
    const route = routes.get(trialId),
        dungeon = route && tables.find('dungeon', route.dungeon_id),
        city = route && tables.find('world_city', route.scene_id),
        point = route && tables.find('world_borthpos', route.point_id)
    ensure(
        route && trial.dungeonId === dungeon?.id && city?.type === 27 && point?.cityId === city.id,
        'Cultivation trial scene mapping unavailable',
        ErrorCode.InstanceSceneConfNotExist,
    )
    return { activity, trial, route, dungeon, point }
}
export function cultTrialSnapshot(state, { entering = false } = {}) {
    const run = state.cultTrial
    return {
        start_time: run.start_time,
        real_start_time: run.real_start_time ?? run.start_time,
        status: entering ? 2 : run.status,
        dungeon_id: run.dungeon_id,
        cur_scene_id: run.map_id,
        dungeon_instance_id: run.instance_id,
        score: run.score ?? 0,
        // CampaignInfo uses per-condition bits; GrowUpTrailData and reward
        // selection use the count stored in run.star instead.
        star: entering ? 0 : (run.star_mask ?? 0),
        star_values: [run.score ?? 0, run.score ?? 0, run.score ?? 0],
        win_values: [run.completed_waves ?? 0],
        lose_values: [0, 0],
        waves: entering ? 0 : (run.current_wave ?? 0),
        scene_datas: [{ scene_id: run.map_id, scene_status: 0, cur_step: 0, objs: run.scene_objects ?? [] }],
    }
}
export function ensureCultTrialScene(tables, state, now) {
    const run = state.cultTrial
    if (!run || state.world.map_id !== run.map_id) return false
    if (run.archive_id && run.status === 2 && run.real_start_time && !run.battle_complete) {
        const timed = String(tables.find('dungeon', run.dungeon_id)?.failCondition ?? '')
                .split('||')
                .find((text) => text.startsWith('2901#')),
            limit = timed ? Number(timed.split('#')[1]) : 0
        if (limit > 0 && now - run.real_start_time >= limit) {
            run.status = 4
            run.battle_complete = true
            run.end_time = now
        }
    }
    const world = new WorldObjectCatalog(tables),
        rows = world.get('worldmap_' + run.map_id),
        records = (state.worldObjects ??= {})
    if (!run.initialized) {
        for (const key of Object.keys(records)) if (key.startsWith(run.map_id + ':')) delete records[key]
        delete state.combat
        run.initialized = true
    }
    const battle = combatState(state, now)
    const waves = cultTrialWaves(tables, run)
    for (const row of rows) {
        const key = run.map_id + ':' + row.id,
            values = String(row.position)
                .split('|')
                .map((x) => Math.round(Number(x) * 100))
        ensure(
            values.length === 3 && values.every(Number.isFinite),
            'Invalid cultivation trial object position',
            ErrorCode.GameConfig,
        )
        const record = (records[key] ??= {
            obj_id: row.id,
            active: row.initStatus !== 1,
            complete: false,
            pos: { x: values[0], y: values[1], z: values[2] },
            state_data: { step: 0, complete: false },
            time: run.start_time,
            next_time: 0,
        })
        // Also repair an older cached object, not just a newly-created row.
        record.time = run.start_time
        record.next_time = 0
        if (!run.object_ids.includes(row.id)) continue
        const wave = waves.find((x) => x.object_ids.includes(row.id))
        record.complete = !!wave && wave.wave_id <= (run.completed_waves ?? 0)
        record.active =
            !!wave && wave.wave_id === run.current_wave && !record.complete && (!run.archive_id || !run.battle_complete)
        record.state_data = { ...record.state_data, complete: record.complete }
        const group = tables.find('world_enemy_group', row.expandId),
            packs = String(group?.enemyList ?? '')
                .split('|')
                .filter(Boolean)
        ensure(packs.length, 'Missing cultivation trial enemy group', ErrorCode.NoEnemyConf)
        const monsters = packs.map((_, slot) => {
            const uid = ((3n << 56n) | (BigInt(slot) << 32n) | BigInt(row.id)).toString(),
                definition = cultArchiveEnemyDefinition(tables, run, enemyDefinition(tables, state, uid))
            ensure(definition, 'Missing cultivation trial enemy attributes', ErrorCode.NoEnemyConf)
            const entity = (battle.entities[uid] ??= {
                uuid: uid,
                ...definition,
                hp: definition.max_hp,
                sp: 0,
                alive_state: 0,
                updated_at: now,
            })
            return {
                uid,
                obj_type: 3,
                id: definition.config_id,
                enemy_pack: definition.pack_id,
                level: definition.level,
                hp: entity.hp,
                obj_key: { obj_id: row.id, obj_index: slot, group_id: row.expandId },
                move: { pos: record.pos, move_status: 1, area_id: state.world.area_id },
            }
        })
        record.expand_data = {
            battle_group: { monsters, world_indexes: visibleEnemySlots(monsters, battle.entities) },
        }
    }
    refreshCultTrialResult(tables, state)
    if (run.battle_complete && run.status === 3) {
        // The scene's tagged chest is created by the client's victory graph.
        // Keep its server snapshot active so refresh cannot hide it again.
        for (const row of rows)
            if (
                world.find('world_spawner', row.spawnerId)?.objectType === 30 &&
                String(row.commonTag).split('|').includes('0')
            )
                records[run.map_id + ':' + row.id].active = !records[run.map_id + ':' + row.id].complete
    }
    run.scene_objects = rows.map((x) => {
        const { claims, ...wire } = records[run.map_id + ':' + x.id]
        return wire
    })
    return true
}

function cultTrialWaves(tables, run) {
    let rows = waveTables.get(tables)
    if (!rows) waveTables.set(tables, (rows = activityTables(tables).get('game_events_cul_trial_wave')))
    const waves = rows
        .filter((row) => row.trialId === run.trial_id)
        .sort((a, b) => a.waveId - b.waveId)
        .map((row) => ({
            wave_id: row.waveId,
            object_ids: String(row.worldMapId).split('|').filter(Boolean).map(Number),
        }))
    ensure(
        waves.length &&
            waves.every((wave) => wave.object_ids.length && wave.object_ids.every((id) => run.object_ids.includes(id))),
        'Cultivation trial wave configuration unavailable',
        ErrorCode.GameConfig,
    )
    return waves
}

export function syncCultTrialWave(c) {
    const run = c.state.cultTrial
    ensureCultTrialScene(c.tables, c.state, c.now)
    if (run.archive_id && run.battle_complete) publishCultTrialResult(c)
    pushCultTrialLiveScore(c)
    if (run.attr_changes?.length)
        c.push('CSProtoActivityGrowUpAttrChangeSync', {
            activity_id: run.activity_id,
            change_type: 3,
            growup_attr_change: run.attr_changes,
        })
    c.push('CSProtoCampaignInfoSync', cultTrialSnapshot(c.state))
    c.push('CSProtoWorldMapSync', {
        cmd: 47,
        creator_id: c.id,
        map_id: run.map_id,
        map_info: { creator_id: c.id, map_id: run.map_id, objs: run.scene_objects },
    })
    const infos = []
    for (const object of run.scene_objects.filter((x) => x.active && run.object_ids.includes(x.obj_id))) {
        const monsters = object.expand_data.battle_group.monsters.filter((x) => x.hp > 0)
        if (!monsters.length) continue
        // SinglePlayerDungeon owns its static groups locally. Multiplayer AOI
        // appear/control messages are rejected by the CBT3 client in mode 5.
        infos.push(...monsters.map((x) => ({ uuid: x.uid, hp: x.hp, sp: 0, alive_state: 0, reason: 1 })))
    }
    if (infos.length) c.push('CSProtoObjBattleInfoSync', { infos })
}
function pushCultTrialLiveScore(c) {
    const run = c.state.cultTrial
    if (run.status === 2)
        c.push('CSProtoCampaignChallengeTagsNtf', { tags_list: [{ tag_progress: String(run.score ?? 0) }] })
}

export function startCultTrialBattle(c) {
    const run = c.state.cultTrial
    ensure(
        run && run.map_id === c.state.world.map_id && [2, 3, 4].includes(run.status),
        'No active cultivation trial loading',
    )
    if (!run.current_wave && !run.battle_complete) {
        run.current_wave = cultTrialWaves(c.tables, run)[0].wave_id
        run.real_start_time = c.now
    }
    run.loading_complete_at ??= c.now
    if (run.battle_complete) {
        if (run.archive_id) publishCultTrialResult(c)
        else c.activityCatalog.notify({ ...c, pushBefore: c.push }, true)
    }
    syncCultTrialWave(c)
}

export function advanceCultTrialCombat(c) {
    const run = c.state.cultTrial
    if (!run || run.map_id !== c.state.world.map_id || run.status !== 2 || !run.current_wave || run.battle_complete)
        return false
    const waves = cultTrialWaves(c.tables, run),
        position = waves.findIndex((x) => x.wave_id === run.current_wave),
        wave = waves[position]
    if (
        !wave ||
        !wave.object_ids.every((id) => completedEnemyGroup(c.tables, c.state, ((3n << 56n) | BigInt(id)).toString()))
    ) {
        if (refreshCultTrialResult(c.tables, c.state)) {
            pushCultTrialLiveScore(c)
            c.push('CSProtoCampaignInfoSync', cultTrialSnapshot(c.state))
        }
        return false
    }
    // Fork only the few scene records on a completed wave. Ordinary hits keep
    // the existing in-memory combat path and do not persist or copy the world.
    c.state.worldObjects = { ...c.state.worldObjects }
    for (const id of run.object_ids) {
        const key = run.map_id + ':' + id
        c.state.worldObjects[key] = { ...c.state.worldObjects[key] }
    }
    run.completed_waves = wave.wave_id
    if (waves[position + 1]) run.current_wave = waves[position + 1].wave_id
    else {
        run.battle_complete = true
        run.end_time = c.now
    }
    ensureCultTrialScene(c.tables, c.state, c.now)
    publishCultTrialResult(c)
    syncCultTrialWave(c)
    return true
}

export function recordCultTrialResult(tables, state) {
    const run = state.cultTrial
    if (!run?.battle_complete || run.result_published) return false
    if (run.archive_id) return recordCultArchiveResult(state)
    const trial = currentTables(tables)
        .get('game_events_cul_trial')
        .find((x) => x.trialId === run.trial_id)
    state.activities = { ...state.activities }
    const entry = (state.activities[run.activity_id] = { ...state.activities[run.activity_id] })
    const g = (entry.growup = structuredClone(entry.growup))
    g.trails[trial.phase - 1] = {
        trail_id: run.trial_id,
        star: run.star,
        score: String(run.score),
        rate: run.score_rate,
        guid: g.guid,
    }
    recordCultTrialHistory(entry, trial, g.trails[trial.phase - 1])
    run.result_published = true
    return true
}
export function publishCultTrialResult(c) {
    if (recordCultTrialResult(c.tables, c.state)) {
        if (c.state.cultTrial.archive_id)
            c.push(
                'CSProtoSyncArchiveGrowupData',
                growupArchiveSnapshot(c.activityCatalog, c.state, [c.state.cultTrial.activity_id]),
            )
        else {
            c.activityCatalog.notify({ ...c, pushBefore: c.push }, true)
            c.push(
                'CSProtoSyncArchiveGrowupData',
                growupArchiveSnapshot(c.activityCatalog, c.state, [c.state.cultTrial.activity_id]),
            )
        }
    }
}
