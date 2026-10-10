import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Protocol } from '../src/protocol.js'
import { Game } from '../src/game.js'
import { TaskGraphs, makeNode } from '../src/tasks.js'
import { prepareTaskScenes } from '../src/task-scenes.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)

test('legacy scene recovery does not rewind a node from its configured after-transfer scene', () => {
    const state = {
        world: tables.position(tables.find('world_borthpos', 25101)),
        tasks: [{ task_id: 106018, nodes: [{ node_id: 22, client_before: true, client_cond_after: [true] }] }],
        taskEpochs: { 106018: 1 },
    }
    state.world.pos.x += 143
    const world = structuredClone(state.world)
    assert.equal(prepareTaskScenes(tables, state, { login: true }), false)
    assert.deepEqual(state.world, world, 'the node has already transferred from scene250 to scene251')
    assert.equal(state.pendingTaskScene, undefined)
    assert.equal(prepareTaskScenes(tables, state), false, 'later requests must not replay its before transfer')

    // A genuinely wrong scene still needs the existing pre-action recovery.
    state.world = tables.position(tables.find('world_borthpos', 10045))
    state.taskSceneReceipts = {}
    assert.equal(prepareTaskScenes(tables, state, { login: true }), true)
    assert.equal(state.world.map_id, 250)
    assert.equal(state.world.point_id, 25001)
})

test('cooking story follows configured performance dorm transfer and returns to home before node27', () => {
    const f = setup()
    try {
        const graph = new TaskGraphs(tables).get(106016)
        f.edit((s) => {
            s.taskEpochs[106016] = 1
            s.taskRecords = tables
                .get('task')
                .filter((row) => row.type === 1 && row.id !== 106016)
                .map((row) => ({ task_id: row.id, count: 1, time: 1 }))
            s.home.craftCounts = { 9100101: 1, 9100301: 1 }
            s.tasks = [
                {
                    task_id: 106016,
                    nodes: [{ ...makeNode(graph, 26, s), client_before: true }],
                    finish_nodes: [1, 25],
                    reward_nodes: [],
                },
            ]
            Object.assign(s.world, tables.position(tables.find('world_borthpos', 70101)))
            delete s.pendingTaskScene
        })
        f.call('TaskClientCondAfter', { task_id: 106016, node_id: 26, indexes: [0, 1] })
        assert.equal(f.state().world.map_id, 701, 'completion of recipes must not preempt the action sequence')
        const entry = f.call('EnterWorldMap', {
            task_id: 106016,
            node_id: 26,
            map_id: 710,
            point_id: 780301,
            client_trans_data: 2,
        })
        assert.equal(entry.find((packet) => packet.id === 9103).data.map_id, 710)
        assert.equal(tables.find('world_city', 710).artScene, 'unity_charluluherodorm_art')
        assert.equal(f.state().tasks[0].nodes[0].node_id, 26)
        f.call('SetStoryId', { story_id: 101176, story_type: 0 })
        assert.equal(f.state().world.map_id, 710, 'story report does not replace the client return action')
        const returned = f.call('EnterWorldMap', { task_id: 106016, node_id: 26, map_id: 701, point_id: 70101 })
        assert.equal(returned.find((packet) => packet.id === 9103).data.map_id, 701)
        f.call('TaskClientAfter', { task_id: 106016, node_id: 26 })
        assert.equal(f.state().tasks[0].nodes[0].node_id, 27)
        assert.equal(f.state().world.map_id, 701)
        f.login()
        assert.equal(f.state().world.map_id, 701)
    } finally {
        f.store.close()
    }
})
function setup() {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables)
    let who = {},
        seq = 1
    const call = (name, r = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(who, { id: e.id, seq: seq++, payload: protocol.encode(e.req, r) })
            .map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    }
    const login = () => {
        who = {}
        return call('EnterGame', { open_id: 'scene-test' })
    }
    login()
    return { store, call, login, state: () => store.load(who.id).state, edit: (fn) => store.transact(who.id, 0, fn) }
}

function homeExitFixture() {
    const f = setup(),
        graph = new TaskGraphs(tables).get(106016)
    f.edit((s) => {
        s.taskEpochs[106016] = 1
        s.taskRecords = tables
            .get('task')
            .filter((row) => row.type === 1 && row.id !== 106016)
            .map((row) => ({ task_id: row.id, count: 1, time: 1 }))
        s.tasks = [
            {
                task_id: 106016,
                nodes: [{ ...makeNode(graph, 27, s), client_before: true }],
                finish_nodes: [1, 25, 26],
                reward_nodes: [],
            },
        ]
        delete s.pendingTaskScene
    })
    return f
}

function homeArrivalFixture() {
    const f = homeExitFixture(),
        graph = new TaskGraphs(tables).get(106016)
    f.edit((s) => {
        Object.assign(s.world, tables.position(tables.find('world_borthpos', 20002)))
        s.tasks[0].nodes = [{ ...makeNode(graph, 29, s), client_before: true }]
        s.tasks[0].finish_nodes = [1, 25, 26, 27, 28]
    })
    return f
}

test('home arrival condition remains complete after the configured performance transfer and story', () => {
    const f = homeArrivalFixture(),
        ack = { task_id: 106016, node_id: 29 }
    try {
        assert.throws(() => f.call('TaskClientCondAfter', { ...ack, indexes: [0] }), /condition not complete/)
        assert.throws(() => f.call('TaskClientAfter', ack), /conditions not complete/)
        assert.throws(
            () => f.call('ClientBehaviourRecord', { key: 2519, args: [701, 106016, 29, 0, 1] }),
            /different map/,
        )
        f.call('EnterHome')
        f.call('TaskClientCondAfter', { ...ack, indexes: [0] })
        f.call('EnterWorldMap', { ...ack, map_id: 710, point_id: 780301 })
        assert.equal(f.state().world.map_id, 710)
        assert.equal(f.state().tasks.find((t) => t.task_id === 106016).nodes[0].node_values[0], 1)
        f.call('SetStoryId', { story_id: 101180, story_type: 0 })
        f.call('TaskClientAfter', ack)
        assert.equal(f.state().tasks.find((t) => t.task_id === 106016).nodes[0].node_id, 30)
        const before = f.state().tasks.find((t) => t.task_id === 106016)
        f.call('TaskClientAfter', ack)
        assert.deepEqual(
            f.state().tasks.find((t) => t.task_id === 106016),
            before,
        )
    } finally {
        f.store.close()
    }
})

test('old acknowledged scene condition survives relog in performance map; unacknowledged conditions do not', () => {
    const f = homeArrivalFixture(),
        ack = { task_id: 106016, node_id: 29 }
    try {
        f.edit((s) => {
            Object.assign(s.world, tables.position(tables.find('world_borthpos', 780301)))
            s.tasks[0].nodes[0].node_values = [0]
            s.tasks[0].nodes[0].client_cond_after = [true]
        })
        f.login()
        assert.equal(f.state().tasks.find((t) => t.task_id === 106016).nodes[0].node_values[0], 1)
        f.call('TaskClientAfter', ack)
        assert.equal(f.state().tasks.find((t) => t.task_id === 106016).nodes[0].node_id, 30)
        const graph = new TaskGraphs(tables).get(106016)
        f.edit((s) => {
            s.taskEpochs[106016]++
            s.tasks.find((t) => t.task_id === 106016).nodes = [{ ...makeNode(graph, 29, s), client_before: true }]
            s.tasks.find((t) => t.task_id === 106016).finish_nodes = [1, 28]
        })
        f.login()
        assert.throws(() => f.call('TaskClientAfter', ack), /conditions not complete/)
    } finally {
        f.store.close()
    }
})

test('home exit escapes a completed story performance scene and skips intermediate home history', () => {
    const f = homeExitFixture()
    try {
        const origin = tables.position(tables.find('world_borthpos', 20002))
        origin.pos = { ...origin.pos, x: origin.pos.x + 137 }
        for (const current of [710, 701]) {
            f.edit((s) => {
                Object.assign(s.world, tables.position(tables.find('world_borthpos', current === 710 ? 780301 : 70101)))
                s.worldHistory = [
                    origin,
                    tables.position(tables.find('world_borthpos', 70101)),
                    tables.position(tables.find('world_borthpos', 780301)),
                    tables.position(tables.find('world_borthpos', 70101)),
                ]
                s.pendingTaskScene = { task_id: 106016, node_id: 26, map_id: 710, point_id: 780301 }
            })
            const before = f.state(),
                packets = f.call('WorldQuitHome')
            assert.equal(f.state().world.map_id, 200)
            assert.deepEqual(f.state().world.pos, origin.pos)
            assert.equal(packets.find((packet) => packet.id === 9103).data.cmd, 256)
            assert.deepEqual(
                f.state().tasks.find((task) => task.task_id === 106016),
                before.tasks.find((task) => task.task_id === 106016),
            )
            assert.deepEqual(f.state().player.group_mgrs, before.player.group_mgrs)
            assert.equal(f.state().pendingTaskScene, undefined)
            assert.deepEqual(f.state().worldHistory, [])
            assert.ok(
                !f.call('WorldQuitHome').some((packet) => packet.id === 9103),
                'duplicate exit outside home is harmless',
            )
            f.login()
            assert.equal(f.state().world.map_id, 200)
        }
    } finally {
        f.store.close()
    }
})

test('home exit with only temporary scenes left uses exploration fallback and preserves normal interior returns', () => {
    const f = homeExitFixture()
    try {
        f.edit((s) => {
            Object.assign(s.world, tables.position(tables.find('world_borthpos', 780301)))
            s.worldHistory = [tables.position(tables.find('world_borthpos', 70101))]
        })
        f.call('WorldQuitHome')
        assert.equal(f.state().world.point_id, 10045)
        const interior = tables.position(tables.find('world_borthpos', 25001))
        f.edit((s) => {
            Object.assign(s.world, tables.position(tables.find('world_borthpos', 70101)))
            s.worldHistory = [interior]
        })
        f.call('WorldQuitHome')
        assert.equal(f.state().world.map_id, interior.map_id)
        assert.deepEqual(f.state().world.pos, interior.pos)
    } finally {
        f.store.close()
    }
})
test('initial story starts on configured scene102 and legacy node5 wrong-map save recovers without losing progress', () => {
    const f = setup()
    try {
        assert.equal(f.state().world.map_id, 102)
        assert.equal(f.state().world.point_id, 10201)
        f.edit((s) => {
            Object.assign(s.world, tables.position(tables.find('world_borthpos', 10045)))
            delete s.taskSceneReceipts
            s.tasks[0].nodes[0].client_before = true
            s.storyIds = [100001, 100101]
        })
        f.login()
        assert.equal(f.state().world.map_id, 102)
        assert.equal(f.state().tasks[0].nodes[0].client_before, true)
        assert.deepEqual(f.state().storyIds, [100001, 100101])
        const entered = f.call('EnterWorldMap', { map_id: 100, point_id: 10045, reconnect: true })
        assert.equal(entered.find((p) => p.id === 9103).data.map_id, 102)
        const control = f.state().player.group_mgrs[0].groups[0].control,
            pos = { x: 58000, y: 10500, z: 24000 }
        f.call('StateUpdate', { move_msg: { map_id: 102, move: [{ uuid: control, info: { pos } }] } })
        f.login()
        assert.deepEqual(f.state().world.pos, pos)
    } finally {
        f.store.close()
    }
})
test('task cross-scene transfer uses configured birthpoint10401 and rejects forged or inactive node', () => {
    const f = setup()
    try {
        const graph = new TaskGraphs(tables).get(106002)
        f.edit((s) => {
            s.taskRecords = [{ task_id: 106001, count: 1, time: 1 }]
            s.tasks = [{ task_id: 106002, nodes: [makeNode(graph, 59, s)], finish_nodes: [1, 56], reward_nodes: [] }]
            delete s.pendingTaskScene
        })
        const mount = f.state().pets.find((p) => p.config_id === 500022)
        f.call('WorldMapPlayerStatus', { status: 1, arg: mount.guid })
        f.call('WorldMapPlayerMountStatus', { u32: 2 })
        const before = f.state()
        assert.throws(
            () => f.call('EnterWorldMap', { task_id: 106002, node_id: 59, map_id: 100, point_id: 10045 }),
            /not configured/,
        )
        assert.deepEqual(f.state(), before)
        const packets = f.call('EnterWorldMap', {
            task_id: 106002,
            node_id: 59,
            map_id: 104,
            point_id: 10401,
            client_trans_data: 2,
        })
        assert.equal(f.state().world.map_id, 104)
        assert.equal(f.state().world.status, 0)
        assert.equal(f.state().world.status_arg, '0')
        assert.equal(f.state().world.mount, '0')
        assert.equal(f.state().world.mount_status, 0)
        assert.equal(f.state().mountRideId, mount.guid)
        const entryPlayer = packets.find((p) => p.id === 9103).data.map_info.players[0]
        assert.equal(entryPlayer.status, 0)
        assert.equal(entryPlayer.mount, '0')
        assert.equal(entryPlayer.mount_status, 0)
        assert.equal(entryPlayer.mount_move, undefined)
        assert.deepEqual(f.state().world.pos, tables.position(tables.find('world_borthpos', 10401)).pos)
        assert.equal(packets.find((p) => p.id === 9103).data.client_trans_data, 2)
        assert.throws(
            () => f.call('EnterWorldMap', { task_id: 106002, node_id: 999, map_id: 104, point_id: 10401 }),
            /not active/,
        )
        f.call('TaskClientBefore', { task_id: 106002, node_id: 59 })
        f.login()
        assert.equal(f.state().world.map_id, 104)
    } finally {
        f.store.close()
    }
})
test('same-scene point transport starts native player transfer flow with cmd19 and its transfer marker', () => {
    const f = setup()
    try {
        const result = f.call('WorldPoint', { point_id: 10203, client_trans_data: 73 })
        const map = result.find((p) => p.id === 9103).data
        assert.equal(map.cmd, 19)
        assert.equal(map.client_trans_data, 73)
        assert.equal(map.map_id, 102)
        assert.equal(f.state().world.point_id, 10203)
        const entry = f.call('EnterWorldMap', { map_id: 102 })
        assert.equal(entry.find((p) => p.id === 9103).data.cmd, 256)
    } finally {
        f.store.close()
    }
})
test('prologue end node accepts its configured transfer to scene251 before TaskFinish', () => {
    const f = setup()
    try {
        const graph = new TaskGraphs(tables).get(106002)
        f.edit((s) => {
            s.taskRecords = [{ task_id: 106001, count: 1, time: 1 }]
            s.tasks = [
                {
                    task_id: 106002,
                    nodes: [makeNode(graph, 60, s)],
                    finish_nodes: [1, 56, 65, 61, 58, 63, 62, 57, 59, 64],
                    reward_nodes: [],
                },
            ]
            Object.assign(s.world, tables.position(tables.find('world_borthpos', 10401)))
            delete s.pendingTaskScene
        })
        const before = f.state()
        assert.throws(
            () => f.call('EnterWorldMap', { task_id: 106002, node_id: 60, map_id: 100, point_id: 10045 }),
            /not configured/,
        )
        assert.deepEqual(f.state(), before)
        const packets = f.call('EnterWorldMap', {
            task_id: 106002,
            node_id: 60,
            map_id: 251,
            point_id: 25101,
            client_trans_data: 2,
        })
        assert.equal(f.state().world.map_id, 251)
        assert.equal(f.state().world.point_id, 25101)
        assert.equal(packets.find((p) => p.id === 9103).data.map_id, 251)
        f.call('TaskFinish', { u32: 106002 })
        assert.equal(f.state().taskRecords.find((x) => x.task_id === 106002).count, 1)
    } finally {
        f.store.close()
    }
})
test('CBT3 one-way WorldPointAck records flow completion without moving or rewarding twice', () => {
    const f = setup()
    try {
        f.call('WorldPoint', { point_id: 102002, client_trans_data: 2 })
        const before = f.state(),
            packets = f.call('WorldPointAck')
        assert.deepEqual(packets, [])
        const after = f.state()
        assert.deepEqual(after.world.pos, before.world.pos)
        assert.equal(after.world.point_id, 102002)
        assert.equal(after.world.last_point_ack.point_id, 102002)
        assert.deepEqual(after.player.sbag_infos, before.player.sbag_infos)
        f.call('WorldPointAck')
        assert.deepEqual(f.state().world.pos, after.world.pos)
    } finally {
        f.store.close()
    }
})
test('prologue active behavior3 recovers HP in place without injecting a transfer or advancing the story', () => {
    const f = setup()
    try {
        const graph = new TaskGraphs(tables).get(106002)
        f.edit((s) => {
            s.tasks = [{ task_id: 106002, nodes: [makeNode(graph, 59, s)], finish_nodes: [1], reward_nodes: [] }]
            s.taskRecords = [{ task_id: 106001, count: 1, time: 1 }]
            Object.assign(s.world, tables.position(tables.find('world_borthpos', 10401)))
            s.world.pos.x += 800
            const manager = s.player.group_mgrs.find((entry) => entry.type === 1)
            manager.groups.find((entry) => entry.id === manager.cur_group).heros[0].hero_id =
                s.player.heros_info.heros[0].guid
        })
        const before = f.state(),
            packets = f.call('WorldMapActiveBehavior', { type: 3 })
        assert.ok(!packets.some((x) => x.id === 9103))
        assert.ok(packets.some((x) => x.id === protocol.byName.get('CSProtoObjBattleInfoSync').id))
        assert.equal(f.state().world.point_id, 10401)
        assert.deepEqual(f.state().world.pos, before.world.pos)
        assert.equal(f.state().tasks[0].nodes[0].node_id, 59)
        assert.deepEqual(f.state().player.sbag_infos, before.player.sbag_infos)
        const saved = f.state()
        assert.throws(() => f.call('WorldMapActiveBehavior', { type: 99 }), /not implemented/)
        assert.deepEqual(f.state(), saved)
    } finally {
        f.store.close()
    }
})
