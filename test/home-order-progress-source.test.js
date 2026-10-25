import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { ErrorCode } from '../src/error-codes.js'
import { grantRewards, parseRewards } from '../src/rewards.js'
import { homeOrderProgressRule, homeOrderProgressValue } from '../src/home-order-progress.js'
import { homeOrderFixture } from './home-order-progress-fixture.js'
const value = (f, level = 0) => homeOrderProgressValue(f.tables, f.state(), [15003, 0, level, 100000])

test('1000 real6227 submissions across actual table windows retain typed counts beyond bounded receipts and never replay an evicted identity', () => {
    const f = homeOrderFixture('order-source-thousand')
    try {
        const accepted = f.complete(1000),
            state = f.state(),
            counts = Object.fromEntries(
                [1, 2, 3].map((level) => [level, accepted.filter((row) => row.level === level).length]),
            )
        assert.equal(accepted.length, 1000)
        assert.equal(new Set(accepted.map((row) => row.guid)).size, 1000)
        assert.equal(state.homeExchange.completedOrders, 1000)
        assert.equal(state.homeExchange.orderProgress.legacyTotal, 0)
        assert.equal(state.homeExchange.orderProgress.revision, 1000)
        assert.deepEqual(state.homeExchange.orderProgress.counts, counts)
        assert.equal(Object.keys(state.homeExchange.orderReceipts).length, 256)
        assert.equal(state.homeExchange.orderReceipts[accepted[0].guid], undefined)
        for (const [guid, receipt] of Object.entries(state.homeExchange.orderReceipts)) {
            assert.equal(receipt.level, accepted.find((row) => row.guid === Number(guid)).level)
        }
        assert(counts[2] >= 10 && counts[3] > 0)
        const before = f.state()
        assert.throws(
            () => f.call('CSFinishOrder', { order_guid: accepted[0].guid }),
            (e) => e.code === ErrorCode.HomeOrderNotExists,
        )
        assert.deepEqual(f.state(), before)
        const retained = accepted.at(-1)
        assert.deepEqual(
            f.protocol.decode(
                f.protocol.byId.get(6227).rsp,
                f.call('CSFinishOrder', { order_guid: retained.guid }).find((r) => r.id === 6227).payload,
            ).rewards,
            [],
        )
        assert.equal(value(f), 1000)
        f.edit((s) => {
            delete s.homeExchange.nextOrderGuid
        })
        f.setNow(f.state().homeExchange.board.end)
        const next = f.board().slots.filter((row) => row.guid)
        assert(next.every((row) => row.guid > accepted.at(-1).guid))
    } finally {
        f.close()
    }
})

test('legacy total remains ALL-only and unsealed receipts never derive tiers from mutable current templates', () => {
    const f = homeOrderFixture('order-source-legacy')
    try {
        f.board()
        f.edit((s) => {
            s.homeExchange.completedOrders = 1000
            s.homeExchange.orderReceipts = {
                10000: {
                    id: f.tables.get('home_exchange_order').find((r) => r.orderLevel === 2).orderID,
                    time: f.now() - 1,
                },
            }
            s.homeExchange.nextOrderGuid = 10001
        })
        assert.equal(value(f), 1000)
        assert.equal(value(f, 2), 0)
        const selected = f.state().homeExchange.board.slots.find((row) => row.level === 2)
        f.submit(selected)
        assert.equal(f.state().homeExchange.orderProgress.legacyTotal, 1000)
        assert.equal(value(f), 1001)
        assert.equal(value(f, 2), 1)
        assert.equal(f.state().homeExchange.orderReceipts[10000].level, undefined)
        const fake = Object.create(f.tables)
        fake.get = (name) =>
            name === 'home_exchange_order'
                ? f.tables.get(name).map((r) => ({ ...r, orderLevel: r.orderLevel === 2 ? 3 : r.orderLevel }))
                : f.tables.get(name)
        assert.equal(
            homeOrderProgressValue(
                fake,
                { homeExchange: { completedOrders: 1000, orderReceipts: f.state().homeExchange.orderReceipts } },
                [15003, 0, 3, 10000],
            ),
            0,
        )
        for (const tokens of [[15003], [15003, 1, 0, 1], [15003, 0, 99, 1], [15003, 0, 0, 0], [15003, 0, 2, 1, 2]])
            assert.equal(homeOrderProgressRule(f.tables, tokens), false)
    } finally {
        f.close()
    }
})

test('refresh, missing materials and expired GUID do not count; accepted tier mismatch and malformed history roll back', () => {
    const f = homeOrderFixture('order-source-reject')
    try {
        const board = f.board(),
            slot = board.slots[0],
            before = f.state()
        assert.throws(
            () => f.call('CSFinishOrder', { order_guid: slot.guid }),
            (e) => e.code === ErrorCode.ItemNotEnough,
        )
        assert.deepEqual(f.state(), before)
        f.call('CSRefrshOneOrder', { order_guid: slot.guid })
        assert.equal(value(f), 0)
        assert.equal(f.state().homeExchange.orderProgress, undefined)
        f.setNow(board.end)
        const expired = f.state()
        assert.throws(
            () => f.call('CSFinishOrder', { order_guid: slot.guid }),
            (e) => e.code === ErrorCode.HomeOrderNotExists,
        )
        assert.deepEqual(f.state(), expired)
        f.board()
        const current = f.state().homeExchange.board.slots[0]
        f.edit((s) => {
            s.homeExchange.board.slots[0].level = 2
        })
        const costRow = f.tables.get('home_exchange_order').find((row) => row.orderID === current.order_id)
        f.edit((s) => grantRewards(f.tables, s, parseRewards(costRow.orderNeedMaterials)))
        const badTier = f.state()
        assert.throws(
            () => f.call('CSFinishOrder', { order_guid: current.guid }),
            (e) => e.code === ErrorCode.HomeOrderConfInvalid,
        )
        assert.deepEqual(f.state(), badTier)
        f.edit((s) => {
            s.homeExchange.board.slots[0].level = current.level
            s.homeExchange.orderProgress = { version: 1, legacyTotal: 0, revision: 1, counts: { 2: 1 } }
        })
        assert.throws(
            () => value(f),
            (e) => e.code === ErrorCode.GameConfig,
        )
    } finally {
        f.close()
    }
})

test('ledger schema, exact tier keys and arithmetic overflow reject damaged state without partially paying a real order', () => {
    const f = homeOrderFixture('order-source-integrity')
    try {
        for (const total of [null, -1, '1', Number.MAX_SAFE_INTEGER + 1, Number.NaN])
            assert.throws(
                () => homeOrderProgressValue(f.tables, { homeExchange: { completedOrders: total } }, [15003, 0, 0, 1]),
                (e) => e.code === ErrorCode.GameConfig,
            )
        for (const ledger of [
            null,
            [],
            { version: 2, legacyTotal: 0, revision: 0, counts: {} },
            { version: 1, legacyTotal: 0, revision: 0, counts: [] },
            { version: 1, legacyTotal: 0, revision: 1, counts: { '02': 1 } },
            { version: 1, legacyTotal: 0, revision: 1, counts: { 99: 1 } },
            { version: 1, legacyTotal: 0, revision: 1, counts: { 2: -1 } },
            { version: 1, legacyTotal: 0, revision: 0, counts: { 2: 1 } },
            { version: 1, legacyTotal: 0, revision: 1, counts: { 2: 1 } },
        ])
            assert.throws(
                () =>
                    homeOrderProgressValue(
                        f.tables,
                        { homeExchange: { completedOrders: 0, orderProgress: ledger } },
                        [15003, 0, 0, 1],
                    ),
                (e) => e.code === ErrorCode.GameConfig,
            )
        const slot = f.board().slots[0],
            row = f.tables.get('home_exchange_order').find((r) => r.orderID === slot.order_id)
        f.edit((s) => {
            grantRewards(f.tables, s, parseRewards(row.orderNeedMaterials))
            s.homeExchange.completedOrders = Number.MAX_SAFE_INTEGER
        })
        const before = f.state()
        assert.throws(
            () => f.call('CSFinishOrder', { order_guid: slot.guid }),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
        assert.equal(f.state().homeExchange.orderProgress, undefined)
        f.edit((s) => {
            s.homeExchange.completedOrders = Number.NaN
        })
        const storedNull = f.state()
        assert.equal(
            storedNull.homeExchange.completedOrders,
            null,
            'exercise actual Store JSON conversion, not only a direct reader',
        )
        assert.throws(
            () => f.call('CSFinishOrder', { order_guid: slot.guid }),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), storedNull)
    } finally {
        f.close()
    }
})

test('natural board rollover preserves unsubmitted live GUID high water without a legacy counter and rejects malformed identity evidence atomically', () => {
    const f = homeOrderFixture('order-source-live-high-water')
    try {
        const first = f.board(),
            old = first.slots.map((r) => r.guid)
        // One real submission leaves later unsubmitted IDs higher than receipts.
        f.submit(first.slots[0])
        assert(Math.max(...old) > Math.max(...Object.keys(f.state().homeExchange.orderReceipts).map(Number)))
        f.edit((s) => {
            delete s.homeExchange.nextOrderGuid
        })
        f.setNow(first.end)
        const second = f.board(),
            current = second.slots.map((r) => r.guid)
        assert(current.every((id) => id > Math.max(...old)))
        const before = f.state()
        for (const id of old.slice(1))
            assert.throws(
                () => f.call('CSFinishOrder', { order_guid: id }),
                (e) => e.code === ErrorCode.HomeOrderNotExists,
            )
        assert.deepEqual(f.state(), before)
        assert.equal(value(f), 1)
        const valid = f.state()
        for (const change of [
            (s) => {
                s.homeExchange.board.slots[0].guid = Number.NaN
            },
            (s) => {
                s.homeExchange.board.slots[0].guid = 0x100000000
            },
            (s) => {
                s.homeExchange.board.slots[0].guid = s.homeExchange.board.slots[1].guid
            },
            (s) => {
                s.homeExchange.orderReceipts['01'] = { id: 1, time: f.now() }
            },
            (s) => {
                s.homeExchange.orderReceipts['4294967296'] = { id: 1, time: f.now() }
            },
            (s) => {
                s.homeExchange.nextOrderGuid = Number.MAX_SAFE_INTEGER
            },
        ]) {
            f.edit((s) => {
                s.homeExchange = structuredClone(valid.homeExchange)
                change(s)
            })
            f.setNow(second.end)
            const corrupt = f.state()
            assert.throws(
                () => f.board(),
                (e) => e.code === ErrorCode.GameConfig,
            )
            assert.deepEqual(f.state(), corrupt)
        }
        f.edit((s) => {
            s.homeExchange = structuredClone(valid.homeExchange)
            s.homeExchange.nextOrderGuid = 0xffffffff
        })
        f.setNow(second.end)
        const exhausted = f.state()
        assert.throws(
            () => f.board(),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), exhausted)
    } finally {
        f.close()
    }
})

test('6227 and reward synchronization encoding failures roll back the entire successful submission and retry credits once', () => {
    for (const packetId of [6227, 5008, 11250]) {
        const f = homeOrderFixture('order-source-atomic-' + packetId)
        try {
            const slot = f.board().slots.find((row) => row.level === 2)
            // First actual response tells us whether this synchronization ID is present; never inject an unvisited branch.
            const row = f.tables.get('home_exchange_order').find((row) => row.orderID === slot.order_id)
            f.edit((s) => grantRewards(f.tables, s, parseRewards(row.orderNeedMaterials)))
            const before = f.state(),
                encode = f.protocol.encode
            let injected = false
            f.protocol.encode = function (name, data) {
                if (name === f.protocol.byId.get(packetId).rsp) {
                    injected = true
                    throw Error('order-source-encoding')
                }
                return encode.call(this, name, data)
            }
            assert.throws(() => f.call('CSFinishOrder', { order_guid: slot.guid }), /order-source-encoding/)
            assert(injected)
            assert.deepEqual(f.state(), before)
            f.protocol.encode = encode
            f.call('CSFinishOrder', { order_guid: slot.guid })
            assert.equal(value(f), 1)
            assert.equal(value(f, 2), 1)
        } finally {
            f.close()
        }
    }
})

test('real submitted facts survive SQLite reopen while another account stays empty', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-order-progress-')),
        filename = path.join(dir, 'orders.sqlite')
    let f
    try {
        f = homeOrderFixture('order-source-persist', filename)
        f.complete(12)
        const saved = f.state().homeExchange.orderProgress,
            now = f.now()
        f.close()
        f = undefined
        f = homeOrderFixture('order-source-persist', filename, { resume: true, now })
        assert.deepEqual(f.state().homeExchange.orderProgress, saved)
        assert.equal(value(f), 12)
        const other = homeOrderFixture('order-source-other', filename, { now })
        try {
            assert.equal(value(other), 0)
        } finally {
            other.close()
        }
    } finally {
        f?.close()
        const resolved = path.resolve(dir)
        assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()))
        assert(path.basename(resolved).startsWith('home-order-progress-'))
        fs.rmSync(resolved, { recursive: true, force: true })
    }
})
