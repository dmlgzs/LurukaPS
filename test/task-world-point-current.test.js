import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables, seedPlayer } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { newStarterProfile } from '../src/starter-profile.js'
import { TaskGraphs, acceptTask, makeNode } from '../src/tasks.js'
import { ErrorCode } from '../src/error-codes.js'
import { currentTaskTransferPoint } from '../src/task-scenes.js'

test('current same-scene task transfer uses its pending action without unlocking ordinary points', () => {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base),
        store = new Store(':memory:'),
        now = 1800000000,
        game = new Game(protocol, store, tables, { clock: () => now }),
        session = {},
        name = 'task-world-point-current'
    let seq = 1
    const call = (name, request = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, {
            id: entry.id,
            seq: seq++,
            payload: entry.req ? protocol.encode(entry.req, request) : Buffer.alloc(0),
        })
    }
    const state = () => store.load(session.id).state
    const assets = (s) => structuredClone({ player: s.player, pets: s.pets, eggs: s.petEggs, ornaments: s.ornaments })
    try {
        store.login(name, (id, account) => {
            const s = seedPlayer(tables, id, account)
            s.starterProfile = newStarterProfile('normal')
            s.world.points = []
            return s
        })
        call('EnterGame', { open_id: name })
        // Prepared normal-account leaf; not a replay or proof of earned story progress.
        store.transact(session.id, 0, (s) => {
            const graph = new TaskGraphs(tables).get(106001)
            s.tasks = []
            const task = acceptTask(graph, s, now)
            task.nodes = [makeNode(graph, 60, s)]
            Object.assign(s.world, tables.position(tables.find('world_borthpos', 10201)))
            s.world.points = []
        })
        const before = assets(state()),
            node = structuredClone(state().tasks.find((t) => t.task_id === 106001).nodes),
            revision = state().worldPointRewardRevision
        const packets = call('WorldPoint', {
            point_id: 10203,
            is_stuck: false,
            client_trans_data: 2,
            is_keep_playable: false,
        })
        assert(packets.some((packet) => packet.id === 9132))
        const sync = packets
            .filter((packet) => packet.id === 9103)
            .map((packet) => protocol.decode(protocol.byId.get(9103).rsp, packet.payload))
            .find((data) => data.cmd === 19)
        assert(sync)
        assert.equal(sync.map_id, 102)
        assert.equal(sync.client_trans_data, 2)
        assert.deepEqual(state().world.pos, tables.position(tables.find('world_borthpos', 10203)).pos)
        assert.deepEqual(state().world.points, [])
        assert.equal(state().worldPointRewardRevision, revision)
        assert.deepEqual(assets(state()), before)
        assert.deepEqual(state().tasks.find((t) => t.task_id === 106001).nodes, node)
        // Once Before is acknowledged its transfer is no longer a pending action.
        call('TaskClientBefore', { task_id: 106001, node_id: 60 })
        const saved = structuredClone(state())
        assert.throws(
            () => call('WorldPoint', { point_id: 10203, client_trans_data: 2 }),
            (error) => error.code === ErrorCode.InvalidArgument,
        )
        assert.deepEqual(state(), saved)
        assert.throws(
            () => call('WorldPoint', { point_id: 10201, client_trans_data: 2 }),
            (error) => error.code === ErrorCode.InvalidArgument,
        )
        assert.deepEqual(state(), saved)
    } finally {
        store.close()
    }
})

test('a current After transfer waits for its validated condition receipt and expires with the active node', () => {
    const tables = new Tables(configuration().tables),
        graph = new TaskGraphs(tables).get(102010),
        point = tables.find('world_borthpos', 1013944),
        node = { node_id: 16, client_before: true, client_cond_after: [false] },
        task = { task_id: 102010, nodes: [node] },
        state = { world: { map_id: point.cityId }, tasks: [task] }
    assert.equal(
        graph.nodes.get(16).__type_TaskConditionNodeData.afterActionList[1].__type_TaskActionBaseData
            .__type_TaskTransferBaseData.transferPointId,
        point.id,
    )
    assert.equal(currentTaskTransferPoint(tables, state, point), null)
    // Prepared server CondAfter receipt; this test does not fabricate or send
    // a client-owned condition value and does not test the preceding dialogue.
    node.client_cond_after[0] = true
    assert.equal(currentTaskTransferPoint(tables, state, point), point)
    state.world.map_id = 102
    assert.equal(currentTaskTransferPoint(tables, state, point), null)
    state.world.map_id = point.cityId
    task.nodes = []
    assert.equal(currentTaskTransferPoint(tables, state, point), null)
})
