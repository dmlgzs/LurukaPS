import test from 'node:test'
import assert from 'node:assert/strict'
import routes from '../configs/cult-trial-routes.json' with { type: 'json' }
import { cultExecutionPlan, validateCultExecutionRun } from '../src/cult-execution.js'
import { ErrorCode } from '../src/error-codes.js'
import {
    cultExecutionFixture,
    cultExecutionTables as tables,
    cultOwnedAssets,
} from './cult-execution-current-fixture.js'

const route305 = () => {
    const route = structuredClone(routes.routes.find((row) => row.trial_id === 305))
    assert(route?.execution, 'current routes candidate must be installed; do not test old third-wave fallback')
    return route
}
function changedTables(change) {
    const rows = new Map()
    const get = (name) => {
        if (!rows.has(name)) rows.set(name, structuredClone(tables.get(name)))
        return rows.get(name)
    }
    const value = { get }
    change?.(get)
    return value
}
const configError = (fn) => assert.throws(fn, (error) => error.code === ErrorCode.GameConfig)
const resultState = (s) => ({
    wave: s.cultTrial.current_wave,
    complete: s.cultTrial.completed_waves,
    score: s.cultTrial.score,
    status: s.cultTrial.status,
    done: s.cultTrial.battle_complete,
    growup: structuredClone(s.activities[60001].growup),
    permanent: structuredClone(s.activities[60001].growupPermanent),
    accepted: structuredClone(s.acceptedCultTrials),
})

test('current runtime plan binds305 execution rows19/20 and keeps meta21 separate without touching legacy304/40', () => {
    const plan = cultExecutionPlan(tables, route305())
    assert.deepEqual(plan.objectIds, [5, 6])
    assert.deepEqual(
        plan.waves.map(({ wave_id, object_ids }) => ({ wave_id, object_ids })),
        [
            { wave_id: 1, object_ids: [5] },
            { wave_id: 2, object_ids: [6] },
        ],
    )
    assert.deepEqual(
        plan.scoreRows.map((row) => row.Id),
        [19, 20],
    )
    assert.deepEqual(
        plan.metadataOnlyWaves.map((row) => [row.wave_id, row.object_ids, row.score.Id]),
        [[3, [7], 21]],
    )
    assert(Object.isFrozen(plan.waves[0].score))
    assert.throws(() => {
        plan.scoreRows[0].eliteScore = 0
    }, TypeError)
    const legacy304 = routes.routes.find((row) => row.trial_id === 304)
    assert.deepEqual(legacy304.object_ids, [5, 6])
    assert.equal(cultExecutionPlan(tables, legacy304), undefined)
    const archive = routes.routes.find((row) => row.trial_id === 306)
    assert.equal(archive.scene_id, 6557)
    assert.equal(archive.object_ids.length, 40)
    assert.equal(cultExecutionPlan(tables, archive), undefined)
})

test('unknown contract/source, overlap, dangling metadata and route drift fail instead of falling back', () => {
    const mutations = [
        (r) => {
            r.execution.kind = 'unknown'
        },
        (r) => {
            r.execution.sourceFingerprint = '1'.repeat(64)
        },
        (r) => {
            r.execution.graphSha256 = '2'.repeat(64)
        },
        (r) => {
            r.execution.blueprint_id = 300311
        },
        (r) => {
            r.execution.scene_id++
        },
        (r) => {
            r.execution.map_id++
        },
        (r) => {
            r.execution.trial_id = 304
        },
        (r) => {
            r.execution.dungeon_id++
        },
        (r) => {
            r.execution.enemyObjectIds.push(7)
            r.object_ids.push(7)
        },
        (r) => {
            r.execution.waveBindings[1].object_ids = [5]
        },
        (r) => {
            r.execution.metadataOnlyWaves[0].object_ids = [6]
        },
        (r) => {
            r.execution.metadataOnlyWaves[0].row_id = 999999
        },
        (r) => {
            r.execution.waveBindings[1].wave_id = 1
        },
    ]
    for (const mutate of mutations) {
        const route = route305()
        mutate(route)
        configError(() => cultExecutionPlan(changedTables(), route))
    }
    for (const change of [
        (get) => {
            get('worldmap_6556').find((r) => r.id === 5).spawnerId = 9999999
        },
        (get) => {
            get('world_enemy_group').find((r) => r.id === 85160).enemyList = '9999999'
        },
        (get) => {
            get('enemy_pack').find((r) => r.id === 20000260).enemyId = 9999999
        },
        (get) => {
            get('dungeon_scene').find((r) => r.id === 6556).blueprintId = 300311
        },
        (get) => {
            get('world_blueprint').find((r) => r.id === 300310).intParam = 'blackBoardEventNum#2'
        },
        (get) => {
            get('game_events_cul_trial_wave').find((r) => r.Id === 19).worldMapId = '5|6'
        },
    ])
        configError(() => cultExecutionPlan(changedTables(change), route305()))
})

test('valid cache cannot hide appended rows or selected enemy drift', () => {
    const view = changedTables(),
        route = route305()
    cultExecutionPlan(view, route)
    view.get('world_spawner').push({ ...view.get('world_spawner')[0], id: 9999999 })
    configError(() => cultExecutionPlan(view, route))
    const another = changedTables(),
        otherRoute = route305()
    cultExecutionPlan(another, otherRoute)
    another.get('world_enemy_group').find((row) => row.id === 85160).enemyList = '9999999'
    configError(() => cultExecutionPlan(another, otherRoute))
})

test('old saved meta IDs can be retained but saved current/completed wave3 is never normalized into a win', () => {
    const plan = cultExecutionPlan(tables, route305())
    const run = {
        trial_id: 305,
        dungeon_id: 32270,
        map_id: 6556,
        object_ids: [5, 6, 7],
        current_wave: 1,
        completed_waves: 0,
        battle_complete: false,
    }
    validateCultExecutionRun(plan, run)
    assert.deepEqual(run.object_ids, [5, 6, 7])
    for (const patch of [
        { current_wave: 3, completed_waves: 2 },
        { current_wave: 2, completed_waves: 3 },
        { current_wave: 2, completed_waves: 0 },
        { current_wave: 1, completed_waves: 1 },
        { current_wave: 0, completed_waves: 1 },
        { execution_fingerprint: 'f'.repeat(64) },
    ]) {
        const bad = { ...structuredClone(run), ...patch },
            before = structuredClone(bad)
        configError(() => validateCultExecutionRun(plan, bad))
        assert.deepEqual(bad, before)
    }
})

test('actual305 uses10705 HP damage for two groups, rolls back codec faults and registers9617 ending exactly once', () => {
    const f = cultExecutionFixture('cult-execution305-current')
    const encode = f.protocol.encode
    try {
        const owned = cultOwnedAssets(f.baseline),
            initialBook = f.baseline.activities[60001].growup.end_data
        f.enter()
        assert.equal(f.state().cultTrial.map_id, 6556)
        assert.deepEqual(f.state().cultTrial.object_ids, [5, 6])
        assert.equal(f.state().cultTrial.current_wave, undefined)
        f.call('MultiCampaignPlayerLoaded')
        assert.equal(f.state().cultTrial.current_wave, 1)
        f.hit(true)
        const wounded = new Map(f.targets().map((e) => [e.uuid, e.hp]))
        f.call('MultiCampaignPlayerLoaded')
        f.reconnect()
        f.call('MultiCampaignPlayerLoaded')
        for (const [id, hp] of wounded)
            assert.equal(f.state().combat.entities[id].hp, hp, 'ready/login must not heal existing actors')
        assert.equal(f.state().cultTrial.current_wave, 1)
        assert.equal(f.state().cultTrial.score, 0)
        assert.throws(() => f.call('CultTrialSwitchStep', { activity_id: 60001, trial_id: 305 }))
        f.hit(true)
        const before = f.state(),
            pending = f.store.pending.get(f.session().id)
        const killFirst = f.damageFrame(f.targets())
        const worldType = f.protocol.byName.get('CSProtoWorldMapSync').rsp
        let faulted = false
        f.protocol.encode = function (type, value) {
            if (type === worldType && value.cmd === 47) {
                faulted = true
                throw Error('cult execution wave codec fault')
            }
            return encode.call(this, type, value)
        }
        assert.throws(() => f.dispatch(killFirst), /wave codec fault/)
        assert(faulted)
        assert.deepEqual(f.state(), before)
        assert.strictEqual(f.store.pending.get(f.session().id), pending)
        f.protocol.encode = encode
        f.dispatch(killFirst)
        let s = f.state()
        assert.equal(s.cultTrial.completed_waves, 1)
        assert.equal(s.cultTrial.current_wave, 2)
        assert.equal(s.cultTrial.score, 2250)
        assert(s.worldObjects['6556:5'].complete)
        assert(!s.worldObjects['6556:7'])
        const stable = resultState(s)
        f.dispatch(killFirst)
        assert.deepEqual(resultState(f.state()), stable, 'old damage does not advance or pay another wave')
        f.hit()
        s = f.state()
        assert.equal(s.cultTrial.battle_complete, true)
        assert.equal(s.cultTrial.completed_waves, 2)
        assert.equal(s.cultTrial.current_wave, 2)
        assert.equal(s.cultTrial.score, 5250)
        assert.equal(s.cultTrial.status, 3)
        assert(!s.worldObjects['6556:7'])
        const finalResult = s.activities[60001].growup.trails.find((r) => r.trail_id === 305)
        assert.equal(finalResult.score, '5250')
        assert.equal(s.acceptedCultTrials[f.guid + ':305'], undefined)
        assert.equal(Object.keys(s.activities[60001].growupPermanent.endings).length, 4)
        const finish = f.request('CultTrialSwitchStep', { activity_id: 60001, trial_id: 305 }),
            beforeFinish = f.state()
        const rosterType = f.protocol.byName.get('CSProtoSyncGrowupExcultivationAssistCharData').rsp
        faulted = false
        f.protocol.encode = function (type, value) {
            if (type === rosterType) {
                faulted = true
                throw Error('cult execution ending codec fault')
            }
            return encode.call(this, type, value)
        }
        assert.throws(() => f.dispatch(finish), /ending codec fault/)
        assert(faulted)
        assert.deepEqual(f.state(), beforeFinish)
        f.protocol.encode = encode
        assert(f.dispatch(finish).some((p) => p.id === 9617 && p.seq === finish.seq))
        s = f.state()
        assert.equal(s.acceptedCultTrials[f.guid + ':305'], true)
        assert.equal(s.activities[60001].growupPermanent.endings[f.guid].ending_id, 105)
        assert.equal(s.activities[60001].growupPermanent.endings[f.guid].source, 'trial-completion')
        assert.equal(Object.keys(s.activities[60001].growupPermanent.endings).length, 5)
        assert.equal(s.activities[60001].growup.end_data.complete_end.length, initialBook.complete_end.length + 1)
        const earned = structuredClone(s.activities[60001])
        f.dispatch(finish)
        f.reconnect()
        assert.deepEqual(f.state().activities[60001].growupPermanent, earned.growupPermanent)
        assert.deepEqual(f.state().activities[60001].growup.end_data, earned.growup.end_data)
        f.call('WorldPoint', { point_id: 0 })
        assert.equal(f.state().cultTrial, undefined)
        assert.equal(f.state().world.map_id, f.baseline.world.map_id)
        assert.deepEqual(cultOwnedAssets(f.state()), owned)
    } finally {
        f.protocol.encode = encode
        f.close()
    }
})

test('actual305 rejects an impossible old current_wave3 on ready and login without repairing or registering it', () => {
    const f = cultExecutionFixture('cult-execution305-oldwave')
    try {
        f.enter()
        f.call('MultiCampaignPlayerLoaded')
        f.edit((s) => {
            Object.assign(s.cultTrial, { current_wave: 3, completed_waves: 2, battle_complete: false, status: 2 })
        })
        const bad = f.state()
        configError(() => f.call('MultiCampaignPlayerLoaded'))
        assert.deepEqual(f.state(), bad)
        configError(() => f.reconnect())
        assert.deepEqual(f.state(), bad)
        assert.equal(f.state().acceptedCultTrials[f.guid + ':305'], undefined)
        assert.equal(f.state().activities[60001].growup.trails.length, 2)
        assert.equal(Object.keys(f.state().activities[60001].growupPermanent.endings).length, 4)
    } finally {
        f.close()
    }
})
