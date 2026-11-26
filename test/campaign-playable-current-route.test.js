import test from 'node:test'
import assert from 'node:assert/strict'
import { Tables } from '../src/player.js'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ensureStoryCampaignScene, storyCampaignConfig } from '../src/story-campaign.js'
import { localPlayableCampaignRoute, localCampaignSatisfied } from '../src/campaign-playable-route.js'
import {
    currentPlayableCampaignCondition,
    currentPlayableCampaignRoute,
    currentPlayableCampaignCount,
    currentPlayableCampaignSatisfied,
} from '../src/campaign-playable-current-route.js'
import { clearCampaignPlayables, resetCampaignPlayableEntry } from '../src/campaign-playable-ledger.js'
import { ErrorCode } from '../src/error-codes.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    dungeon = tables.find('dungeon', 10074)
function changed(name, transform) {
    return {
        dir: tables.dir,
        get(table) {
            return table === name ? transform(tables.get(table)) : tables.get(table)
        },
        find(table, id) {
            return this.get(table).find((row) => row.id === Number(id))
        },
        position: tables.position.bind(tables),
    }
}
const withScene = (patch) =>
    changed('dungeon_scene', (rows) => rows.map((row) => (row.id === 6226 ? { ...row, ...patch } : row)))
function campaign(instance = 71) {
    const route = currentPlayableCampaignRoute(tables, dungeon)
    return {
        dungeon_id: 10074,
        group_id: dungeon.groupId,
        difficulty: dungeon.dungeonGroupOrder,
        instance_id: instance,
        map_id: route.scene_ids[0],
        scenes: route.scene_ids,
        completed_scenes: [],
        task_ids: [],
        stage_conditions: true,
        stage_index: 0,
        status: 2,
        start_time: 1800000000,
        local_playable_condition: route.local_condition,
        playable_ids: route.playable_ids,
        playable_successes: {},
        next_playable_attempt: 0,
        opening_story: route.opening_stories[0],
        ending_story: route.ending_story,
        opening_delete_tag: route.delete_tag,
    }
}

test('current10074 binds2525 to the unique current playable placement and current scene/trial graph without a CBT3 rewrite', () => {
    assert.equal(dungeon.victoryCondition, '2525#62071#1')
    const route = currentPlayableCampaignRoute(tables, dungeon),
        parsed = storyCampaignConfig(tables, 222, 1)
    assert.deepEqual(route.local_condition, [2525, 62071, 1])
    assert.deepEqual(route.scene_ids, [6226])
    assert.equal(route.playable_object_id, 1000010)
    assert.equal(route.trial_group_id, 6226)
    assert.deepEqual(route.target_ids, [1000011])
    assert.deepEqual(parsed.localPlayableRoute, route)
    assert.deepEqual(localPlayableCampaignRoute(tables, dungeon), route)
    assert.deepEqual(
        currentPlayableCampaignRoute(tables, { ...dungeon, enemy: '310001#1' }),
        route,
        'preview enemy metadata is not a synthesized puzzle roster',
    )
    assert.equal(currentPlayableCampaignRoute(tables, { ...dungeon, id: 10075 }), null)
    assert.throws(
        () => currentPlayableCampaignCondition('13060#6226#0#1'),
        (error) => error.code === ErrorCode.FunctionClosed,
    )
    assert.throws(
        () => currentPlayableCampaignCondition('2525#62071#2'),
        (error) => error.code === ErrorCode.FunctionClosed,
    )
    for (const text of [
        undefined,
        '',
        '2525#62071',
        '2525#62071#1#2',
        '2525#062071#1',
        '2525#62071#0',
        '2525#62071#1.5',
    ])
        assert.throws(
            () => currentPlayableCampaignCondition(text),
            (error) => error.code === ErrorCode.GameConfig,
        )
})

test('current route rejects damaged references, ambiguous placements, unknown graph variants and missing declared current maps', () => {
    const code = (source, expected) =>
        assert.throws(
            () => currentPlayableCampaignRoute(source, dungeon),
            (error) => error.code === expected,
        )
    code(
        changed('playable', (rows) => rows.filter((row) => row.id !== 62071)),
        ErrorCode.GameConfig,
    )
    code(
        changed('playable', (rows) => [...rows, rows.find((row) => row.id === 62071)]),
        ErrorCode.GameConfig,
    )
    code(
        changed('playable', (rows) => rows.map((row) => (row.id === 62071 ? { ...row, stepMax: 0 } : row))),
        ErrorCode.FunctionClosed,
    )
    code(
        changed('worldmap_6200', (rows) => [
            ...rows,
            { ...tables.get('worldmap_6226').find((row) => row.expandId === 62071), id: 9000001, cityId: 6200 },
        ]),
        ErrorCode.GameConfig,
    )
    code(
        changed('worldmap_6226', (rows) => rows.filter((row) => row.expandId !== 62071)),
        ErrorCode.InstanceSceneConfNotExist,
    )
    code(withScene({ mapId: 100 }), ErrorCode.InstanceSceneConfNotExist)
    code(
        changed('world_blueprint', (rows) => rows.filter((row) => row.id !== 300306)),
        ErrorCode.InstanceSceneConfNotExist,
    )
    code(withScene({ serverBlueprintId: 300351 }), ErrorCode.FunctionClosed)
    code(withScene({ stringParam: '' }), ErrorCode.GameConfig)
    code(
        withScene({ stringParam: 'finish_con_word_1#x|finish_con_intlist_1#2500,6021403,0,999999,1' }),
        ErrorCode.GameConfig,
    )
    code(withScene({ trialsId: 0 }), ErrorCode.GameConfig)
    code(
        changed('heropet_interim_group', (rows) => rows.filter((row) => row.id !== 6226)),
        ErrorCode.GameConfig,
    )
    code(
        changed('hero_interim', (rows) => rows.filter((row) => row.id !== 2108103)),
        ErrorCode.GameConfig,
    )
    code(
        changed('world_borthpos', (rows) => rows.filter((row) => row.cityId !== 6226 || row.mainPoint !== 1)),
        ErrorCode.NotFoundBirthPoint,
    )
    const missing = changed('worldmap_6226', () => {
        throw Error('declared current map missing')
    })
    assert.throws(() => currentPlayableCampaignRoute(missing, dungeon), /declared current map missing/)
})

test('current2525 progress accepts only an actual same-instance accepted finish receipt and never upgrades old flags', () => {
    const state = {
        world: { map_id: 6226 },
        storyCampaign: campaign(),
        playableFinishes: { 62071: { play_id: 62071, map_id: 6226 } },
        player: { retainedAsset: 9 },
    }
    assert.equal(currentPlayableCampaignCount(tables, state), 0)
    state.storyCampaign.next_playable_attempt = 1
    state.storyCampaign.playable_successes[62071] = { instance_id: 71, attempt_id: 1, map_id: 6226, play_id: 62071 }
    const saved = structuredClone(state)
    assert.equal(currentPlayableCampaignSatisfied(tables, state), true)
    assert.equal(localCampaignSatisfied(tables, state), true)
    assert.deepEqual(state, saved)
    for (const patch of [{ instance_id: 70 }, { map_id: 6225 }, { play_id: 62072 }]) {
        const foreign = structuredClone(saved)
        Object.assign(foreign.storyCampaign.playable_successes[62071], patch)
        assert.equal(currentPlayableCampaignCount(tables, foreign), 0)
    }
    const bad = structuredClone(saved)
    bad.storyCampaign.playable_successes[62071].attempt_id = 0
    assert.throws(
        () => currentPlayableCampaignCount(tables, bad),
        (error) => error.code === ErrorCode.GameConfig,
    )
    const old = structuredClone(saved)
    old.storyCampaign.local_playable_condition = [13060, 6226, 0, 1]
    assert.throws(
        () => currentPlayableCampaignCount(tables, old),
        (error) => error.code === ErrorCode.InvalidLogic,
    )
    const outside = structuredClone(saved)
    outside.world.map_id = 100
    assert.equal(currentPlayableCampaignCount(tables, outside), 0)
})

test('actual62071 Start-Step-Finish creates one current proof, rolls back publication failure, and preserves score claims on a new instance', () => {
    const protocol = new Protocol(cfg.base),
        store = new Store(':memory:'),
        session = {},
        game = new Game(protocol, store, tables, { clock: () => 1800000000 })
    let seq = 1
    const frame = (name, request = {}) => {
            const entry = protocol.byName.get('CSProto' + name)
            assert(entry)
            return { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, request) }
        },
        dispatch = (request) => game.dispatch(session, request),
        call = (name, request) => dispatch(frame(name, request)),
        state = () => store.load(session.id).state,
        edit = (fn) => store.transact(session.id, 0, fn)
    try {
        call('EnterGame', { open_id: 'current10074-playable-proof' })
        // Trusted active-instance fixture, not a claim of CampaignCreate/roster
        // entry coverage. The scene integration owner tests that whole route.
        edit((s) => {
            s.tasks = []
            Object.assign(
                s.world,
                tables.position(
                    tables.get('world_borthpos').find((point) => point.cityId === 6226 && point.mainPoint === 1),
                ),
            )
            s.storyCampaign = campaign()
            s.playableFinishes = { 62071: { play_id: 62071, map_id: 6226, reward_info: 2 } }
            s.playableScoreClaims = { 62071: 4 }
            ensureStoryCampaignScene(tables, s, 1800000000)
        })
        const start = frame('PlayableStart', { u32: 62071 }),
            bag = state().player.sbag_infos
        dispatch(start)
        const running = state().playableRuns[62071]
        assert.equal(running.campaign_instance_id, 71)
        assert.equal(running.campaign_attempt_id, 1)
        assert.equal(state().playableScoreClaims[62071], 6)
        assert.equal(currentPlayableCampaignCount(tables, state()), 0)
        dispatch(start)
        assert.deepEqual(state().playableRuns[62071], running)
        assert.deepEqual(state().player.sbag_infos, bag)
        assert.throws(() => call('PlayableFinish', { playId: 62071, score: 0 }), /completed its steps/)
        call('PlayableStep', { playId: 62071, is_step: true, finish_step: 1 })
        assert.equal(currentPlayableCampaignCount(tables, state()), 0)
        const finish = frame('PlayableFinish', { playId: 62071, score: 0 }),
            before = state(),
            encode = protocol.encode,
            info = protocol.byName.get('CSProtoCampaignInfoSync')
        protocol.encode = function (name, value) {
            if (name === info.rsp) throw Error('current-playable-campaign-sync')
            return encode.call(this, name, value)
        }
        try {
            assert.throws(() => dispatch(finish), /current-playable-campaign-sync/)
        } finally {
            protocol.encode = encode
        }
        assert.deepEqual(state(), before)
        const packets = dispatch(finish)
        assert(packets.some((packet) => packet.id === info.id))
        assert.equal(state().storyCampaign.status, 3)
        assert.equal(currentPlayableCampaignCount(tables, state()), 1)
        assert.equal(Object.keys(state().storyCampaign.playable_successes).length, 1)
        const completed = state()
        dispatch(finish)
        assert.deepEqual(state().player, completed.player)
        assert.deepEqual(state().storyCampaign.playable_successes, completed.storyCampaign.playable_successes)
        edit((s) => {
            clearCampaignPlayables(s, s.storyCampaign)
            s.storyCampaign = campaign(72)
            resetCampaignPlayableEntry(s, s.storyCampaign)
        })
        assert.equal(currentPlayableCampaignCount(tables, state()), 0)
        assert.equal(state().playableScoreClaims[62071], 6)
        assert.deepEqual(state().player.sbag_infos, completed.player.sbag_infos)
    } finally {
        store.close()
    }
})
