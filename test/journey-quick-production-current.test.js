import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { TaskGraphs, makeNode } from '../src/tasks.js'
import { homeCondition } from '../src/home-grid.js'

const config = configuration(),
    tables = new Tables(config.tables),
    protocol = new Protocol(config.base),
    targetId = 1010001,
    productId = 501001,
    cardId = 1000001,
    materialId = 312001
const quantity = (state, id) =>
    state.player.sbag_infos.items.filter((row) => row.itemid === id).reduce((n, row) => n + row.itemnum, 0)
class Consumer {
    targets = new Map()
    stock = new Map()
    trace = 0
    consume(packets) {
        for (const packet of packets) {
            if (packet.id === 11880) {
                const data = protocol.decode(protocol.byId.get(packet.id).rsp, packet.payload)
                this.trace = data.trace_id ?? 0
                for (const row of data.journey_target) this.targets.set(row.target_id, row)
            }
            if (packet.id === 5008) {
                const data = protocol.decode(protocol.byId.get(packet.id).rsp, packet.payload)
                if (data.sbag_infos) for (const row of data.sbag_infos.items) this.stock.set(row.itemid, row.itemnum)
            }
        }
    }
    progress() {
        return this.targets.get(targetId).target_progress.find((row) => row.condition_id === 12067).condition_val
    }
    status() {
        return this.targets.get(targetId).target_reward_status
    }
}
function fixture(name) {
    const store = new Store(':memory:'),
        session = {},
        game = new Game(protocol, store, tables, { clock: () => now })
    let now = 1800000000,
        seq = 1
    const call = (name, data = {}, peer = session) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(peer, {
            id: entry.id,
            seq: seq++,
            payload: entry.req ? protocol.encode(entry.req, data) : Buffer.alloc(0),
        })
    }
    const consumer = new Consumer(),
        initial = call('EnterGame', { open_id: 'journey-quick-' + name })
    consumer.consume(initial)
    const graph = new TaskGraphs(tables).get(106010)
    store.transact(session.id, 0, (state) => {
        // Trusted current crafting-stage qualification, not crafted output or
        // journey progress. System164 specifically requires finished node168.
        Object.assign(state.world, tables.position(tables.find('world_borthpos', 10050)))
        state.player.basic_info.lv = 3
        state.taskRecords = [106001, 106002, 106009].map((task_id) => ({ task_id, count: 1, time: now - 1 }))
        state.taskEpochs[106010] = 1
        state.tasks = [
            {
                task_id: 106010,
                nodes: [{ ...makeNode(graph, 154, state), client_before: true }],
                finish_nodes: [3, 74, 78, 149, 82, 151, 148, 181, 168],
                reward_nodes: [],
                client_trace: true,
            },
        ]
        assert(homeCondition(tables.find('system_unlock', 164).unlockCondi, state))
    })
    consumer.consume(call('GMCommand', { command: Buffer.from('item 312001 10').toString('base64') }))
    consumer.consume(call('JourneyClientTrace', { journey_id: targetId, is_trace: true }))
    const state = () => store.load(session.id).state
    return {
        store,
        game,
        session,
        call,
        consumer,
        state,
        start: (count) => {
            const packets = call('SimpleProductStart', { product_id: productId, count, select_material: [] })
            consumer.consume(packets)
            return state().simpleProducts.at(-1).guid
        },
        tick: (seconds) => {
            now += seconds
            const packets = game.tick(session.id, session)
            consumer.consume(packets)
            return packets
        },
        relog: () => {
            const packets = call('EnterGame', { open_id: 'journey-quick-' + name, reconnect: true }, {})
            consumer.consume(packets)
            return packets
        },
    }
}
function assertTick(f, packets, value) {
    const inventory = packets.findIndex((packet) => packet.id === 5008),
        journey = packets.findIndex((packet) => packet.id === 11880),
        callback = packets.findIndex((packet) => packet.id === 11014)
    assert(
        inventory >= 0 && journey > inventory && callback > journey,
        'actual stock then journey progress must arrive before quick-production completion callbacks',
    )
    assert.equal(f.state().simpleProduced['3:1000001'], value)
    assert.equal(f.state().journey.targets[targetId].value, value)
    assert.equal(f.consumer.progress(), value)
    assert.equal(f.consumer.status(), value >= 5 ? 1 : 0)
}

test('actual portable1+4 advances Journey card online to5 before each11014, then claim/cancel and cold login preserve the completed facts', () => {
    const f = fixture('one-plus-four')
    try {
        const originalCards = quantity(f.state(), cardId)
        assert.equal(f.state().simpleProduced?.['3:1000001'] ?? 0, 0, 'GM material funding is not production')
        f.start(1)
        assertTick(f, f.tick(1), 1)
        f.start(4)
        assertTick(f, f.tick(4), 5)
        assert.equal(quantity(f.state(), cardId), originalCards + 5)
        assert.equal(quantity(f.state(), materialId), 0)
        assert.equal(f.consumer.stock.get(cardId), originalCards + 5)
        const claimed = f.call('JourneyTaskFinish', { u32s: [targetId] })
        f.consumer.consume(claimed)
        assert.equal(f.state().journey.targets[targetId].claimed, true)
        assert.equal(f.consumer.status(), 2)
        const canceled = f.call('JourneyClientTrace', { journey_id: targetId }) // false omitted: current proto2 contract.
        f.consumer.consume(canceled)
        assert.equal(f.consumer.trace, 0)
        assert.equal(f.state().journey.traceId, 0)
        f.relog()
        assert.equal(f.consumer.trace, 0)
        assert.equal(f.consumer.progress(), 5)
        assert.equal(f.consumer.status(), 2)
        const before = quantity(f.state(), cardId)
        f.tick(100)
        assert.equal(quantity(f.state(), cardId), before)
        assert.equal(f.state().simpleProduced['3:1000001'], 5)
    } finally {
        f.store.close()
    }
})

test('one real batch5 reports partial2 then final5, drains its queue and does not count a duplicate tick twice', () => {
    const f = fixture('batch-five')
    try {
        const originalCards = quantity(f.state(), cardId),
            job = f.start(5)
        assertTick(f, f.tick(2), 2)
        assert.equal(f.state().simpleProducts[0].credited, 2)
        const final = f.tick(3)
        assertTick(f, final, 5)
        assert.deepEqual(
            protocol.decode(protocol.byId.get(11014).rsp, final.find((packet) => packet.id === 11014).payload).dels,
            [job],
        )
        assert.deepEqual(f.state().simpleProducts, [])
        f.tick(50)
        assert.equal(quantity(f.state(), cardId), originalCards + 5)
        assert.equal(f.consumer.progress(), 5)
        assert.equal(f.state().journey.targets[targetId].complete, true)
    } finally {
        f.store.close()
    }
})

test('canceling a partially completed batch refunds only unfinished materials, preserves actual produced progress and allows real trace cancellation', () => {
    const f = fixture('cancel')
    try {
        const originalCards = quantity(f.state(), cardId),
            job = f.start(5)
        assertTick(f, f.tick(2), 2)
        f.consumer.consume(f.call('SimpleProductCancel', { u32: job }))
        assert.equal(quantity(f.state(), materialId), 6)
        assert.equal(quantity(f.state(), cardId), originalCards + 2)
        assert.equal(f.state().simpleProduced['3:1000001'], 2)
        assert.equal(f.consumer.progress(), 2)
        f.consumer.consume(f.call('SimpleProductCancel', { u32: job }))
        assert.equal(quantity(f.state(), materialId), 6)
        assert.equal(f.state().journey.targets[targetId].complete, false)
        f.consumer.consume(f.call('JourneyClientTrace', { journey_id: targetId, is_trace: false }))
        assert.equal(f.consumer.trace, 0)
        f.relog()
        assert.equal(f.consumer.trace, 0)
        assert.equal(f.consumer.progress(), 2)
        assert.equal(f.consumer.status(), 0)
    } finally {
        f.store.close()
    }
})
