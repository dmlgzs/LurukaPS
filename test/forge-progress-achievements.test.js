import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { forgeFixture } from './forge-progress-fixture.js'
import { achievementCatalogue } from '../src/achievements.js'
import { forgeProgressRule, forgeProgressValue } from '../src/forge-progress.js'
import { grantRewards } from '../src/rewards.js'
import { ErrorCode } from '../src/error-codes.js'

const ids = [2020023, 2020024, 2020025]
const value = (f) => forgeProgressValue(f.tables, f.state(), [15072, 0, 100])
function made(f, count) {
    const id = f.tables.get('accessory_product').find((r) => r.difficulty === 1).id
    let index = 0
    while (count > 0) {
        const n = Math.min(4, count)
        f.make(id, true, n, ['finish', 'cancel', 'aggregate'][index++ % 3])
        count -= n
    }
}

test('all three15072 achievement rules compile by full family, unsupported selector and damaged history stay distinct', () => {
    const f = forgeFixture('forge-ach-catalogue')
    try {
        const model = achievementCatalogue(f.tables)
        const rows = model.rows.filter((r) => r.finishCondition.startsWith('15072#'))
        assert.deepEqual(
            rows.map((r) => [r.id, r.param]),
            [
                [2020023, 1],
                [2020024, 10],
                [2020025, 100],
            ],
        )
        assert(rows.every((r) => model.rules.get(r.id).supported))
        assert.equal([...model.rules.values()].filter((r) => r.supported).length, 105)
        for (const tokens of [
            [15072, 2, 1],
            [15072, 0, 0],
            [15072, 0],
            [15072, 0, 1, 1],
        ])
            assert.equal(forgeProgressRule(f.tables, tokens), false)
        f.edit((s) => {
            s.home.productionProgress = { version: 1, counts: { '8:33:10001': 999 } }
            s.home.craftCounts = { 1: 999 }
            grantRewards(f.tables, s, [{ itemtype: 33, itemid: 10001, itemnum: 1 }])
        })
        f.reload()
        assert.equal(value(f), 0)
        assert(ids.every((id) => !f.state().achievements.entries[id]?.finishTime))
        f.edit((s) => {
            s.home.forgeProgress = { version: 1, revision: 0, counts: { 'accessory_product:01:1:1': 10 } }
        })
        assert.throws(
            () => value(f),
            (e) => e.code === ErrorCode.GameConfig,
        )
    } finally {
        f.store.close()
    }
})

test('actual10202 and6111/6112/6554 claims cross1,10,100 and9902 rewards are retry-idempotent', () => {
    const f = forgeFixture('forge-ach-full')
    try {
        const id = f.tables.get('accessory_product')[0].id
        f.make(id, false)
        assert.equal(value(f), 0)
        let previous = 0
        for (const [threshold, achievement] of [
            [1, ids[0]],
            [10, ids[1]],
            [100, ids[2]],
        ]) {
            made(f, threshold - previous)
            previous = threshold
            assert.equal(value(f), threshold)
            const receipt = f.state().achievements.entries[achievement]
            assert.equal(receipt.value, threshold)
            assert(receipt.finishTime > 0)
            f.call('AchievementReward', { u32: achievement })
            assert(f.state().achievements.entries[achievement].claimed)
            const player = structuredClone(f.state().player)
            f.call('AchievementReward', { u32: achievement })
            assert.deepEqual(f.state().player, player)
        }
        assert.equal(
            Object.values(f.state().home.forgeProgress.counts).reduce((a, b) => a + b, 0),
            101,
        )
        f.reload()
        assert(ids.every((id) => f.state().achievements.entries[id].claimed))
    } finally {
        f.store.close()
    }
})

test('real final claim and9902 response encoding roll back inventory, source facts and achievement receipt together', () => {
    const f = forgeFixture('forge-ach-codec'),
        encode = f.protocol.encode
    try {
        const accepted = f.start(f.tables.get('accessory_product')[0].id)
        f.due(accepted.jobs)
        for (const type of ['SCProductFinish', 'SCHomeSync', 'SCAchievementSync']) {
            const before = structuredClone(f.state())
            f.protocol.encode = function (name, ...args) {
                if (name.replace(/^cs\./, '') === type) throw Error('forge achievement codec failure')
                return encode.call(this, name, ...args)
            }
            assert.throws(() => f.finish(accepted.jobs), /forge achievement codec failure/)
            assert.deepEqual(f.state(), before)
            f.protocol.encode = encode
        }
        f.finish(accepted.jobs)
        assert.equal(value(f), 1)
        for (const type of ['Rewards', 'SCAchievementSync']) {
            const before = structuredClone(f.state())
            f.protocol.encode = function (name, ...args) {
                if (name.replace(/^cs\./, '') === type) throw Error('forge achievement reward codec failure')
                return encode.call(this, name, ...args)
            }
            assert.throws(() => f.call('AchievementReward', { u32: ids[0] }), /forge achievement reward codec failure/)
            assert.deepEqual(f.state(), before)
            f.protocol.encode = encode
        }
        f.call('AchievementReward', { u32: ids[0] })
        assert(f.state().achievements.entries[ids[0]].claimed)
    } finally {
        f.protocol.encode = encode
        f.store.close()
    }
})

test('SQLite reopening retains typed forge facts and claimed receipt, another account cannot borrow them', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ach-'))
    let f
    try {
        const file = path.join(dir, 'test.sqlite')
        f = forgeFixture('forge-ach-persist', file)
        f.make(f.tables.get('accessory_product')[0].id)
        f.call('AchievementReward', { u32: ids[0] })
        f.store.close()
        f = forgeFixture('forge-ach-persist', file)
        assert.equal(value(f), 1)
        assert(f.state().achievements.entries[ids[0]].claimed)
        const other = {}
        f.call('EnterGame', { open_id: 'forge-ach-other' }, other)
        assert.equal(forgeProgressValue(f.tables, f.store.load(other.id).state, [15072, 0, 1]), 0)
    } finally {
        f?.store.close()
        const target = path.resolve(dir)
        assert.equal(path.dirname(target), path.resolve(os.tmpdir()))
        assert(path.basename(target).startsWith('forge-ach-'))
        fs.rmSync(target, { recursive: true, force: true })
    }
})
