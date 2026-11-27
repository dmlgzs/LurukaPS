import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { TaskGraphs, makeNode, conditionValue, nodeConditions } from '../src/tasks.js'
import { grantRewards } from '../src/rewards.js'
import { ErrorCode } from '../src/error-codes.js'
// Explicit isolated node-entry/recovery fixtures,not normal earned task progression.
// Current106010/148 checks pet groups1/4/7;CBT3 groups52/55/56 are not used.
const c = configuration(),
    p = new Protocol(c.base),
    t = new Tables(c.tables)
test('actual playable11028 starts, saves stages, resumes on login and cancels without fake rewards', () => {
    const store = new Store(':memory:'),
        game = new Game(p, store, t, { clock: () => 1800000000 }),
        session = {}
    let seq = 1
    const call = (who, name, r = {}) => {
        const e = p.byName.get('CSProto' + name)
        return game
            .dispatch(who, { id: e.id, seq: seq++, payload: p.encode(e.req, r) })
            .map((x) => ({ id: x.id, data: p.decode(p.byId.get(x.id).rsp, x.payload) }))
    }
    try {
        call(session, 'EnterGame', { open_id: 'play-test' })
        call(session, 'EnterWorldMap', { map_id: 100, point_id: 10045 })
        const inventory = store.load(session.id).state.player.sbag_infos
        const start = call(session, 'PlayableStart', { u32: 11028 })
        assert.equal(start[0].id, 9400)
        assert.equal(start.at(-1).id, 9403)
        assert.equal(start[0].data.plays[0].status, 1)
        assert.equal(start[0].data.all_sync, false)
        call(session, 'PlayableStep', { playId: 11028, is_step: true, finish_step: 5 })
        call(session, 'PlayableStart', { u32: 11028 })
        assert.equal(store.load(session.id).state.playableRuns[11028].finish_step, 5)
        const other = {}
        const login = call(other, 'EnterGame', { open_id: 'play-test' })
        assert.equal(login.find((x) => x.id === 9400).data.plays[0].finish_step, 5)
        assert.equal(login.find((x) => x.id === 9400).data.all_sync, true)
        const before = store.load(session.id)
        assert.throws(() => call(session, 'PlayableStep', { playId: 11028, is_step: true, finish_step: 4 }))
        assert.deepEqual(store.load(session.id), before)
        const step = call(session, 'PlayableStep', { playId: 11028, is_step: true, finish_step: 10 }).find(
            (packet) => packet.id === 9406,
        ).data
        assert.equal(step.play.status, 2)
        assert.deepEqual(step.rewards.rewards, [])
        assert.deepEqual(store.load(session.id).state.player.sbag_infos, inventory)
        assert.deepEqual(call(session, 'PlayableCancel', { playId: 11028 })[0].data.plays, [])
        assert.throws(() => call(session, 'PlayableStep', { playId: 11028, is_step: true, finish_step: 10 }))
        store.transact(session.id, 0, (s) => {
            s.world.map_id = 101
        })
        assert.throws(() => call(session, 'PlayableStart', { u32: 11028 }), /current map/)
    } finally {
        store.close()
    }
})
test('task-created playable60001 starts only for its active quest node in scene100', () => {
    const store = new Store(':memory:'),
        game = new Game(p, store, t, { clock: () => 1800000000 }),
        session = {}
    let seq = 1
    const call = (name, r = {}) => {
        const e = p.byName.get('CSProto' + name)
        return game.dispatch(session, { id: e.id, seq: seq++, payload: p.encode(e.req, r) })
    }
    try {
        call('EnterGame', { open_id: 'task-playable' })
        assert.throws(() => call('PlayableStart', { u32: 60001 }), /current map/)
        const graph = new TaskGraphs(t).get(106010)
        store.transact(session.id, 0, (s) => {
            s.world.map_id = 100
            s.taskRecords = [
                { task_id: 106001, count: 1, time: 1 },
                { task_id: 106002, count: 1, time: 2 },
                { task_id: 106009, count: 1, time: 3 },
            ]
            s.taskEpochs[106010] = 1
            s.tasks = [
                {
                    task_id: 106010,
                    nodes: [{ ...makeNode(graph, 151, s), client_before: true }],
                    finish_nodes: [3, 74, 78, 149, 82],
                    reward_nodes: [],
                    client_trace: true,
                },
            ]
        })
        // The fixture installed already completed prerequisites after login.
        // Deliver their real durable system-unlock transition before measuring
        // the separate deferred playable metadata write.
        call('WorldTimeSync', { world_time: 0 })
        const revision = store.playerById.get(session.id).revision
        const packets = call('PlayableStart', { u32: 60001 }),
            run = store.load(session.id).state.playableRuns[60001]
        assert.equal(run.map_id, 100)
        assert.equal(run.status, 1)
        assert(packets.some((x) => x.id === 9400))
        for (let i = 0; i < 6; i++) {
            const again = call('PlayableStart', { u32: 60001 })
            assert.deepEqual(
                again.map((x) => x.id),
                [9403],
            )
        }
        assert.equal(store.load(session.id).state.playableRuns[60001].time, run.time)
        assert.equal(store.playerById.get(session.id).revision, revision)
        store.flushPending()
        assert.equal(store.playerById.get(session.id).revision, revision + 1)
        store.transact(session.id, 0, (s) => {
            s.world.map_id = 101
        })
        assert.throws(() => call('PlayableStart', { u32: 60001 }), /current map/)
        store.transact(session.id, 0, (s) => {
            s.world.map_id = 100
            s.tasks[0].nodes = [makeNode(graph, 82, s)]
        })
        assert.throws(() => call('PlayableStart', { u32: 60001 }), /current map/)
    } finally {
        store.close()
    }
})
test('pet choice playable grants only the selected customized pet and completes task condition2525', () => {
    const store = new Store(':memory:'),
        game = new Game(p, store, t, { clock: () => 1800000000 }),
        session = {}
    let seq = 1
    const call = (name, r = {}) => {
        const e = p.byName.get('CSProto' + name)
        return game.dispatch(session, { id: e.id, seq: seq++, payload: p.encode(e.req, r) })
    }
    try {
        call('EnterGame', { open_id: 'pet-choice' })
        const graph = new TaskGraphs(t).get(106010)
        store.transact(session.id, 0, (s) => {
            s.world.map_id = 100
            s.taskRecords = [
                { task_id: 106001, count: 1, time: 1 },
                { task_id: 106002, count: 1, time: 2 },
                { task_id: 106009, count: 1, time: 3 },
            ]
            s.taskEpochs[106010] = 1
            s.tasks = [
                {
                    task_id: 106010,
                    nodes: [{ ...makeNode(graph, 151, s), client_before: true }],
                    finish_nodes: [3, 74, 78, 149, 82],
                    reward_nodes: [],
                    client_trace: true,
                },
            ]
        })
        call('PlayableStart', { u32: 60001 })
        const before = store.load(session.id).state.pets.length
        const first = call('PlayableStep', { playId: 60001, is_step: true, finish_step: 1 })
        assert.equal(store.load(session.id).state.pets.length, before + 1)
        const step = p.decode('SCPlayableStep', first.find((x) => x.id === 9406).payload)
        assert.equal(step.rewards.rewards[0].itemtype, 30)
        assert.equal(step.rewards.rewards[0].itemid, 5002581)
        assert.deepEqual(step.drop_id, [16005])
        assert(first.findIndex((x) => x.id === 6517) < first.findIndex((x) => x.id === 9406))
        assert.deepEqual(
            p.decode(
                'SCPlayableStep',
                call('PlayableStep', { playId: 60001, is_step: true, finish_step: 1 }).find((x) => x.id === 9406)
                    .payload,
            ).rewards.rewards,
            [],
        )
        const state = store.load(session.id)
        assert.throws(() => call('PlayableStep', { playId: 60001, is_step: true, finish_step: 2 }), /already made/)
        assert.deepEqual(store.load(session.id), state)
        call('PlayableStep', { playId: 60001, is_step: true, finish_step: 10 })
        const finish = call('PlayableFinish', { playId: 60001, score: 0, pos: {} })
        const saved = store.load(session.id).state
        assert.equal(saved.tasks[0].nodes[0].node_values[0], 1)
        assert.equal(saved.playableFinishes[60001].selected_pet_group, 1)
        assert.equal(saved.pets.length, before + 1)
        const finishSync = p.decode('PlayableSync', finish.find((x) => x.id === 9400).payload)
        assert.deepEqual(finishSync.finish_plays, [60001])
        assert.equal(finishSync.finish[0].play_id, 60001)
        assert.deepEqual(p.decode('SCPlayableFinish', finish.find((x) => x.id === 9404).payload).reward.rewards, [])
        call('PlayableFinish', { playId: 60001, index: 0, score: 0 })
        assert.equal(store.load(session.id).state.pets.length, before + 1)
        call('TaskClientCondAfter', { task_id: 106010, node_id: 151, indexes: [0] })
        call('TaskClientAfter', { task_id: 106010, node_id: 151 })
        assert.equal(store.load(session.id).state.tasks[0].nodes[0].node_id, 181)
        assert(store.load(session.id).state.tasks[0].finish_nodes.includes(148))
        call('TaskClientAfter', { task_id: 106010, node_id: 148 })
    } finally {
        store.close()
    }
})
for (const [step, customized, group, next] of [
    [2, 5002441, 4, 182],
    [3, 5002611, 7, 183],
])
    test(`pet choice ${step} follows only configured branch ${next}`, () => {
        const store = new Store(':memory:'),
            game = new Game(p, store, t, { clock: () => 1800000000 }),
            session = {}
        let seq = 1
        const call = (name, r = {}) => {
            const e = p.byName.get('CSProto' + name)
            return game.dispatch(session, { id: e.id, seq: seq++, payload: p.encode(e.req, r) })
        }
        try {
            call('EnterGame', { open_id: `pet-choice-${step}` })
            const graph = new TaskGraphs(t).get(106010)
            store.transact(session.id, 0, (s) => {
                s.world.map_id = 100
                s.taskRecords = [
                    { task_id: 106001, count: 1, time: 1 },
                    { task_id: 106002, count: 1, time: 2 },
                    { task_id: 106009, count: 1, time: 3 },
                ]
                s.taskEpochs[106010] = 1
                s.tasks = [
                    {
                        task_id: 106010,
                        nodes: [{ ...makeNode(graph, 151, s), client_before: true }],
                        finish_nodes: [3, 74, 78, 149, 82],
                        reward_nodes: [],
                        client_trace: true,
                    },
                ]
            })
            call('PlayableStart', { u32: 60001 })
            call('PlayableStep', { playId: 60001, is_step: true, finish_step: step })
            call('PlayableStep', { playId: 60001, is_step: true, finish_step: 10 })
            call('PlayableFinish', { playId: 60001, index: 0, score: 0 })
            call('TaskClientCondAfter', { task_id: 106010, node_id: 151, indexes: [0] })
            call('TaskClientAfter', { task_id: 106010, node_id: 151 })
            const s = store.load(session.id).state
            assert.equal(s.tasks[0].nodes[0].node_id, next)
            assert.equal(s.taskPetChoices[106010], group)
            assert.equal(s.pets.filter((p) => p.customized_id === customized).length, 1)
        } finally {
            store.close()
        }
    })
test('canceling and restarting the choice does not create a second pet', () => {
    const store = new Store(':memory:'),
        game = new Game(p, store, t, { clock: () => 1800000000 }),
        session = {}
    let seq = 1
    const call = (name, r = {}) => {
        const e = p.byName.get('CSProto' + name)
        return game.dispatch(session, { id: e.id, seq: seq++, payload: p.encode(e.req, r) })
    }
    try {
        call('EnterGame', { open_id: 'choice-retry' })
        const graph = new TaskGraphs(t).get(106010)
        store.transact(session.id, 0, (s) => {
            s.world.map_id = 100
            s.taskRecords = [
                { task_id: 106001, count: 1, time: 1 },
                { task_id: 106002, count: 1, time: 2 },
                { task_id: 106009, count: 1, time: 3 },
            ]
            s.taskEpochs[106010] = 1
            s.tasks = [
                {
                    task_id: 106010,
                    nodes: [{ ...makeNode(graph, 151, s), client_before: true }],
                    finish_nodes: [3, 74, 78, 149, 82],
                    reward_nodes: [],
                    client_trace: true,
                },
            ]
        })
        call('PlayableStart', { u32: 60001 })
        call('PlayableStep', { playId: 60001, is_step: true, finish_step: 1 })
        const count = store.load(session.id).state.pets.length
        call('PlayableCancel', { playId: 60001 })
        call('PlayableStart', { u32: 60001 })
        const repeat = call('PlayableStep', { playId: 60001, is_step: true, finish_step: 1 })
        assert.deepEqual(p.decode('SCPlayableStep', repeat.find((x) => x.id === 9406).payload).rewards.rewards, [])
        assert.equal(store.load(session.id).state.pets.length, count)
        assert.throws(() => call('PlayableStep', { playId: 60001, is_step: true, finish_step: 2 }), /already made/)
        call('PlayableStep', { playId: 60001, is_step: true, finish_step: 10 })
        call('PlayableFinish', { playId: 60001, index: 0, score: 0 })
        assert.equal(store.load(session.id).state.pets.length, count)
    } finally {
        store.close()
    }
})
test('mount challenge62102 requires a real same-scene finish before main quest advances', () => {
    const store = new Store(':memory:'),
        game = new Game(p, store, t, { clock: () => 1800000000 }),
        session = {}
    let seq = 1
    const call = (name, r = {}) => {
        const e = p.byName.get('CSProto' + name)
        return game.dispatch(session, { id: e.id, seq: seq++, payload: p.encode(e.req, r) })
    }
    try {
        call('EnterGame', { open_id: 'later-playable' })
        const graph = new TaskGraphs(t).get(106010)
        store.transact(session.id, 0, (s) => {
            s.world.map_id = 100
            s.taskRecords = [
                { task_id: 106001, count: 1, time: 1 },
                { task_id: 106002, count: 1, time: 2 },
                { task_id: 106009, count: 1, time: 3 },
            ]
            s.taskEpochs[106010] = 1
            s.tasks = [
                {
                    task_id: 106010,
                    nodes: [{ ...makeNode(graph, 167, s), client_before: true }],
                    finish_nodes: [3, 74, 78, 149, 82, 151, 148, 181, 168, 154, 184, 185, 152, 153, 177, 156],
                    reward_nodes: [],
                    client_trace: true,
                },
            ]
        })
        const condition = nodeConditions(graph.nodes.get(167))[0]
        const context = { taskId: 106010, nodeId: 167, index: 0 }
        assert.equal(store.load(session.id).state.tasks[0].nodes[0].node_values[0], 0)
        assert.equal(conditionValue(condition, store.load(session.id).state, context), 0)
        assert.throws(
            () => call('TaskClientCondAfter', { task_id: 106010, node_id: 167, indexes: [0] }),
            /condition not complete/,
        )
        call('PlayableStart', { u32: 62102 })
        assert.throws(() => call('PlayableFinish', { playId: 62102, index: 0, score: 0 }), /completed its steps/)
        assert.equal(conditionValue(condition, store.load(session.id).state, context), 0)
        call('PlayableStep', { playId: 62102, is_step: true, finish_step: 10 })
        assert.equal(conditionValue(condition, store.load(session.id).state, context), 0)
        call('PlayableFinish', { playId: 62102, index: 0, score: 0 })
        const completed = store.load(session.id).state
        assert.equal(conditionValue(condition, completed, context), 1)
        assert.equal(
            conditionValue(condition, { ...completed, playableFinishes: { 62102: { map_id: 101 } } }, context),
            0,
        )
        const receipt = structuredClone(completed.playableFinishes[62102])
        call('PlayableFinish', { playId: 62102, index: 0, score: 0 })
        assert.deepEqual(store.load(session.id).state.playableFinishes[62102], receipt)
        assert.equal(store.load(session.id).state.tasks[0].nodes[0].node_values[0], 1)
        call('TaskClientCondAfter', { task_id: 106010, node_id: 167, indexes: [0] })
        call('TaskClientAfter', { task_id: 106010, node_id: 167 })
        assert.equal(store.load(session.id).state.tasks[0].nodes[0].node_id, 100)
    } finally {
        store.close()
    }
})
test('login repairs only the logged failed finish after chosen pet and final step are already saved', () => {
    const store = new Store(':memory:'),
        game = new Game(p, store, t, { clock: () => 1800000000 }),
        first = {}
    let seq = 1
    const enter = (session) => {
        const e = p.byName.get('CSProtoEnterGame')
        return game.dispatch(session, { id: e.id, seq: seq++, payload: p.encode(e.req, { open_id: 'failed-finish' }) })
    }
    try {
        enter(first)
        const graph = new TaskGraphs(t).get(106010)
        store.transact(first.id, 0, (s) => {
            s.world.map_id = 100
            s.taskRecords = [
                { task_id: 106001, count: 1, time: 1 },
                { task_id: 106002, count: 1, time: 2 },
                { task_id: 106009, count: 1, time: 3 },
            ]
            s.taskEpochs[106010] = 1
            s.tasks = [
                {
                    task_id: 106010,
                    nodes: [{ ...makeNode(graph, 151, s), client_before: true }],
                    finish_nodes: [3, 74, 78, 149, 82],
                    reward_nodes: [],
                    client_trace: true,
                },
            ]
            const pet = grantRewards(t, s, [{ itemtype: 30, itemid: 5002581, itemnum: 1 }])[0]
            s.playableRuns = {
                60001: {
                    play_id: 60001,
                    map_id: 100,
                    finish_step: 10,
                    sub_datas: [],
                    status: 2,
                    time: 1799999900,
                    selected_step: 1,
                    selected_pet_group: 1,
                    selected_pet_guid: pet.guid,
                },
            }
            s.playableChoiceReceipts = {
                '106010:1:60001': { step: 1, drop_id: 16005, pet_guid: pet.guid, pet_group: 1 },
            }
            s.taskPetChoices = { 106010: 1 }
        })
        const before = store.load(first.id).state,
            petCount = before.pets.length
        const unchanged = {}
        enter(unchanged)
        assert.equal(store.load(first.id).state.tasks[0].nodes[0].node_id, 151)
        store.log.run(first.id, 9404, 'error:' + ErrorCode.InvalidArgument, 1799999901000)
        const recovered = {},
            packets = enter(recovered),
            state = store.load(first.id).state
        assert.equal(state.tasks[0].nodes[0].node_id, 181)
        assert.equal(state.playableFinishes[60001].play_id, 60001)
        assert.equal(state.pets.length, petCount)
        assert.equal(state.player.sbag_infos.items.find((x) => x.itemid === 402000)?.itemnum, 1)
        const task = p
            .decode('SCTaskSync', packets.find((x) => x.id === 9853).payload)
            .tasks.find((x) => x.task_id === 106010)
        assert.equal(task.nodes[0].node_id, 181)
        const second = {}
        enter(second)
        const again = store.load(first.id).state
        assert.equal(again.pets.length, petCount)
        assert.equal(again.player.sbag_infos.items.find((x) => x.itemid === 402000)?.itemnum, 1)
    } finally {
        store.close()
    }
})
test('repeated Start repairs a previously failed pet choice without reopening it', () => {
    const store = new Store(':memory:'),
        game = new Game(p, store, t, { clock: () => 1800000000 }),
        session = {}
    let seq = 1
    const call = (name, r = {}) => {
        const e = p.byName.get('CSProto' + name)
        return game.dispatch(session, { id: e.id, seq: seq++, payload: p.encode(e.req, r) })
    }
    try {
        call('EnterGame', { open_id: 'failed-finish-active' })
        const graph = new TaskGraphs(t).get(106010)
        store.transact(session.id, 0, (s) => {
            s.world.map_id = 100
            s.taskRecords = [
                { task_id: 106001, count: 1, time: 1 },
                { task_id: 106002, count: 1, time: 2 },
                { task_id: 106009, count: 1, time: 3 },
            ]
            s.taskEpochs[106010] = 1
            s.tasks = [
                {
                    task_id: 106010,
                    nodes: [{ ...makeNode(graph, 151, s), client_before: true }],
                    finish_nodes: [3, 74, 78, 149, 82],
                    reward_nodes: [],
                    client_trace: true,
                },
            ]
            const pet = grantRewards(t, s, [{ itemtype: 30, itemid: 5002581, itemnum: 1 }])[0]
            s.playableRuns = {
                60001: {
                    play_id: 60001,
                    map_id: 100,
                    finish_step: 10,
                    sub_datas: [],
                    status: 2,
                    time: 1799999900,
                    selected_step: 1,
                    selected_pet_group: 1,
                    selected_pet_guid: pet.guid,
                },
            }
            s.playableChoiceReceipts = {
                '106010:1:60001': { step: 1, drop_id: 16005, pet_guid: pet.guid, pet_group: 1 },
            }
            s.taskPetChoices = { 106010: 1 }
        })
        call('WorldTimeSync', { world_time: 0 })
        store.log.run(session.id, 9404, 'error:' + ErrorCode.InvalidArgument, 1799999901000)
        const revision = store.playerById.get(session.id).revision,
            petCount = store.load(session.id).state.pets.length
        const first = call('PlayableStart', { u32: 60001 })
        assert(first.some((x) => x.id === 9400))
        assert(first.some((x) => x.id === 9853))
        assert.equal(store.load(session.id).state.tasks[0].nodes[0].node_id, 181)
        assert.equal(store.load(session.id).state.pets.length, petCount)
        const afterFirst = store.load(session.id).state
        assert.equal(afterFirst.playableRuns[60001]?.status, 3)
        assert(afterFirst.playableFinishes[60001])
        assert.equal(afterFirst.world.map_id, 100)
        const repeat = call('PlayableStart', { u32: 60001 })
        assert.deepEqual(
            repeat.map((x) => x.id),
            [9403],
        )
        assert.equal(store.playerById.get(session.id).revision, revision)
        store.flushPending()
        assert.equal(store.playerById.get(session.id).revision, revision + 1)
        assert.equal(store.load(session.id).state.player.sbag_infos.items.find((x) => x.itemid === 402000)?.itemnum, 1)
    } finally {
        store.close()
    }
})
test('login restores the missed pet-page close condition but leaves story callbacks to the client', () => {
    const store = new Store(':memory:'),
        game = new Game(p, store, t, { clock: () => 1800000000 }),
        first = {}
    let seq = 1
    const call = (session, name, r = {}) => {
        const e = p.byName.get('CSProto' + name)
        return game.dispatch(session, { id: e.id, seq: seq++, payload: p.encode(e.req, r) })
    }
    try {
        call(first, 'EnterGame', { open_id: 'missed-pet-page' })
        const graph = new TaskGraphs(t).get(106010)
        store.transact(first.id, 0, (s) => {
            s.world.map_id = 100
            s.taskRecords = [
                { task_id: 106001, count: 1, time: 1 },
                { task_id: 106002, count: 1, time: 2 },
                { task_id: 106009, count: 1, time: 3 },
            ]
            s.taskEpochs[106010] = 1
            s.tasks = [
                {
                    task_id: 106010,
                    nodes: [{ ...makeNode(graph, 181, s), client_before: true }],
                    finish_nodes: [3, 74, 78, 149, 82, 151, 148],
                    reward_nodes: [78, 82, 151],
                    client_trace: true,
                },
            ]
            const pet = grantRewards(t, s, [{ itemtype: 30, itemid: 5002581, itemnum: 1 }])[0]
            s.playableRuns = {
                60001: {
                    play_id: 60001,
                    map_id: 100,
                    finish_step: 10,
                    sub_datas: [],
                    status: 3,
                    time: 1799999900,
                    selected_step: 1,
                    selected_pet_group: 1,
                    selected_pet_guid: pet.guid,
                },
            }
            s.playableFinishes = {
                60001: {
                    play_id: 60001,
                    map_id: 100,
                    score: 0,
                    reward_info: 0,
                    selected_pet_group: 1,
                    selected_pet_guid: pet.guid,
                    finished_at: 1799999999,
                },
            }
            s.playableChoiceReceipts = {
                '106010:1:60001': { step: 1, drop_id: 16005, pet_guid: pet.guid, pet_group: 1 },
            }
            s.taskPetChoices = { 106010: 1 }
        })
        const notYet = {},
            unchanged = call(notYet, 'EnterGame', { open_id: 'missed-pet-page' }),
            node0 = store.load(first.id).state.tasks[0].nodes[0]
        assert.equal(node0.node_values[0], 0)
        assert.equal(
            p.decode('SCTaskSync', unchanged.find((x) => x.id === 9853).payload).tasks[0].nodes[0].node_values[0],
            0,
        )
        store.log.run(first.id, 9404, 'error:' + ErrorCode.InvalidArgument, 1799999901000)
        const resumed = {},
            packets = call(resumed, 'EnterGame', { open_id: 'missed-pet-page' }),
            state = store.load(first.id).state,
            node = state.tasks[0].nodes[0]
        assert.equal(node.node_id, 181)
        assert.equal(node.node_values[0], 1)
        assert.equal(node.client_cond_after[0], false)
        assert.equal(state.taskEvents['106010:1:181:0'], 1)
        assert.equal(
            p.decode('SCTaskSync', packets.find((x) => x.id === 9853).payload).tasks[0].nodes[0].node_values[0],
            1,
        )
        call(resumed, 'TaskClientCondAfter', { task_id: 106010, node_id: 181, indexes: [0] })
        call(resumed, 'TaskClientAfter', { task_id: 106010, node_id: 181 })
        assert.equal(store.load(first.id).state.tasks[0].nodes[0].node_id, 168)
        const again = {}
        call(again, 'EnterGame', { open_id: 'missed-pet-page' })
        assert.equal(store.load(first.id).state.tasks[0].nodes[0].node_id, 168)
    } finally {
        store.close()
    }
})
