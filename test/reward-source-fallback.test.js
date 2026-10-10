import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Game } from '../src/game.js'
import { Store } from '../src/store.js'
import { TaskGraphs, makeNode } from '../src/tasks.js'
import { grantRewards } from '../src/rewards.js'
test('missing source metadata cannot roll back a real task hero reward; retry remains once-only', () => {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base),
        store = new Store(':memory:')
    const find = tables.find.bind(tables)
    tables.find = (name, id) => (name === 'reason_itemnum_change' ? undefined : find(name, id))
    const game = new Game(protocol, store, tables),
        session = {}
    let seq = 1
    const call = (name, request) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, request) })
    }
    try {
        call('EnterGame', { open_id: 'source-fallback' })
        store.transact(session.id, 0, (s) => {
            Object.assign(s.world, tables.position(tables.find('world_borthpos', 10045)))
            const graph = new TaskGraphs(tables).get(106009)
            s.tasks = [
                {
                    task_id: 106009,
                    nodes: [{ ...makeNode(graph, 10, s), client_before: true }],
                    finish_nodes: [3, 4, 7, 8],
                    reward_nodes: [],
                },
            ]
            s.player.heros_info.heros = s.player.heros_info.heros.filter((h) => h.conf_id !== 108001)
        })
        const request = { task_id: 106009, node_id: 10 }
        const packets = call('TaskClientAfter', request)
        const reward = protocol.decode('cs.Rewards', packets.find((p) => p.id === 9862).payload)
        assert.equal(reward.src, undefined)
        assert.equal(reward.rewards[0].itemtype, 1)
        assert.equal(reward.rewards[0].itemid, 108001)
        assert.equal(store.load(session.id).state.player.heros_info.heros.filter((h) => h.conf_id === 108001).length, 1)
        const retry = protocol.decode('cs.Rewards', call('TaskClientAfter', request).find((p) => p.id === 9862).payload)
        assert.deepEqual(retry.rewards, reward.rewards)
        assert.equal(store.load(session.id).state.player.heros_info.heros.filter((h) => h.conf_id === 108001).length, 1)
        assert.throws(
            () => grantRewards(tables, store.load(session.id).state, [{ itemtype: 1, itemid: 108001, itemnum: -1 }]),
            /Invalid reward quantity/,
        )
    } finally {
        store.close()
    }
})
