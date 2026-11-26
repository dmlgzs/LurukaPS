import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { optimizeSyncPackets } from '../src/sync-delta.js'

const protocol = new Protocol(configuration().base)
const entry = protocol.byName.get('CSProtoPetEggInfoSync')
const packet = (value, meta = {}) => ({ id: entry.id, payload: protocol.encode(entry.rsp, value), ...meta })
const data = (value) => protocol.decode(entry.rsp, value.payload)
const egg = (guid, hatch_state = 0) => ({ guid, configid: 20004001, hatch_state })
const optimize = (session, value, request = 'normal') =>
    optimizeSyncPackets(protocol, session, [packet(value)], request)
function consumer() {
    const state = { card: 0, free: 0, eggs: new Map() }
    return {
        state,
        read(packets) {
            for (const frame of packets) {
                const value = data(frame)
                // Current OnSocket6518/06029c19 reads both scalar getters
                // unconditionally; protobuf's omitted uint32 getter is zero.
                state.card = value.default_catch_card_id ?? 0
                state.free = value.free_reward_num ?? 0
                for (const row of value.egg_infos?.eggs ?? []) state.eggs.set(row.guid, row)
                for (const guid of value.egg_infos?.guid ?? []) state.eggs.delete(guid)
            }
        },
    }
}

test('current6518 row additions, updates and removals retain the original default-card and free-count getters', () => {
    const session = { id: 1 },
        client = consumer()
    const snapshot = (rows, guid = []) => ({
        default_catch_card_id: 1000003,
        free_reward_num: 17,
        last_free_time: 1800000000,
        egg_infos: { eggs: rows, guid },
    })
    client.read(optimize(session, snapshot([egg(1)]), 'CSProtoEnterGame'))
    assert.equal(client.state.card, 1000003)
    assert.equal(client.state.free, 17)
    for (const value of [snapshot([egg(1), egg(2)]), snapshot([egg(1, 1), egg(2)]), snapshot([egg(1, 1)], [2])]) {
        const frames = optimize(session, value)
        assert.equal(frames.length, 1)
        client.read(frames)
        assert.equal(client.state.card, 1000003)
        assert.equal(client.state.free, 17)
    }
    assert.equal(client.state.eggs.size, 1)
    assert.equal(client.state.eggs.get(1).hatch_state, 1)
    assert.deepEqual(optimize(session, snapshot([egg(1, 1)])), [], 'unchanged snapshots still suppress the packet')
})

test('omitted zero scalar getters update the sent cache and returning to the same nonzero values is not suppressed', () => {
    const session = { id: 1 },
        client = consumer()
    const initial = { default_catch_card_id: 1000003, free_reward_num: 17, egg_infos: { eggs: [egg(1)] } }
    client.read(optimize(session, initial, 'CSProtoEnterGame'))
    const reset = { egg_infos: { eggs: [egg(1)] } }
    assert.equal(data(packet(reset)).default_catch_card_id, undefined, 'an absent source field has a zero getter')
    client.read(optimize(session, reset))
    assert.equal(client.state.card, 0)
    assert.equal(client.state.free, 0)
    const restored = optimize(session, initial)
    assert.equal(restored.length, 1)
    client.read(restored)
    assert.equal(client.state.card, 1000003)
    assert.equal(client.state.free, 17)
    assert.deepEqual(optimize(session, initial), [])
    const rawWithoutScalars = { egg_infos: { eggs: [egg(2)] } }
    client.read(optimize(session, rawWithoutScalars))
    assert.equal(client.state.card, 0, 'missing source fields mean getter zero, not retain a previous scalar')
    assert.equal(client.state.free, 0)
})

test('foreign egg packets remain untouched and cannot change this player sent-cache scalars', () => {
    const session = { id: 1 }
    const own = { default_catch_card_id: 1000003, free_reward_num: 17, egg_infos: { eggs: [egg(1)] } }
    optimize(session, own, 'CSProtoEnterGame')
    const foreign = packet(
        { default_catch_card_id: 1000004, free_reward_num: 21, egg_infos: { eggs: [egg(5)] } },
        { recipient: 2 },
    )
    const bytes = Buffer.from(foreign.payload)
    const result = optimizeSyncPackets(protocol, session, [foreign], 'normal')
    assert.equal(result[0], foreign)
    assert.deepEqual(result[0].payload, bytes)
    assert.deepEqual(optimize(session, own), [])
})
