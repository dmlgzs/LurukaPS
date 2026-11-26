import test from 'node:test'
import assert from 'node:assert/strict'
import { Tables } from '../src/player.js'
import { configuration } from '../src/config.js'
import { journeyModel, journeyValue } from '../src/journey.js'
import { journeyHomeOrderRule, journeyHomeOrderValue } from '../src/journey-home-order.js'
import { ErrorCode } from '../src/error-codes.js'
import { homeOrderFixture } from './home-order-progress-fixture.js'
import { grantRewards, parseRewards } from '../src/rewards.js'

const tables = new Tables(configuration().tables)

test('current13099 cumulative targets compile without opening unproven selectors or changing the old tiered ledger', () => {
    const model = journeyModel(tables)
    for (const id of [1320207, 2030501]) {
        const row = model.byTarget.get(id)
        assert.equal(row.tokens[0], 13099)
        assert(row.supported)
    }
    assert(journeyHomeOrderRule(tables, [13099, 0, 2]))
    for (const tokens of [
        [13099, 1, 2],
        [13099, 0, 0],
        [13099, 0, 2, 1],
        [15003, 0, 2],
    ]) {
        assert.equal(journeyHomeOrderRule(tables, tokens), false)
        assert.equal(journeyHomeOrderValue(tables, {}, tokens), null)
    }
    const state = { homeExchange: { completedOrders: 3 } },
        saved = structuredClone(state)
    assert.equal(journeyHomeOrderValue(tables, state, [13099, 0, 2]), 2)
    assert.deepEqual(state, saved)
    assert.throws(
        () => journeyHomeOrderValue(tables, { homeExchange: { completedOrders: -1 } }, [13099, 0, 2]),
        (error) => error.code === ErrorCode.GameConfig,
    )
})

test('real CSFinishOrder credits both migrated cumulative goals once, preserves tier sources, and rolls back on sync failure', () => {
    const f = homeOrderFixture('journey-home-order-current')
    try {
        const first = f.board().slots.find((slot) => slot.guid && !slot.done)
        assert(first)
        const packets = f.submit(first),
            sync = f.protocol.byName.get('SCProtoJourneySync')
        assert(sync)
        assert(packets.some((packet) => packet.id === sync.id))
        assert.equal(f.state().homeExchange.completedOrders, 1)
        for (const id of [1320207, 2030501]) assert.equal(f.state().journey.targets[id].value, 1)
        const afterFirst = f.state()
        f.call('CSFinishOrder', { order_guid: first.guid })
        assert.deepEqual(f.state().player, afterFirst.player)
        assert.equal(f.state().homeExchange.completedOrders, 1)
        const second = f.board().slots.find((slot) => slot.guid && !slot.done),
            definition = f.tables.get('home_exchange_order').find((row) => row.orderID === second.order_id)
        f.edit((state) => grantRewards(f.tables, state, parseRewards(definition.orderNeedMaterials)))
        const beforeFailure = f.state(),
            encode = f.protocol.encode
        f.protocol.encode = function (name, data) {
            if (name === sync.rsp) throw Error('current-order-journey-sync')
            return encode.call(this, name, data)
        }
        try {
            assert.throws(() => f.call('CSFinishOrder', { order_guid: second.guid }), /current-order-journey-sync/)
        } finally {
            f.protocol.encode = encode
        }
        assert.deepEqual(f.state(), beforeFailure)
        f.call('CSFinishOrder', { order_guid: second.guid })
        assert.equal(f.state().journey.targets[1320207].complete, true)
        assert.equal(f.state().journey.targets[2030501].value, 2)
        f.complete(1)
        assert.equal(f.state().homeExchange.completedOrders, 3)
        assert.equal(f.state().journey.targets[2030501].complete, true)
        const current = f.state(),
            model = journeyModel(f.tables)
        for (const id of [1320207, 2030501])
            assert.equal(journeyValue(f.tables, current, model.byTarget.get(id)), model.byTarget.get(id).targetParam)
        assert.equal(
            Object.values(current.homeExchange.orderProgress.counts).reduce((sum, value) => sum + value, 0),
            3,
        )
        const login = f.protocol.byName.get('CSProtoEnterGame')
        f.game.dispatch(
            {},
            { id: login.id, seq: 1, payload: f.protocol.encode(login.req, { open_id: 'journey-home-order-current' }) },
        )
        assert.equal(f.state().homeExchange.completedOrders, 3)
        for (const id of [1320207, 2030501])
            assert.deepEqual(f.state().journey.targets[id], current.journey.targets[id])
        assert.deepEqual(f.state().player.sbag_infos, current.player.sbag_infos)
    } finally {
        f.close()
    }
})
