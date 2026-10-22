import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { Protocol } from '../src/protocol.js'
import { trainingFailureRate } from '../src/growup.js'
import { cultTrialStarMask, cultTrialRoute, ensureCultTrialScene } from '../src/cult-trial.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    p = new Protocol(cfg.base)
test('old final-day selection is repaired in the client snapshot and explicit final selection can enter its configured scene', () => {
    const f = fixture()
    try {
        f.start()
        f.store.transact(f.session.id, 0, (s) => {
            const g = s.activities[60001].growup
            Object.assign(g, {
                cur_stage: 3,
                cur_growup_stage: 13,
                cur_growup_trail_stage: 3,
                select_trail_id: 201,
                final_score: '1000',
            })
            g.trails = [
                { trail_id: 101, star: 2, score: '4500' },
                { trail_id: 201, star: 2, score: '4840' },
            ]
            s.tasks = []
            s.taskRecords = tables.get('task').map((x) => ({ task_id: x.id, count: 1 }))
            Object.assign(s.world, tables.position(tables.find('world_borthpos', 10100101)))
        })
        const history = structuredClone(f.g().trails)
        const wire = f.decode(f.call('ActivityGet'), 'CSProtoActivitySync').activitys.find((x) => x.id === 60001)
            .data.grow_up
        assert.equal(wire.select_trail_id, 0)
        assert.equal(wire.cur_growup_trail_stage, 3)
        assert.throws(() => f.call('EnterCultTrial', { activity_id: 60001, trial_id: 201 }), /not ready/)
        f.call('SelectCultTrial', { activity_id: 60001, trial_id: 301 })
        f.call('ActivityGet')
        assert.equal(f.g().select_trail_id, 301)
        assert.deepEqual(f.g().trails, history)
        assert.equal(f.g().final_score, '1000')
        f.call('EnterCultTrial', { activity_id: 60001, trial_id: 301 })
        assert.equal(f.state().world.map_id, 6552)
        assert.equal(f.state().cultTrial.trial_id, 301)
    } finally {
        f.store.close()
    }
})
test('CBT3 travel entrance sends its first option directly and cannot skip steps or charge it twice', () => {
    const f = fixture()
    try {
        f.start()
        const before = f.g()
        assert.throws(
            () => f.call('ActivityGrowUpEventSelectReq', { activity_id: 60001, event_id: 1001, optional_id: 100101 }),
            /does not belong/,
        )
        assert.deepEqual(f.g(), before, 'A later-step option must not create an active event')
        const request = { activity_id: 60001, event_id: 1005, optional_id: 100500 }
        const packets = f.call('ActivityGrowUpEventSelectReq', request)
        const reply = f.decode(packets, 'CSProtoActivityGrowUpEventSelectReq')
        assert.equal(reply.optional_id, 100500)
        assert.equal(reply.is_identify_success, true)
        assert.equal(f.g().cur_event_data.cur_step, 50102)
        assert.equal(f.g().cur_cost_expedition_count, 1)
        const after = f.g()
        assert.throws(() => f.call('ActivityGrowUpEventSelectReq', request), /does not belong/)
        assert.deepEqual(f.g(), after)
        f.call('EnterGame', { open_id: 'growup-test' }, {})
        assert.equal(
            f.decode(f.call('ActivityGrowUpEventInfoReq', { activity_id: 60001 }), 'CSProtoActivityGrowUpEventInfoReq')
                .cur_step,
            50102,
        )
        f.call('ActivityGrowUpEventSelectReq', { activity_id: 60001, event_id: 1005, optional_id: 0 })
        assert.equal(f.g().cur_event_data.cur_step, 50103)
        assert.equal(f.g().cur_cost_expedition_count, 1)
    } finally {
        f.store.close()
    }
})
test('completed legacy cultivation presentation returns to the saved village on WorldPoint', () => {
    const f = fixture()
    try {
        f.start()
        f.store.transact(f.session.id, 0, (s) => {
            s.tasks = []
            s.taskRecords = tables.get('task').map((x) => ({ task_id: x.id, count: 1 }))
            Object.assign(s.activities[60001].growup, { cur_stage: 4, cur_growup_trail_stage: 4 })
            Object.assign(s.world, tables.position(tables.find('world_borthpos', 10100101)))
            const village = tables.position(tables.find('world_borthpos', 20005))
            village.pos.z += 321
            s.worldHistory = [village]
        })
        const saved = structuredClone(f.state().worldHistory[0])
        const packets = f.call('WorldPoint', { point_id: 0 })
        assert.equal(f.decode(packets, 'CSProtoWorldMapSync').map_id, 200)
        assert.deepEqual(f.state().world.pos, saved.pos)
        assert.equal(f.g().cur_stage, 4)
    } finally {
        f.store.close()
    }
})
test('completed cultivation return without a valid entrance rolls back', () => {
    const f = fixture()
    try {
        f.start()
        f.store.transact(f.session.id, 0, (s) => {
            Object.assign(s.activities[60001].growup, { cur_stage: 4, cur_growup_trail_stage: 4 })
            Object.assign(s.world, tables.position(tables.find('world_borthpos', 10100101)))
            s.worldHistory = []
        })
        const saved = f.state()
        assert.throws(() => f.call('WorldPoint', { point_id: 0 }), /return context unavailable/)
        assert.deepEqual(f.state().world, saved.world)
        assert.deepEqual(f.g(), saved.activities[60001].growup)
    } finally {
        f.store.close()
    }
})
test('campaign score goals use independent bits while cultivation rewards retain star counts', () => {
    for (const [score, mask] of [
        [2999, 0],
        [3000, 1],
        [4499, 1],
        [4500, 3],
        [5999, 3],
        [6000, 7],
        [7000, 7],
    ])
        assert.equal(cultTrialStarMask('3000|4500|6000', score), mask)
    assert.equal(cultTrialStarMask('6000|3000|4500', 4500), 6, 'bits follow table order, not a numeric rank')
})
test('final completion syncs the ending book and unlocks table rewards, which survive reset and reconnect', () => {
    const f = fixture()
    try {
        f.start()
        f.store.transact(f.session.id, 0, (s) => {
            const g = s.activities[60001].growup
            Object.assign(g, {
                cur_stage: 3,
                cur_growup_stage: 13,
                cur_growup_trail_stage: 3,
                select_trail_id: 301,
                final_score: '1000',
            })
            g.trails = [101, 201, 301].map((trail_id) => ({ trail_id, star: 2, score: '4500', guid: g.guid }))
            const village = tables.position(tables.find('world_borthpos', 20005))
            village.pos.x += 123
            s.worldHistory = [village]
            s.tasks = []
            s.taskRecords = tables.get('task').map((x) => ({ task_id: x.id, count: 1 }))
            Object.assign(s.world, tables.position(tables.find('world_borthpos', 10100101)))
        })
        f.call('EnterCultTrial', { activity_id: 60001, trial_id: 301 })
        f.store.transact(f.session.id, 0, (s) => {
            Object.assign(s.cultTrial, { status: 3, battle_complete: true, star: 2, attr_changes: [] })
        })
        const packets = f.call('CultTrialSwitchStep', { activity_id: 60001, trial_id: 301 })
        const book = f.decode(packets, 'CSProtoActivityGrowUpEndQuerySync')
        assert.equal(book.end_data[0].id, 101)
        assert.equal(book.end_data[0].state, 1)
        assert.equal(book.end_data[0].history_top_rating, '2330')
        f.call('CultTrialSwitchStep', { activity_id: 60001, trial_id: 301 })
        assert.equal(f.g().final_score, '2330', 'Duplicate final confirmation cannot add score twice')
        const activity = f.decode(packets, 'CSProtoActivitySync').activitys.find((x) => x.id === 60001)
        const reward = (id) => activity.rewards.find((x) => x.id === id)
        assert.equal(reward(600010101).state, 1, 'Specified ending reward')
        assert.equal(reward(600010301).state, 1, 'One distinct ending reward')
        assert.equal(reward(600010302).state, 0, 'Two distinct endings must remain locked')
        assert.equal(reward(600010203).state, 0, '2330 is below the 8000-score requirement')
        const claim = { activity_id: 60001, reward_id_list: [600010101] }
        assert.ok(f.decode(f.call('ActivityReward', claim), 'CSProtoActivityReward').rewards.length > 0)
        assert.equal(f.decode(f.call('ActivityReward', claim), 'CSProtoActivityReward').rewards.length, 0)
        const expectedReturn = f.state().worldHistory.at(-1)
        assert.equal(f.state().world.map_id, 6552, 'Final confirmation must not interrupt the settlement page')
        const exit = f.call('CampaignQuit')
        const destination = f.decode(exit, 'CSProtoWorldMapSync')
        assert.equal(destination.cmd, 256)
        assert.equal(destination.map_id, 200)
        assert.equal(f.state().world.map_id, expectedReturn.map_id)
        assert.deepEqual(f.state().world.pos, expectedReturn.pos)
        assert.equal(f.state().cultTrial, undefined)
        assert.ok(!f.state().player.group_mgrs.some((x) => x.type === 8))
        const repeated = f.call('QuitPhotoGraphScene')
        assert.ok(!repeated.some((x) => x.id === p.byName.get('CSProtoWorldMapSync').id))
        f.call('ActivityGrowUpResetReq', { activity_id: 60001 })
        const relog = f.call('EnterGame', { open_id: 'growup-test' }, {})
        assert.equal(f.decode(relog, 'CSProtoActivityGrowUpEndQuerySync').end_data[0].id, 101)
        const initialized = f.call('ActivityGet')
        assert.equal(f.decode(initialized, 'CSProtoActivityGrowUpEndQuerySync').end_data[0].id, 101)
        f.call('ActivityGrowUpStartSelectReq', { activity_id: 60001, starting_id: 102, select_assist_char_ids: [] })
        assert.equal(f.g().cur_starting_id, 102, 'Complete ending 101 unlocks the table-defined next opening')
        assert.equal(f.g().end_data.complete_end.length, 1)
    } finally {
        f.store.close()
    }
})
test('ordinary days expose remaining travel points and exiting an unopened travel page clears them without advancing training', () => {
    const f = fixture()
    try {
        const packet = f.start()
        const wire = f.decode(packet, 'CSProtoActivitySync').activitys.find((x) => x.id === 60001).data.grow_up
        assert.equal(wire.cur_cost_expedition_count, 2, 'CBT3 StateMain tests TravalCount > 0 before opening travel')
        assert.ok(wire.event_datas.some((x) => x.event_id === 1001 && !x.finish))
        const before = f.g()
        const leave = f.call('ActivityGrowUpEventFinishReq', { activity_id: 60001 })
        assert.equal(
            f.decode(leave, 'CSProtoActivitySync').activitys.find((x) => x.id === 60001).data.grow_up
                .cur_cost_expedition_count,
            0,
        )
        assert.equal(f.g().action_count, before.action_count)
        assert.equal(f.g().cur_growup_stage, before.cur_growup_stage)
        assert.deepEqual(f.g().growup_train_attr, before.growup_train_attr)
        f.call('ActivityGrowUpEventFinishReq', { activity_id: 60001 })
        assert.equal(f.g().cur_cost_expedition_count, 0)
        assert.throws(
            () => f.call('ActivityGrowUpEventSelectReq', { activity_id: 60001, event_id: 1001, optional_id: 0 }),
            /No cultivation expedition points/,
        )
        for (let i = 0; i < 3; i++) f.call('ActivityGrowUpRestReq', { activity_id: 60001 })
        assert.equal(f.g().cur_growup_stage, 2)
        assert.equal(f.g().cur_cost_expedition_count, 2)
        while (f.g().cur_growup_trail_stage !== 1) f.call('ActivityGrowUpRestReq', { activity_id: 60001 })
        assert.equal(f.g().cur_cost_expedition_count, 0, 'Trial days must not reopen travel')
    } finally {
        f.store.close()
    }
})
function fixture() {
    const store = new Store(':memory:'),
        session = {}
    const game = new Game(p, store, tables, { clock: () => 1791700000, randomInt: () => 0 })
    game.rng = () => 0
    let seq = 1
    const call = (name, r = {}, s = session) => {
        const e = p.byName.get('CSProto' + name)
        return game.dispatch(s, { id: e.id, seq: seq++, pushSeq: 0, payload: p.encode(e.req, r) })
    }
    call('EnterGame', { open_id: 'growup-test' })
    store.transact(session.id, 0, (s) => {
        s.taskRecords = [106010, 106013, 404002].map((task_id) => ({ task_id, count: 1 }))
        s.tasks = s.tasks.filter((x) => x.task_id !== 404002)
    })
    call('ActivityGet')
    const state = () => store.load(session.id).state
    const g = () => state().activities[60001].growup
    const decode = (packets, name) => {
        const e = p.byName.get(name)
        return p.decode(e.rsp, packets.find((x) => x.id === e.id).payload)
    }
    return {
        store,
        session,
        game,
        call,
        state,
        g,
        decode,
        start: () =>
            call('ActivityGrowUpStartSelectReq', { activity_id: 60001, starting_id: 101, select_assist_char_ids: [] }),
    }
}
test('live cultivation score notification does not change the existing terminal score or settlement packets', () => {
    const f = fixture()
    try {
        f.start()
        while (f.g().cur_growup_trail_stage !== 1) f.call('ActivityGrowUpRestReq', { activity_id: 60001 })
        f.store.transact(f.session.id, 0, (s) => {
            s.tasks = []
            s.taskRecords = tables.get('task').map((x) => ({ task_id: x.id, count: 1 }))
            Object.assign(s.world, tables.position(tables.find('world_borthpos', 10100101)))
        })
        f.call('EnterCultTrial', { activity_id: 60001, trial_id: 101 })
        const loaded = f.call('MultiCampaignPlayerLoaded')
        assert.equal(f.decode(loaded, 'CSProtoCampaignChallengeTagsNtf').tags_list[0].tag_progress, '0')
        let finalPackets
        for (const objectId of [5, 6, 7]) {
            const s = f.state(),
                enemies = Object.values(s.combat.entities).filter((x) => x.object_id === objectId)
            const hurt = (targets) =>
                f.call('BattleInfoReduce', {
                    uint64_dic: [s.cultTrial.heroes[0].guid, ...targets.map((x) => x.uuid)],
                    battle_info: targets.map((x, i) => ({
                        hurt_info: { from_id: '1', tar_id: String(i + 2), hp_change: -x.hp },
                    })),
                    base_time: '0',
                })
            if (objectId === 5) {
                const update = hurt(enemies.slice(0, 1))
                assert.equal(f.decode(update, 'CSProtoCampaignChallengeTagsNtf').tags_list[0].tag_progress, '150')
                assert.equal(f.decode(update, 'CSProtoCampaignInfoSync').score, 150)
                finalPackets = hurt(enemies.slice(1))
            } else finalPackets = hurt(enemies)
        }
        assert.equal(f.state().cultTrial.score, 4500)
        assert.equal(f.state().cultTrial.star_mask, 3)
        assert.equal(f.state().cultTrial.status, 3)
        assert.ok(
            !finalPackets.some((x) => x.id === p.byName.get('CSProtoCampaignChallengeTagsNtf').id),
            'terminal notifications remain on the staged path',
        )
        assert.equal(f.decode(finalPackets, 'CSProtoCampaignInfoSync').score, 4500)
    } finally {
        f.store.close()
    }
})
test('current cultivation snapshot initializes the client, applies starting effects and persists through reconnect without touching real formations', () => {
    const f = fixture()
    try {
        const formation = structuredClone(f.state().player.group_mgrs)
        assert.equal(f.g().cur_starting_id, 0)
        assert.equal(f.g().growup_stamina.stamina, 100)
        const packet = f.start()
        const wire = f.decode(packet, 'CSProtoActivitySync').activitys.find((x) => x.id === 60001).data.grow_up
        assert.equal(wire.cur_starting_id, 101)
        assert.deepEqual(
            wire.growup_train_attr.map((x) => x.attr_value),
            [60, 60, 60, 60],
        )
        assert.deepEqual(wire.unlock_events, [2055, 2056, 2057, 2058])
        assert.equal(wire.train_options.length, 4)
        assert.equal(wire.assist_chars[0].assist_char_id, 100)
        assert.equal(f.g().cur_stage, 1)
        const guid = f.g().guid
        f.start()
        assert.equal(f.g().guid, guid)
        f.call('ActivityGrowUpStartSelectReq', { activity_id: 60001, starting_id: 101, select_assist_char_ids: [100] })
        assert.equal(f.g().assist_chars.length, 1)
        f.call('EnterGame', { open_id: 'growup-test' }, {})
        assert.equal(f.g().guid, guid)
        assert.deepEqual(f.state().player.group_mgrs, formation)
        assert.throws(() => f.call('ActivityGrowUpStartSelectReq', { activity_id: 60001, starting_id: 102 }), /locked/)
    } finally {
        f.store.close()
    }
})
test('training uses the client stamina failure formula and actual table gains; rest uses table weights and daily actions lead to a real trial gate', () => {
    const f = fixture()
    try {
        f.start()
        // Isolate base training arithmetic; assistant bonuses are covered separately.
        f.store.transact(f.session.id, 0, (s) => {
            const g = s.activities[60001].growup
            g.assist_chars = []
            for (const option of g.train_options) option.assist_char_ids = []
        })
        f.game.rng = (maximum) => (maximum === 10000 ? 9999 : 0)
        assert.equal(trainingFailureRate(80), 0)
        assert.equal(trainingFailureRate(0), 10000)
        assert.ok(trainingFailureRate(10) > trainingFailureRate(20))
        const packets = f.call('ActivityGrowUpTrainReq', { activity_id: 60001, train_option_id: 1 })
        assert.equal(f.decode(packets, 'CSProtoActivityGrowUpTrainReq').train_prob_result, 2)
        assert.deepEqual(
            f.g().growup_train_attr.map((x) => x.attr_value),
            [75, 62, 62, 62],
        )
        assert.equal(f.g().growup_stamina.stamina, 80)
        f.store.transact(f.session.id, 0, (s) => {
            s.activities[60001].growup.growup_stamina.stamina = 5
        })
        const failure = f.call('ActivityGrowUpTrainReq', { activity_id: 60001, train_option_id: 1 })
        assert.equal(f.decode(failure, 'CSProtoActivityGrowUpTrainReq').train_prob_result, 1)
        assert.equal(f.g().growup_stamina.stamina, 0)
        assert.equal(f.g().growup_train_attr[0].attr_value, 81)
        assert.equal(f.g().train_options[0].train_lv, 2)
        const rest = f.call('ActivityGrowUpRestReq', { activity_id: 60001 })
        assert.equal(f.decode(rest, 'CSProtoActivityGrowUpRestReq').rest_id, 1)
        assert.equal(f.g().growup_stamina.stamina, 60)
        assert.equal(f.g().cur_growup_stage, 2)
        assert.ok(rest.some((x) => x.id === 10425))
        f.game.rng = () => 99
        const goodRest = f.call('ActivityGrowUpRestReq', { activity_id: 60001 })
        assert.equal(f.decode(goodRest, 'CSProtoActivityGrowUpRestReq').rest_id, 2)
        assert.equal(f.g().growup_mood.mood_level, 3)
        f.game.rng = () => 0
        while (f.g().cur_growup_trail_stage !== 1) f.call('ActivityGrowUpRestReq', { activity_id: 60001 })
        assert.equal(f.g().cur_growup_stage, 4)
        assert.equal(f.g().select_trail_id, 101)
        assert.equal(f.g().cur_stage, 1)
        assert.throws(() => f.call('ActivityGrowUpTrainReq', { activity_id: 60001, train_option_id: 1 }), /trial first/)
        f.call('ActivityGrowUpResetReq', { activity_id: 60001 })
        assert.equal(f.g().cur_starting_id, 0)
        assert.deepEqual(
            f.decode(f.call('ActivityGrowUpEndQueryReq', { activity_id: 60001 }), 'CSProtoActivityGrowUpEndQueryReq')
                .end_data,
            [],
        )
    } finally {
        f.store.close()
    }
})
test('100 percent cultivation success remains successful at both random draw boundaries and uses the client result numbering', () => {
    const f = fixture()
    try {
        f.start()
        for (const draw of [0, 1, 4999, 9999]) {
            f.store.transact(f.session.id, 0, (s) => {
                s.activities[60001].growup.growup_stamina.stamina = 100
            })
            f.game.rng = (maximum) => {
                return draw % maximum
            }
            const before = f.g().growup_train_attr[0].attr_value
            const packets = f.call('ActivityGrowUpTrainReq', { activity_id: 60001, train_option_id: 1 })
            const code = f.decode(packets, 'CSProtoActivityGrowUpTrainReq').train_prob_result
            assert.ok(code === 2 || code === 3)
            // Independent CBT3 UI semantics, verified in OnTrainResult IL.
            assert.notEqual(['failure', 'success', 'bond'][code - 1], 'failure')
            assert.ok(f.g().growup_train_attr[0].attr_value > before)
        }
    } finally {
        f.store.close()
    }
})
test('shared photo-scene exit acknowledges cultivation cleanup without losing its run, position or party', () => {
    const f = fixture()
    try {
        f.start()
        f.call('ActivityGrowUpTrainReq', { activity_id: 60001, train_option_id: 1 })
        const before = f.state()
        const packets = f.call('QuitPhotoGraphScene')
        assert.deepEqual(f.decode(packets, 'CSProtoQuitPhotoGraphScene'), {})
        assert.ok(!packets.some((x) => x.id === p.byName.get('CSProtoWorldMapSync').id))
        assert.deepEqual(f.g(), before.activities[60001].growup)
        assert.deepEqual(f.state().world, before.world)
        assert.deepEqual(f.state().player.group_mgrs, before.player.group_mgrs)
        assert.deepEqual(f.decode(f.call('QuitPhotoGraphScene'), 'CSProtoQuitPhotoGraphScene'), {})
        f.call('EnterGame', { open_id: 'growup-test' }, {})
        assert.deepEqual(f.g(), before.activities[60001].growup)
    } finally {
        f.store.close()
    }
})
test('real EnterWorldMap into cultivation is reversed by 9811 with the saved entrance and an actual CutWorld notification', () => {
    const f = fixture()
    try {
        f.start()
        f.store.transact(f.session.id, 0, (s) => {
            s.tasks = []
            // This exit case is an established account, not a fresh prologue
            // account whose automatic task would force its opening scene.
            s.taskRecords = tables.get('task').map((x) => ({ task_id: x.id, count: 1 }))
        })
        f.call('EnterWorldMap', { map_id: 200, point_id: 20005 })
        const outside = f.state().world
        assert.equal(outside.map_id, 200)
        f.call('EnterWorldMap', { map_id: 101001, point_id: 10100101 })
        assert.equal(f.state().world.map_id, 101001)
        assert.ok(
            f
                .state()
                .worldHistory?.some(
                    (x) =>
                        x.map_id === outside.map_id && tables.find('world_borthpos', x.point_id)?.cityId === x.map_id,
                ),
        )
        const run = f.g(),
            party = f.state().player.group_mgrs
        const packets = f.call('QuitPhotoGraphScene')
        const sync = f.decode(packets, 'CSProtoWorldMapSync')
        assert.equal(sync.cmd, 256)
        assert.equal(sync.map_id, outside.map_id)
        assert.equal(f.state().world.point_id, outside.point_id)
        assert.deepEqual(f.state().world.pos, outside.pos)
        assert.deepEqual(f.g(), run)
        assert.deepEqual(f.state().player.group_mgrs, party)
        const retry = f.call('QuitPhotoGraphScene')
        assert.ok(!retry.some((x) => x.id === p.byName.get('CSProtoWorldMapSync').id))
        assert.equal(f.state().world.map_id, 200)
    } finally {
        f.store.close()
    }
})
test('cultivation exit never guesses a destination when saved entrance history is missing', () => {
    const f = fixture()
    try {
        f.start()
        f.store.transact(f.session.id, 0, (s) => {
            s.world.map_id = 101001
            s.world.point_id = 10100101
            s.worldHistory = []
        })
        const before = f.state()
        assert.throws(() => f.call('QuitPhotoGraphScene'), /return context unavailable/)
        assert.deepEqual(f.state().world, before.world)
        assert.deepEqual(f.g(), before.activities[60001].growup)
    } finally {
        f.store.close()
    }
})
test('table-matched cultivation examination 101 enters a real type27 scene with its enemy roster, reconnects and returns to the saved training scene', () => {
    const f = fixture()
    try {
        f.start()
        assert.throws(() => f.call('EnterCultTrial', { activity_id: 60001, trial_id: 101 }), /not ready/)
        assert.throws(() => f.call('WorldPoint', { point_id: 0 }), /Point is not unlocked/)
        assert.throws(
            () => f.call('ReEnterCultTrial', { activity_id: 0, trial_id: 0, archive_id: 0 }),
            /No active cultivation trial/,
        )
        while (f.g().cur_growup_trail_stage !== 1) f.call('ActivityGrowUpRestReq', { activity_id: 60001 })
        f.store.transact(f.session.id, 0, (s) => {
            s.tasks = []
            s.taskRecords = tables.get('task').map((x) => ({ task_id: x.id, count: 1 }))
            Object.assign(s.world, tables.position(tables.find('world_borthpos', 10100101)))
        })
        const saved = f.state().world,
            progress = f.g(),
            party = f.state().player.group_mgrs
        const packets = f.call('EnterCultTrial', { activity_id: 60001, trial_id: 101 })
        assert.deepEqual(f.decode(packets, 'CSProtoEnterCultTrial'), {})
        assert.equal(f.state().world.map_id, 6550)
        assert.equal(f.decode(packets, 'CSProtoWorldMapSync').cmd, 256)
        const campaign = f.decode(packets, 'CSProtoCampaignInfoSync')
        assert.equal(campaign.dungeon_id, 32210)
        assert.equal(campaign.cur_scene_id, 6550)
        assert.equal(campaign.status, 2)
        const temporary = f.decode(packets, 'CSProtoTrialDatas'),
            actors = new Map(temporary.trial_heros.map((x) => [x.guid, x]))
        const examination = f.state().player.group_mgrs.find((x) => x.type === 8),
            slots = examination.groups[0].heros
        assert.equal(slots.length, 3)
        assert.deepEqual(
            temporary.trial_heros.map((x) => x.conf_id),
            [
                101010,
                199008,
                tables.find('hero_interim', 30002).heroType === 1
                    ? f.state().player.heros_info.heros.find((x) => x.type === 1).conf_id
                    : 199002,
            ],
        )
        assert.ok(
            slots.every(
                (x) =>
                    actors.has(x.hero_id) &&
                    temporary.trial_pets.some((pet) => pet.guid === x.pet_id && pet.hero_id === x.hero_id),
            ),
        )
        assert.deepEqual(
            temporary.trial_pets.map((x) => x.config_id),
            [500306, 500065, 500370],
        )
        const actorPacketIndex = packets.findIndex((x) => x.id === p.byName.get('CSProtoTrialDatas').id)
        const worldIndex = packets.findIndex((x) => x.id === p.byName.get('CSProtoWorldMapSync').id)
        assert.ok(actorPacketIndex < worldIndex, 'temporary actor cache precedes preparation page')
        const groupPackets = packets.filter((x) => x.id === p.byName.get('CSProtoSyncPlayerData').id)
        assert.ok(
            groupPackets.some((x) =>
                p
                    .decode('cs.PlayerData', x.payload)
                    .group_mgrs?.some((m) => m.type === 8 && m.groups[0]?.heros.length === 3),
            ),
        )
        f.call('SwitchGroupControlEnd', { uuid: slots[0].hero_id })
        f.call('SwitchPetAction', { uuid: slots[0].pet_id, type: 1 })
        assert.equal(slots[0].pet_id, '648519639126507521', 'matches the logged examination pet GUID')
        for (const slot of slots) {
            assert.ok(!f.state().pets.some((x) => x.guid === slot.pet_id))
            const failVec = f.decode(f.call('SkillFailVec', { unit_id: slot.pet_id }), 'SCProtoSkillFailVec')
            assert.equal(failVec.unit_id, slot.pet_id)
            assert.equal(failVec.success, true)
            assert.deepEqual(failVec.fail_vec, [])
        }
        assert.throws(() => f.call('SkillFailVec', { unit_id: '18446744073709551615' }), /Pet not owned/)
        const enemies = Object.values(f.state().combat.entities).filter((x) => [5, 6, 7].includes(x.object_id))
        assert.equal(enemies.length, 19)
        assert.ok(enemies.every((x) => x.hp > 0 && x.level > 0))
        assert.ok([5, 6, 7].every((id) => !f.state().worldObjects['6550:' + id].active))
        assert.equal(p.byName.get('CSProtoMultiCampaignPlayerLoaded').id, 9596)
        const loaded = f.call('MultiCampaignPlayerLoaded')
        assert.equal(f.decode(loaded, 'CSProtoCampaignInfoSync').waves, 1)
        assert.equal(f.state().worldObjects['6550:5'].active, true)
        assert.equal(f.state().worldObjects['6550:6'].active, false)
        const multiplayerIds = new Set(
            [
                'SCProtoObjAppearNtf',
                'SCProtoObjDisappearNtf',
                'SCProtoControlChangeByAddNtf',
                'SCProtoControlChangeByDelNtf',
            ].map((name) => p.byName.get(name).id),
        )
        assert.ok(
            loaded.every((packet) => !multiplayerIds.has(packet.id)),
            'single-player scene never receives multiplayer AOI',
        )
        assert.equal(f.decode(loaded, 'CSProtoObjBattleInfoSync').infos.length, 8)
        const hurt = (targets, amount) =>
            f.call('BattleInfoReduce', {
                uint64_dic: [slots[0].pet_id, ...targets.map((x) => x.uuid)],
                battle_info: targets.map((x, index) => ({
                    hurt_info: {
                        from_id: '1',
                        tar_id: String(index + 2),
                        hp_change: amount ?? -x.hp,
                    },
                })),
                base_time: '0',
            })
        const firstWave = enemies.filter((x) => x.object_id === 5)
        assert.throws(() => f.call('EndDungeonScene', { result: 3 }), /still alive/)
        hurt([firstWave[0]], -1)
        f.call('MultiCampaignPlayerLoaded')
        assert.equal(
            f.state().combat.entities[firstWave[0].uuid].hp,
            firstWave[0].hp - 1,
            'duplicate loading preserves damage',
        )
        const partial = hurt(firstWave.slice(0, -1))
        assert.equal(f.decode(partial, 'CSProtoCampaignInfoSync').score, 1050)
        assert.equal(f.state().cultTrial.current_wave, 1, 'one living slot prevents next wave')
        assert.ok(!partial.some((x) => x.id === p.byName.get('SCProtoObjAppearNtf').id))
        const secondWave = hurt(firstWave.slice(-1))
        assert.equal(f.state().cultTrial.current_wave, 2)
        assert.equal(f.state().worldObjects['6550:5'].complete, true)
        assert.equal(f.state().worldObjects['6550:5'].active, false)
        assert.deepEqual(f.state().worldObjects['6550:5'].expand_data.battle_group.world_indexes, [])
        const repaired = structuredClone(f.state())
        const savedGroup = repaired.worldObjects['6550:5']
        delete savedGroup.time
        delete savedGroup.next_time
        const liveGroup = repaired.worldObjects['6550:6'].expand_data.battle_group
        const retired = liveGroup.monsters[0].uid
        repaired.combat.entities[retired].captured = true
        ensureCultTrialScene(tables, repaired, 1800000000)
        assert.equal(savedGroup.time, repaired.cultTrial.start_time)
        assert.equal(savedGroup.next_time, 0)
        assert.equal(savedGroup.next_time + 10 > savedGroup.time, false)
        assert.ok(!repaired.worldObjects['6550:6'].expand_data.battle_group.world_indexes.includes(0))
        assert.ok(repaired.combat.entities[retired].hp > 0, 'capture tombstone overrides stale positive HP')
        assert.equal(f.decode(secondWave, 'CSProtoWorldMapSync').map_info.objs.find((x) => x.obj_id === 6).active, true)
        assert.ok(secondWave.every((packet) => !multiplayerIds.has(packet.id)))
        assert.equal(f.decode(secondWave, 'CSProtoCampaignInfoSync').waves, 2)
        for (const objectId of [6, 7]) {
            hurt(Object.values(f.state().combat.entities).filter((x) => x.object_id === objectId))
        }
        assert.equal(f.state().cultTrial.battle_complete, true)
        assert.ok([5, 6, 7].every((id) => !f.state().worldObjects['6550:' + id].active))
        assert.equal(f.state().cultTrial.status, 3)
        assert.equal(f.state().cultTrial.score, 4500)
        assert.equal(f.state().cultTrial.star, 2)
        assert.equal(f.state().cultTrial.star_mask, 3)
        assert.equal(f.g().trails[0].score, '4500')
        assert.equal(f.state().worldObjects['6550:4'].active, true, 'configured victory chest is visible')
        const repeat = f.call('MultiCampaignPlayerLoaded')
        assert.ok(
            repeat
                .filter((x) => x.id === p.byName.get('SCProtoObjAppearNtf').id)
                .every((x) => p.decode(p.byName.get('SCProtoObjAppearNtf').rsp, x.payload).agent_type === 9),
            'completed enemies are never reappeared',
        )
        f.call('EnterGame', { open_id: 'growup-test' }, {})
        assert.equal(f.state().player.group_mgrs.find((x) => x.type === 8).groups[0].heros.length, 3)
        f.store.transact(f.session.id, 0, (s) => {
            delete s.cultTrial.heroes
            delete s.cultTrial.pets
            delete s.cultTrial.score
            delete s.cultTrial.star
            delete s.cultTrial.result_published
            s.cultTrial.status = 2
            s.activities[60001].growup.trails = []
            s.worldObjects['6550:4'].active = false
            s.player.group_mgrs = s.player.group_mgrs.filter((x) => x.type !== 8)
        })
        const migrated = f.call('EnterGame', { open_id: 'growup-test' }, {})
        assert.equal(f.decode(migrated, 'CSProtoTrialDatas').trial_heros.length, 3)
        assert.equal(f.state().player.group_mgrs.find((x) => x.type === 8).groups[0].heros.length, 3)
        assert.equal(f.state().cultTrial.trial_id, 101)
        assert.equal(f.decode(migrated, 'CSProtoCampaignInfoSync').score, 4500, 'reconstructs completed legacy run')
        assert.equal(
            f.decode(migrated, 'CSProtoCampaignInfoSync').status,
            2,
            'bootstrap manager before delivering a terminal result',
        )
        assert.equal(f.decode(migrated, 'CSProtoCampaignInfoSync').star, 0)
        assert.ok(
            migrated.findIndex((x) => x.id === p.byName.get('CSProtoActivitySync').id) <
                migrated.findIndex((x) => x.id === p.byName.get('CSProtoCampaignInfoSync').id),
        )
        const restoredResult = f.call('MultiCampaignPlayerLoaded')
        assert.equal(f.decode(restoredResult, 'CSProtoCampaignInfoSync').status, 3)
        assert.equal(f.decode(restoredResult, 'CSProtoCampaignInfoSync').star, 3)
        assert.equal(f.g().trails[0].star, 2)
        f.call('WorldObjInteract', { objs: [{ obj: { obj_id: 4, complete: true }, interact_type: 2 }] })
        f.call('MultiCampaignPlayerLoaded')
        assert.equal(f.state().worldObjects['6550:4'].active, false, 'claimed chest is not reopened')
        assert.equal(f.state().cultTrial.trial_id, 101)
        assert.equal(f.state().world.map_id, 6550)
        const instance = f.state().cultTrial.instance_id
        f.call('ReEnterCultTrial', { activity_id: 0, trial_id: 0, archive_id: 0 })
        assert.ok(f.state().cultTrial.instance_id > instance)
        assert.equal(f.state().cultTrial.current_wave, undefined)
        assert.ok(Object.values(f.state().combat.entities).every((x) => x.hp > 0))
        f.call('MultiCampaignPlayerLoaded')
        for (const objectId of [5, 6, 7])
            hurt(Object.values(f.state().combat.entities).filter((x) => x.object_id === objectId))
        const beforeAccept = structuredClone(f.g().growup_train_attr)
        f.call('CultTrialSwitchStep', { activity_id: 60001, trial_id: 101 })
        assert.equal(f.state().world.map_id, 6550, 'settlement ACK must preserve client transfer context')
        f.call('CultTrialSwitchStep', { activity_id: 60001, trial_id: 101 })
        f.call('WorldPoint', { point_id: 0, is_stuck: false, client_trans_data: 0, is_keep_playable: false })
        assert.equal(f.state().world.map_id, saved.map_id)
        assert.deepEqual(f.state().world.pos, saved.pos)
        assert.equal(f.g().guid, progress.guid)
        assert.equal(f.g().cur_stage, 2)
        assert.equal(f.g().final_score, '400')
        assert.deepEqual(
            f.g().growup_train_attr.map((x) => x.attr_value),
            beforeAccept.map((x) => x.attr_value + 20),
        )
        const accepted = structuredClone(f.g())
        f.call('CultTrialSwitchStep', { activity_id: 60001, trial_id: 101 })
        assert.deepEqual(f.g(), accepted, 'retry never duplicates attributes or final score')
        const lateReturn = f.call('WorldPoint', { point_id: 0 })
        assert.equal(lateReturn.length, 1, 'late cultivation return receives only its normal ACK')
        assert.deepEqual(f.decode(lateReturn, 'CSProtoWorldPoint'), {})
        assert.deepEqual(f.state().player.group_mgrs, party)
        assert.equal(f.state().cultTrial, undefined)
        assert.deepEqual(f.call('SkillFailVec', { unit_id: slots[0].pet_id }), [], 'ignores retired trial callbacks')
        const late = { unit_id: slots[0].hero_id, bullet_id: '1153308283591720961', action_type: 3, action_id: 1 }
        assert.equal(late.unit_id, '360416819208519681', 'matches the logged retired examination hero')
        assert.deepEqual(f.call('BulletActionChange', { action_info: [late] }), [])
        assert.deepEqual(
            f.call('CreateBullet', {
                unit_id: late.unit_id,
                bullet_info: [{ bullet_id: late.bullet_id, config_id: 100 }],
            }),
            [],
        )
        assert.equal(f.state().combat.bullets[late.bullet_id], undefined)
        const owned = f.state().player.heros_info.heros[0].guid
        f.call('CreateBullet', { unit_id: owned, bullet_info: [{ bullet_id: '9007199254740993', config_id: 100 }] })
        f.call('BulletActionChange', {
            action_info: [
                late,
                {
                    unit_id: owned,
                    bullet_id: '9007199254740993',
                    action_type: 2,
                    action_id: 5,
                },
            ],
        })
        assert.equal(
            f.state().combat.bullets['9007199254740993'].action.action_id,
            5,
            'retired row does not discard valid rows',
        )
        assert.throws(
            () =>
                f.call('BulletActionChange', {
                    action_info: [
                        {
                            ...late,
                            unit_id: '360416819208519781',
                        },
                    ],
                }),
            /Trial hero not active/,
        )
        while (f.g().cur_growup_trail_stage !== 2) f.call('ActivityGrowUpRestReq', { activity_id: 60001 })
        const secondTrial = f.call('EnterCultTrial', { activity_id: 60001, trial_id: 201 })
        assert.equal(f.state().world.map_id, 6551)
        assert.equal(f.decode(secondTrial, 'CSProtoCampaignInfoSync').dungeon_id, 32220)
        assert.equal(Object.values(f.state().combat.entities).length, 20)
        assert.ok(Object.values(f.state().combat.entities).every((x) => x.hp > 0 && x.level > 0))
        f.call('MultiCampaignPlayerLoaded')
        assert.equal(f.state().worldObjects['6551:5'].active, true)
        for (const [trialId, sceneId] of [
            [101, 6550],
            [201, 6551],
            [301, 6552],
            [302, 6553],
            [303, 6554],
            [304, 6555],
            [305, 6556],
        ])
            assert.equal(cultTrialRoute(tables, f.game.activities, 60001, trialId).route.scene_id, sceneId)
        assert.equal(cultTrialRoute(tables, f.game.activities, 60001, 306).route.scene_id, 6557)
    } finally {
        f.store.close()
    }
})
test('cultivation event requests cannot invent events or options; current step survives reconnect and cancellation grants nothing', () => {
    const f = fixture()
    try {
        f.start()
        const before = f.state().player.sbag_infos
        assert.throws(
            () => f.call('ActivityGrowUpEventSelectReq', { activity_id: 60001, event_id: 999999, optional_id: 0 }),
            /not offered/,
        )
        f.call('ActivityGrowUpEventSelectReq', { activity_id: 60001, event_id: 1001, optional_id: 0 })
        assert.equal(f.g().cur_event_data.cur_step, 101)
        assert.throws(
            () => f.call('ActivityGrowUpEventSelectReq', { activity_id: 60001, event_id: 1001, optional_id: 100101 }),
            /does not belong/,
        )
        f.call('ActivityGrowUpEventSelectReq', { activity_id: 60001, event_id: 1001, optional_id: 100100 })
        assert.equal(f.g().cur_cost_expedition_count, 1)
        f.call('EnterGame', { open_id: 'growup-test' }, {})
        assert.equal(
            f.decode(f.call('ActivityGrowUpEventInfoReq', { activity_id: 60001 }), 'CSProtoActivityGrowUpEventInfoReq')
                .cur_step,
            102,
        )
        f.call('ActivityGrowUpEventSelectReq', { activity_id: 60001, event_id: 1001, optional_id: 0 })
        assert.equal(f.g().cur_event_data.cur_step, 103)
        const randomOutcome = f.call('ActivityGrowUpEventSelectReq', {
            activity_id: 60001,
            event_id: 1001,
            optional_id: 0,
        })
        assert.equal(f.decode(randomOutcome, 'CSProtoActivityGrowUpEventSelectReq').optional_id, 100101)
        assert.ok(f.g().growup_status.some((x) => x.status_id === 10020))
        f.call('ActivityGrowUpEventFinishReq', { activity_id: 60001 })
        assert.equal(f.g().cur_event_data, undefined)
        const beforeAttr = f.g().growup_train_attr.find((x) => x.attr_id === 102).attr_value
        f.call('ActivityGrowUpTrainReq', { activity_id: 60001, train_option_id: 2 })
        assert.equal(f.g().growup_train_attr.find((x) => x.attr_id === 102).attr_value - beforeAttr, 18)
        assert.deepEqual(f.state().player.sbag_infos, before)
    } finally {
        f.store.close()
    }
})
