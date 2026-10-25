import test from 'node:test'
import assert from 'node:assert/strict'
import { achievementCatalogue, achievementPoints } from '../src/achievements.js'
import { ErrorCode } from '../src/error-codes.js'
import { grantRewards, parseRewards } from '../src/rewards.js'
import { homeOrderFixture } from './home-order-progress-fixture.js'
const rows = (f) => achievementCatalogue(f.tables).rows.filter((r) => r.finishCondition.startsWith('15003#'))

test('complete15003 five-achievement family compiles without accepting unknown leading selectors', () => {
    const f = homeOrderFixture('order-achievement-catalogue')
    try {
        const model = achievementCatalogue(f.tables),
            goals = rows(f)
        assert.equal(goals.length, 5)
        assert(goals.every((r) => model.rules.get(r.id).supported))
        assert.equal(model.rows.length, 355)
        assert.equal([...model.rules.values()].filter((r) => r.supported).length, 96)
        assert(goals.every((r) => !f.state().achievements.entries[r.id]?.finishTime))
    } finally {
        f.close()
    }
})

test('five15003 achievement thresholds and rewards derive from1000 actual submitted orders, with retries paying only once', () => {
    const f = homeOrderFixture('order-achievement-thousand')
    try {
        const accepted = f.complete(1000)
        assert.equal(accepted.length, 1000)
        assert(accepted.filter((r) => r.level === 2).length >= 10)
        for (const goal of rows(f)) {
            assert.equal(f.state().achievements.entries[goal.id].value, goal.param)
            assert(f.state().achievements.entries[goal.id].finishTime > 0)
            f.call('AchievementReward', { u32: goal.id })
            assert.equal(f.state().achievements.entries[goal.id].claimed, true)
            const before = f.state(),
                points = achievementPoints(f.tables, before)
            const reply = f.call('AchievementReward', { u32: goal.id }).find((r) => r.id === 9902)
            assert.deepEqual(f.protocol.decode('Rewards', reply.payload).rewards, [])
            assert.deepEqual(f.state().player, before.player)
            assert.equal(achievementPoints(f.tables, f.state()), points)
        }
    } finally {
        f.close()
    }
})

test('final real order9900 failure and actual9902 reward failure are atomic; completed legacy terminal receipts remain monotonic', () => {
    const f = homeOrderFixture('order-achievement-atomic')
    try {
        f.complete(9)
        const slot = f.state().homeExchange.board.slots.find((r) => r.guid && !r.done),
            row = f.tables.get('home_exchange_order').find((r) => r.orderID === slot.order_id)
        f.edit((s) => grantRewards(f.tables, s, parseRewards(row.orderNeedMaterials)))
        const before = f.state(),
            encode = f.protocol.encode
        let injected = false
        f.protocol.encode = function (name, data) {
            if (name === f.protocol.byId.get(9900).rsp) {
                injected = true
                throw Error('order-achievement-sync')
            }
            return encode.call(this, name, data)
        }
        assert.throws(() => f.call('CSFinishOrder', { order_guid: slot.guid }), /order-achievement-sync/)
        assert(injected)
        assert.deepEqual(f.state(), before)
        f.protocol.encode = encode
        f.call('CSFinishOrder', { order_guid: slot.guid })
        const goal = rows(f).find((r) => r.finishCondition === '15003#0#0#10'),
            ready = f.state()
        f.protocol.encode = function (name, data) {
            if (name === f.protocol.byId.get(9902).rsp) throw Error('order-achievement-reward')
            return encode.call(this, name, data)
        }
        assert.throws(() => f.call('AchievementReward', { u32: goal.id }), /order-achievement-reward/)
        assert.deepEqual(f.state(), ready)
        f.protocol.encode = encode
        f.call('AchievementReward', { u32: goal.id })
        const receipt = f.state().achievements.entries[goal.id]
        f.edit((s) => {
            delete s.homeExchange.orderProgress
            delete s.homeExchange.completedOrders
        })
        f.call('CSExchangeOrderBoard')
        assert.deepEqual(
            f.state().achievements.entries[goal.id],
            receipt,
            'legacy terminal receipt is retained without manufacturing tier history',
        )
        assert.throws(
            () => f.call('AchievementReward', { u32: rows(f).find((r) => r.param === 1000).id }),
            (e) => e.code === ErrorCode.AchievementIsRunning,
        )
    } finally {
        f.close()
    }
})
