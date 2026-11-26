import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { TaskGraphs, makeNode } from '../src/tasks.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base),
    request = { task_id: 107016, node_id: 41, indexes: [0] },
    ids = tables
        .get('dungeon_task')
        .find((row) => row.dungeonId === 10031)
        .taskIds.split('|')
        .map(Number)
test('actual cleared10031 recovers parent107016/41 NPC create/delete preparation before CondAfter, but incomplete proof or active battles do not', () => {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables),
        session = {}
    let seq = 1
    const call = (name, r = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, r) })
    }
    // Current full saved-proof fixture; the migration suite separately covers
    // the actual historical ten-task writer artifact and bootstrap boundary.
    try {
        assert.equal(ids.length, 15)
        assert.equal(ids.at(-1), 104010)
        call('EnterGame', { open_id: 'cleanup-before' })
        store.transact(session.id, 0, (s) => {
            s.world.map_id = 6224
            const graph = new TaskGraphs(tables).get(107016)
            s.tasks = [
                {
                    task_id: 107016,
                    nodes: [makeNode(graph, 41, s)],
                    finish_nodes: [40],
                    reward_nodes: [],
                    client_trace: true,
                    start_time: 1,
                },
            ]
            s.taskEpochs[107016] = 1
            s.taskRecords = tables
                .get('task')
                .filter((t) => t.type === 1 && t.id !== 107016)
                .map((t) => ({ task_id: t.id, count: 1, time: 1 }))
            s.storyCampaign = { status: 3, dungeon_id: 10031 }
            s.storyCampaignClears ??= {}
            s.storyCampaignClears[10031] = { count: 1, time: 1 }
            delete s.pendingTaskStorySync
        })
        assert.equal(
            createHash('sha256')
                .update(protocol.encode(protocol.byName.get('CSProtoTaskClientCondAfter').req, request))
                .digest('hex'),
            '841f58287a8c48c03bed0feacdc7f4d7e721a4837847fcaa0a5e7cb199a18159',
        )
        assert.throws(() => call('TaskClientCondAfter', request), /pre-action is not acknowledged/)
        store.transact(session.id, 0, (s) => {
            s.storyCampaignClears[10031].task_proof = { victory_task_id: 104010, task_ids: ids }
            s.storyCampaign.status = 2
        })
        assert.throws(() => call('TaskClientCondAfter', request), /pre-action is not acknowledged/)
        store.transact(session.id, 0, (s) => {
            s.storyCampaign.status = 3
        })
        const before = store.load(session.id).state.player.basic_info
        const packets = call('TaskClientCondAfter', request)
        assert.ok(packets.findIndex((p) => p.id === 9853) < packets.findIndex((p) => p.id === 9863))
        call('TaskClientCondAfter', request)
        const s = store.load(session.id).state,
            node = s.tasks.find((t) => t.task_id === 107016).nodes[0]
        assert.equal(node.node_id, 41)
        assert.equal(node.client_before, true)
        assert.equal(node.client_cond_after[0], true)
        assert.equal(node.node_values[0], 1)
        assert.equal(s.world.map_id, 6224)
        assert.deepEqual(s.player.basic_info, before)
    } finally {
        store.close()
    }
})
