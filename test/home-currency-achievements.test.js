import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { homeCurrencyFixture, homeCurrencyBalance } from './home-currency-fixture.js'
import { achievementCatalogue, observeAchievements } from '../src/achievements.js'
import { homeCurrencyProgressRule, homeCurrencyProgressValue } from '../src/home-currency-progress.js'
import { readHomeCurrencyAcquisition } from '../src/home-currency-acquisition.js'
import { exchangeOrderPlan } from '../src/home-exchange-orders.js'
import { ErrorCode } from '../src/error-codes.js'

const family = (tables) => achievementCatalogue(tables).rows.filter((row) => row.finishCondition.startsWith('12029#'))
test('complete current currency CollectItem family uses exact typed103 source and keeps other namespaces and shapes closed', () => {
    const f = homeCurrencyFixture('home-currency-condition-family')
    try {
        const model = achievementCatalogue(f.tables),
            rows = family(f.tables)
        assert.deepEqual(
            rows.map((row) => row.param),
            [800000, 15000000, 45000000],
        )
        assert(rows.every((row) => model.rules.get(row.id).supported))
        assert.equal(model.rows.filter((row) => model.rules.get(row.id).supported).length, 131)
        const state = f.state()
        state.player.attr_infos.attrs.push({ attr_id: 103, attr_val: '90000000' })
        state.itemAcquisitionCounts = { '10:103': 90000000 }
        state.battlePassResources = { unrelated: { '10:103': 90000000 } }
        assert.equal(homeCurrencyProgressValue(f.tables, state, [12029, 10, 103, 800000]), 0)
        for (const tokens of [
            [12029, 3, 103, 1],
            [12029, 10, 2, 1],
            [12029, 10, 103, 0],
            [12029, 10, 103, 1, 1],
            [12029, 10, 103, 0x100000000],
        ]) {
            assert.equal(homeCurrencyProgressRule(f.tables, tokens), false)
            assert.equal(homeCurrencyProgressValue(f.tables, state, tokens), null)
        }
        state.homeCurrencyAcquisition = { version: 1, resourceType: 10, resourceId: 103, total: '9007199254740993' }
        assert.equal(homeCurrencyProgressValue(f.tables, state, [12029, 10, 103, 45000000], new Map()), 45000000)
    } finally {
        f.store.close()
    }
})

test('legacy unfinished scalars never fabricate earnings; real equal-threshold facts finish while valid terminals remain monotone', () => {
    const f = homeCurrencyFixture('home-currency-receipt-boundary')
    try {
        const row = family(f.tables)[0],
            state = f.state()
        state.achievements.entries[row.id] = { value: row.param, finishTime: 0, claimed: false }
        observeAchievements(f.tables, state, f.clock())
        assert.deepEqual(state.achievements.entries[row.id], { value: 0, finishTime: 0, claimed: false })
        state.homeCurrencyAcquisition = { version: 1, resourceType: 10, resourceId: 103, total: String(row.param) }
        state.achievements.entries[row.id].value = row.param
        observeAchievements(f.tables, state, f.clock())
        assert.equal(state.achievements.entries[row.id].finishTime, f.clock())
        state.achievements.entries[row.id].claimed = true
        const terminal = structuredClone(state.achievements.entries[row.id])
        delete state.homeCurrencyAcquisition
        observeAchievements(f.tables, state, f.clock() + 1)
        assert.deepEqual(state.achievements.entries[row.id], terminal)
        for (const receipt of [
            { value: row.param, finishTime: 0, claimed: true },
            { value: 1, finishTime: 1, claimed: false },
        ]) {
            const broken = f.state()
            broken.achievements.entries[row.id] = receipt
            assert.throws(
                () => observeAchievements(f.tables, broken, f.clock()),
                (error) => error.code === ErrorCode.GameConfig,
            )
        }
        const unknown = f.state()
        unknown.homeCurrencyAcquisition = { version: 7, total: '90000000' }
        observeAchievements(f.tables, unknown, f.clock())
        assert.equal(unknown.achievements.entries[row.id]?.finishTime ?? 0, 0)
    } finally {
        f.store.close()
    }
})

test('real6227 earnings reach all three thresholds,9900 and9902 faults roll back, then SQLite preserves claims and account isolation', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-currency-achievements-'))
    const filename = path.join(dir, 'test.sqlite')
    let f = homeCurrencyFixture('home-currency-all-targets', { filename })
    let income = 0n,
        orders = 0,
        boards = 0
    const milestones = []
    try {
        const rows = family(f.tables)
        f.setOldBalance(90000000)
        assert.throws(
            () => f.call('AchievementReward', { u32: rows[0].id }),
            (error) => error.code === ErrorCode.AchievementIsRunning,
        )
        assert.equal(readHomeCurrencyAcquisition(f.state()), 0n)
        f.game.rng = (min, max) => (max === undefined ? min - 1 : max - 1)
        const maximum = BigInt(rows.at(-1).param)
        let sourceFault = false,
            claimFault = false
        while (income < maximum) {
            f.call('CSExchangeOrderBoard')
            boards++
            const slots = f.state().homeExchange.board.slots.filter((slot) => slot.guid && !slot.done)
            assert(slots.length > 0)
            for (const slot of slots) {
                const row = f.tables.get('home_exchange_order').find((entry) => entry.orderID === slot.order_id)
                const plan = exchangeOrderPlan(f.tables, f.state(), row, f.clock())
                const amount = plan.rewards
                    .filter((reward) => reward.itemtype === 10 && reward.itemid === 103)
                    .reduce((n, reward) => n + BigInt(reward.itemnum), 0n)
                f.fundItems(row.orderNeedMaterials)
                if (!sourceFault && income < BigInt(rows[0].param) && income + amount >= BigInt(rows[0].param)) {
                    const before = f.state(),
                        packet = f.game.packet
                    f.game.packet = function (name, ...args) {
                        if (name === 'CSProtoAchievementSync') throw Error('currency-goal-sync')
                        return packet.call(this, name, ...args)
                    }
                    try {
                        assert.throws(() => f.call('CSFinishOrder', { order_guid: slot.guid }), /currency-goal-sync/)
                    } finally {
                        f.game.packet = packet
                    }
                    assert.deepEqual(f.state(), before)
                    sourceFault = true
                }
                const beforeWallet = homeCurrencyBalance(f.state())
                f.call('CSFinishOrder', { order_guid: slot.guid })
                income += amount
                orders++
                assert.equal(homeCurrencyBalance(f.state()) - beforeWallet, amount)
                assert.equal(readHomeCurrencyAcquisition(f.state()), income)
                for (const target of rows) {
                    if (income < BigInt(target.param) || f.state().achievements.entries[target.id]?.claimed) continue
                    assert(f.state().achievements.entries[target.id].finishTime > 0)
                    if (!claimFault) {
                        f.store.transact(f.session().id, 0, () => {}, { defer: true })
                        const pending = f.store.pending.get(f.session().id),
                            counter = pending.state.homeCurrencyAcquisition
                        const before = f.state(),
                            packet = f.game.packet
                        f.game.packet = function (name, ...args) {
                            if (name === 'CSProtoAchievementSync') throw Error('currency-goal-claim-codec')
                            return packet.call(this, name, ...args)
                        }
                        try {
                            assert.throws(
                                () => f.call('AchievementReward', { u32: target.id }),
                                /currency-goal-claim-codec/,
                            )
                        } finally {
                            f.game.packet = packet
                        }
                        assert.deepEqual(f.state(), before)
                        const disk = f.store.db
                            .prepare('SELECT state FROM players WHERE account_id=?')
                            .get(f.session().id).state
                        f.store.db.exec(
                            "CREATE TEMP TRIGGER currency_goal_abort BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT, 'currency-goal-sql'); END",
                        )
                        try {
                            assert.throws(() => f.call('AchievementReward', { u32: target.id }), /currency-goal-sql/)
                        } finally {
                            f.store.db.exec('DROP TRIGGER currency_goal_abort')
                        }
                        assert.deepEqual(f.state(), before)
                        assert.equal(f.store.pending.get(f.session().id), pending)
                        assert.equal(pending.state.homeCurrencyAcquisition, counter)
                        assert.equal(
                            f.store.db.prepare('SELECT state FROM players WHERE account_id=?').get(f.session().id)
                                .state,
                            disk,
                        )
                        claimFault = true
                    }
                    f.call('AchievementReward', { u32: target.id })
                    assert.equal(f.state().achievements.entries[target.id].claimed, true)
                    const before = f.state()
                    f.call('AchievementReward', { u32: target.id })
                    assert.deepEqual(f.state().player, before.player)
                    assert.deepEqual(f.state().homeCurrencyAcquisition, before.homeCurrencyAcquisition)
                    milestones.push({ id: target.id, target: target.param, realOrders: orders, earned: String(income) })
                }
                assert(orders < 4000)
                if (income >= maximum) break
            }
            if (income < maximum) f.setNow(f.state().homeExchange.board.end + 1)
        }
        assert(sourceFault && claimFault)
        assert.equal(milestones.length, 3)
        console.log(
            '[home-currency-milestones]',
            JSON.stringify({
                realOrders: orders,
                realBoards: boards,
                earned: String(income),
                importedQualificationCounts: 0,
                milestones,
            }),
        )
        f.store.close()
        f = homeCurrencyFixture('home-currency-all-targets', { filename })
        assert.equal(readHomeCurrencyAcquisition(f.state()), income)
        for (const row of rows) {
            assert.equal(f.state().achievements.entries[row.id].claimed, true)
            f.call('AchievementReward', { u32: row.id })
        }
        assert.equal(readHomeCurrencyAcquisition(f.state()), income)
        const other = homeCurrencyFixture('home-currency-goals-other', { filename })
        try {
            assert.equal(readHomeCurrencyAcquisition(other.state()), 0n)
            assert(rows.every((row) => !other.state().achievements.entries[row.id]?.finishTime))
        } finally {
            other.store.close()
        }
    } finally {
        f.store.close()
        assert.equal(path.dirname(dir), os.tmpdir())
        assert(path.basename(dir).startsWith('home-currency-achievements-'))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
