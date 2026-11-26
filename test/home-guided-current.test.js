import test from 'node:test'
import assert from 'node:assert/strict'
import { homeOrderFixture } from './home-order-progress-fixture.js'
import { TaskGraphs, makeNode } from '../src/tasks.js'
import { guidedConditionValue } from '../src/guided-conditions.js'
import { grantRewards, parseRewards } from '../src/rewards.js'
import { exchangeClock } from '../src/home-exchange.js'
import { homeGuidedConditionValue, recordHomeGuidedSale } from '../src/home-guided-progress.js'
import { ErrorCode } from '../src/error-codes.js'

const request = { task_id: 402001, node_id: 4 }
function fixture(name) {
    const f = homeOrderFixture('home-guided-current-' + name),
        graph = new TaskGraphs(f.tables).get(402001)
    f.edit((state) => {
        state.home.level = 6
        state.tasks = [
            {
                task_id: 402001,
                nodes: [makeNode(graph, 4, state)],
                finish_nodes: [1, 2, 3],
                reward_nodes: [],
                client_trace: true,
            },
        ]
        grantRewards(f.tables, state, [{ itemtype: 3, itemid: 400101, itemnum: 100 }])
    })
    const login = () => {
        const entry = f.protocol.byName.get('CSProtoEnterGame')
        return f.game.dispatch(
            {},
            {
                id: entry.id,
                seq: 1,
                payload: f.protocol.encode(entry.req, { open_id: 'home-guided-current-' + name, reconnect: true }),
            },
        )
    }
    const values = () => [4020013, 4020014].map((id) => guidedConditionValue(id, f.state()))
    const snapshot = () => f.store.load(f.session.id)
    return { ...f, graph, login, values, snapshot }
}
const targetOrder = (f) => {
    const slot = f.board().slots.find((row) => row.order_id === 1000001)
    assert(slot, 'Current45-level board and real first-candidate RNG offer configured order1000001')
    return slot
}

test('actual402001 node4 requires real successful sale AND exact order1000001 before current task callbacks can advance it', () => {
    const f = fixture('and')
    try {
        assert.equal(f.graph.nodes.get(4).nodeType, 30)
        assert.deepEqual(f.values(), [0, 0])
        f.call('TaskClientBefore', request)
        assert.throws(() => f.call('TaskClientCondAfter', { ...request, indexes: [0, 1] }), /not complete/)
        const slot = targetOrder(f)
        const other = f.state().homeExchange.board.slots.find((row) => row.guid && row.order_id !== 1000001)
        assert(other)
        f.submit(other)
        assert.deepEqual(f.values(), [0, 0], 'A different successful order cannot satisfy the exact configured ID')
        f.submit(slot)
        assert.deepEqual(f.values(), [0, 1])
        assert.equal(f.state().homeExchange.taskProgress.sales, 0)
        assert.equal(f.state().homeExchange.taskProgress.orders[1000001], 1)
        f.call('CSFinishOrder', { order_guid: slot.guid })
        assert.equal(f.state().homeExchange.taskProgress.orders[1000001], 1)
        assert.throws(() => f.call('TaskClientAfter', request), /condition.*complete/)
        f.call('CSAddExchangeObj', { id: 10360011, num: 3, type: 3 })
        assert.deepEqual(f.values(), [0, 1], 'Booking and inventory debit are not completed sale')
        f.call('CSCancelExangeObj', { id: 10360011 })
        assert.deepEqual(f.values(), [0, 1])
        f.call('CSAddExchangeObj', { id: 10360011, num: 3, type: 3 })
        const packets = f.call('CSSettleImmediately')
        assert(packets.some((packet) => packet.id === 6224))
        assert.deepEqual(f.values(), [1, 1])
        assert.equal(f.state().homeExchange.taskProgress.sales, 1, 'Three products form one successful sale')
        f.call('CSSettleImmediately')
        assert.equal(f.state().homeExchange.taskProgress.sales, 1)
        const completion = f.call('TaskClientCondAfter', { ...request, indexes: [0, 1] }),
            syncId = f.protocol.byName.get('CSProtoTaskSync').id,
            ackId = f.protocol.byName.get('CSProtoTaskClientCondAfter').id,
            syncIndex = completion.findIndex((packet) => packet.id === syncId)
        assert(syncIndex >= 0 && syncIndex < completion.findIndex((packet) => packet.id === ackId))
        const sync = f.protocol.decode(f.protocol.byId.get(syncId).rsp, completion[syncIndex].payload)
        assert.deepEqual(
            sync.tasks.find((task) => task.task_id === 402001).nodes.find((node) => node.node_id === 4)
                .client_cond_after,
            [true, true],
        )
        f.call('TaskClientAfter', request)
        const saved = f.state().tasks.find((task) => task.task_id === 402001)
        assert(saved.finish_nodes.includes(4))
        assert(saved.nodes.some((node) => node.node_id === 5))
        f.login()
        assert.deepEqual(f.values(), [1, 1])
        assert.equal(f.state().homeExchange.taskProgress.sales, 1)
    } finally {
        f.close()
    }
})

test('scheduled departure is not a sale; actual due settlement and reconnect each preserve exactly one successful event', () => {
    const f = fixture('scheduled')
    try {
        f.call('CSAddExchangeObj', { id: 10360011, num: 4, type: 3 })
        const clock = exchangeClock(f.tables, f.now())
        f.setNow(clock.shippingAt + 1)
        f.game.tick(f.session.id, f.session)
        assert.deepEqual(f.values(), [0, 0])
        assert.equal(f.state().homeExchange.shipments.length, 1)
        f.setNow(clock.settleAt)
        f.game.tick(f.session.id, f.session)
        assert.deepEqual(f.values(), [1, 0])
        assert.equal(f.state().homeExchange.taskProgress.sales, 1)
        f.game.tick(f.session.id, f.session)
        f.login()
        f.login()
        assert.equal(f.state().homeExchange.taskProgress.sales, 1)
    } finally {
        f.close()
    }
})

test('failed balance validation and actual sale/order ACK encoding roll back task ledger with escrow, costs and business receipts', () => {
    const f = fixture('rollback'),
        encode = f.protocol.encode.bind(f.protocol)
    try {
        const slot = targetOrder(f),
            beforeCost = f.snapshot()
        assert.throws(() => f.call('CSFinishOrder', { order_guid: slot.guid }))
        assert.deepEqual(f.snapshot(), beforeCost)
        const row = f.tables.get('home_exchange_order').find((row) => row.orderID === 1000001)
        f.edit((state) => grantRewards(f.tables, state, parseRewards(row.orderNeedMaterials)))
        const beforeOrder = f.snapshot(),
            orderRsp = f.protocol.byName.get('CSProtoCSFinishOrder').rsp
        f.protocol.encode = (name, value) => {
            if (name === orderRsp) throw Error('order codec')
            return encode(name, value)
        }
        assert.throws(() => f.call('CSFinishOrder', { order_guid: slot.guid }), /order codec/)
        assert.deepEqual(f.snapshot(), beforeOrder)
        f.protocol.encode = encode
        f.call('CSFinishOrder', { order_guid: slot.guid })
        f.call('CSAddExchangeObj', { id: 10360011, num: 5, type: 3 })
        const beforeSale = f.snapshot(),
            saleRsp = f.protocol.byName.get('CSProtoCSSettleImmediately').rsp
        f.protocol.encode = (name, value) => {
            if (name === saleRsp) throw Error('sale codec')
            return encode(name, value)
        }
        assert.throws(() => f.call('CSSettleImmediately'), /sale codec/)
        assert.deepEqual(f.snapshot(), beforeSale)
        f.protocol.encode = encode
        f.call('CSSettleImmediately')
        assert.deepEqual(f.values(), [1, 1])
    } finally {
        f.protocol.encode = encode
        f.close()
    }
})

test('only validated retained terminal receipts seed old saves; projection and next commit are idempotent without inventing missing history', () => {
    const f = fixture('migration')
    try {
        f.board()
        f.edit((state) => {
            const exchange = state.homeExchange
            exchange.completedOrders = 900
            exchange.history = [{ history_time: 1, profit: 99999, settle_num: 999, extra_num: 0 }]
            exchange.orderReceipts = {
                10: { id: 1000001, time: f.now(), level: 1 },
                11: { id: 1000001, time: f.now(), level: 2 },
                12: { id: 1000001, time: 0, level: 1 },
            }
            exchange.settlementReceipt = { kind: 'manual', time: f.now(), day: 20000, principal: 100, extra: 0 }
            delete exchange.taskProgress
        })
        assert.deepEqual(f.values(), [1, 1])
        const before = f.snapshot()
        assert.deepEqual(f.values(), [1, 1])
        assert.deepEqual(
            f.snapshot(),
            before,
            'Read-only compatibility projection does not write or duplicate receipts',
        )
        f.call('CSAddExchangeObj', { id: 10360011, num: 2, type: 3 })
        f.call('CSSettleImmediately')
        assert.deepEqual(f.state().homeExchange.taskProgress, { version: 1, sales: 2, orders: { 1000001: 1 } })
        f.edit((state) => {
            state.homeExchange.orderReceipts = {}
            delete state.homeExchange.settlementReceipt
        })
        f.login()
        f.login()
        assert.deepEqual(f.values(), [1, 1], 'Materialized counters survive normal terminal receipt retention/pruning')
        const fake = {
            homeExchange: {
                completedOrders: 999,
                history: [{ settle_num: 999 }],
                settlementReceipt: { kind: 'scheduled', time: 1, day: 1, principal: 0, extra: 0 },
            },
        }
        assert.equal(homeGuidedConditionValue([16091, 1], fake), 0)
        assert.equal(homeGuidedConditionValue([16089, 1000001, 1], fake), 0)
        assert.equal(homeGuidedConditionValue([16089, 999999, 1], fake), null)
        assert.throws(
            () => homeGuidedConditionValue([16089, 1000001, 1], { homeExchange: { orderReceipts: [] } }),
            (error) => error.code === ErrorCode.GameConfig,
        )
        assert.throws(
            () =>
                recordHomeGuidedSale({
                    homeExchange: { taskProgress: { version: 1, sales: Number.MAX_SAFE_INTEGER, orders: {} } },
                }),
            (error) => error.code === ErrorCode.GameConfig,
        )
    } finally {
        f.close()
    }
})
