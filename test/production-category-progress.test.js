import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { productionProgressFixture } from './production-progress-fixture.js'
import { achievementCatalogue, achievementPoints } from '../src/achievements.js'
import { productionCategoryRule, productionCategoryValue } from '../src/production-progress.js'
import { grantRewards } from '../src/rewards.js'
import { rewardSource } from '../src/reward-source.js'
import { ErrorCode } from '../src/error-codes.js'

const target = [15021, 2, 410, 500]
const value = (f) => productionCategoryValue(f.tables, f.state(), target)
const entries = [2020012, 2020013, 2020014]

test('complete15021 family classifies all nine card IDs, preserves earlier sources and rejects unsupported selectors', () => {
    const f = productionProgressFixture('production-category-catalogue')
    try {
        const model = achievementCatalogue(f.tables)
        const rows = model.rows.filter((r) => r.finishCondition.startsWith('15021#'))
        assert.deepEqual(
            rows.map((r) => [r.id, r.param]),
            [
                [2020012, 500],
                [2020013, 1000],
                [2020014, 5000],
            ],
        )
        assert(rows.every((r) => model.rules.get(r.id).supported))
        assert.equal([...model.rules.values()].filter((r) => r.supported).length, 83)
        for (const tokens of [
            [15021, 6, 410, 500],
            [15021, 15, 410, 500],
            [15021, 0, 410, 500],
            [15021, 2, 0, 500],
            [15021, 2, 999999, 500],
            [15021, 2, 410, 0],
            [15021, 2, 410],
            [15021, 2, 410, 500, 1],
        ]) {
            assert.equal(productionCategoryRule(f.tables, tokens), false)
            assert.equal(productionCategoryValue(f.tables, f.state(), tokens), null)
        }
        // Historical snapshots may contain the ninth currently valid card even
        // though no current recipe produces it. This is a classifier boundary,
        // not evidence that this fixture has actually crafted that card.
        f.edit((s) => {
            s.home.productionProgress = {
                version: 1,
                counts: Object.fromEntries(Array.from({ length: 9 }, (_, i) => ['2:3:' + (1000001 + i), i + 1])),
            }
            s.home.productionProgress.counts['10:3:1000001'] = 100
            s.home.productionProgress.counts['2:10:1000001'] = 100
            s.home.productionProgress.counts['2:3:312001'] = 100
        })
        assert.equal(value(f), 45)
        const facts = new Map()
        for (const count of [500, 1000, 5000])
            assert.equal(productionCategoryValue(f.tables, f.state(), [15021, 2, 410, count], facts), 45)
        assert.equal([...facts.keys()].filter((key) => key.startsWith('production-category:')).length, 1)
        const badTables = Object.create(f.tables)
        badTables.get = (name) =>
            name === 'common_item' ? [...f.tables.get(name), { ...f.tables.get(name)[0] }] : f.tables.get(name)
        assert.throws(
            () => productionCategoryRule(badTables, target),
            (e) => e.code === ErrorCode.GameConfig,
        )
    } finally {
        f.store.close()
    }
})

test('real6111/6112/6554 home claims make5000 cards across every threshold and empty rewards remain idempotent', () => {
    const f = productionProgressFixture('production-category-full')
    try {
        let total = 0
        const methods = { finish: 0, cancel: 0, aggregate: 0 }
        for (const [threshold, achievement] of [
            [500, 2020012],
            [1000, 2020013],
            [5000, 2020014],
        ]) {
            while (total < threshold) {
                const count = Math.min(50, threshold - total)
                const accepted = f.start(total % 100 === 0 ? 501004 : 501005, count)
                f.advance(accepted.job.seconds * count)
                const mode = (total / 50) % 3
                if (mode === 0) {
                    f.finish(accepted)
                    methods.finish++
                } else if (mode === 1) {
                    f.finish(accepted, true)
                    methods.cancel++
                } else {
                    f.call('GetAllBuildReward', { build_guid: [accepted.guid] })
                    methods.aggregate++
                }
                total += count
                assert.equal(value(f), total)
            }
            assert.equal(f.state().achievements.entries[achievement]?.value, threshold)
            assert(f.state().achievements.entries[achievement]?.finishTime > 0)
            const first = f.call('AchievementReward', { u32: achievement })
            assert.deepEqual(f.protocol.decode('Rewards', first.find((p) => p.id === 9902).payload), {
                rewards: [],
                src: rewardSource(f.tables, 'achievementReward'),
            })
            const points = achievementPoints(f.tables, f.state())
            f.call('AchievementReward', { u32: achievement })
            assert.equal(achievementPoints(f.tables, f.state()), points)
        }
        assert(Object.values(methods).every((n) => n > 0))
        assert.equal(
            Object.values(f.state().home.productionProgress.counts).reduce((a, b) => a + b, 0),
            5000,
        )
        assert.equal(f.state().home.craftCounts[501004] + f.state().home.craftCounts[501005], 5000)
        assert(Object.values(f.state().home.productionJobs).every((jobs) => jobs.length === 0))
    } finally {
        f.store.close()
    }
})

test('precompletion, partial claims, cancellation refunds and aggregate retries count only newly granted home output', () => {
    const f = productionProgressFixture('production-category-partial')
    try {
        let accepted = f.start(501004, 4)
        f.finish(accepted, true)
        assert.equal(value(f), 0)
        accepted = f.start(501004, 4)
        f.advance(accepted.job.seconds)
        f.game.tick(f.session.id)
        assert.equal(value(f), 0)
        f.finish(accepted)
        assert.equal(value(f), 1)
        assert.throws(() => f.finish(accepted))
        assert.equal(value(f), 1)
        f.advance(accepted.job.seconds)
        f.finish(accepted, true)
        assert.equal(value(f), 2)
        assert.throws(() => f.finish(accepted, true))
        f.call('GetAllBuildReward', { build_guid: [accepted.guid] })
        assert.equal(value(f), 2)
        accepted = f.start(501005, 3)
        f.advance(accepted.job.seconds)
        f.call('GetAllBuildReward', { build_guid: [accepted.guid] })
        f.call('GetAllBuildReward', { build_guid: [accepted.guid] })
        assert.equal(value(f), 3)
        f.advance(accepted.job.seconds * 2)
        f.finish(accepted)
        assert.equal(value(f), 5)
    } finally {
        f.store.close()
    }
})

test('GM inventory, portable crafting and untyped old counters cannot fabricate home-production history', () => {
    const f = productionProgressFixture('production-category-exclusions')
    try {
        f.edit((s) => {
            s.home.craftCounts = { 501004: 999999 }
            s.cookCounts = { 501004: 999999 }
            s.simpleProduced = { '3:1000001': 999999 }
            grantRewards(f.tables, s, [
                { itemtype: 3, itemid: 1000001, itemnum: 9999 },
                { itemtype: 3, itemid: 312001, itemnum: 2 },
            ])
        })
        f.call('SimpleProductStart', { product_id: 501001, count: 1, select_material: [] })
        f.advance(1)
        const packets = f.game.tick(f.session.id)
        assert(packets.some((p) => p.id === 11014))
        assert.equal(f.state().simpleProduced['3:1000001'], 1000000)
        f.reload()
        assert.equal(value(f), 0)
        assert(entries.every((id) => !f.state().achievements.entries[id]?.finishTime))
    } finally {
        f.store.close()
    }
})

test('actual claim and achievement response failures roll back output, history and completion in the same transaction', () => {
    const f = productionProgressFixture('production-category-rollback')
    const encode = f.protocol.encode
    try {
        // Real production obtains the prior499; only required input materials
        // are seeded by the shared fixture.
        for (let left = 499; left > 0; left -= 50) f.produce(501004, Math.min(50, left))
        const accepted = f.start(501004)
        f.advance(accepted.job.seconds)
        for (const type of ['SCProductFinish', 'SCHomeSync', 'SCAchievementSync']) {
            const shared = f.state(),
                before = structuredClone(shared)
            f.protocol.encode = function (name, ...args) {
                if (name.replace(/^cs\./, '') === type) throw Error('category response codec failure')
                return encode.call(this, name, ...args)
            }
            assert.throws(() => f.finish(accepted), /category response codec failure/)
            assert.deepEqual(f.state(), before)
            assert.deepEqual(shared, before)
            f.protocol.encode = encode
        }
        f.finish(accepted)
        assert.equal(value(f), 500)
        assert(f.state().achievements.entries[2020012].finishTime > 0)
        const before = structuredClone(f.state())
        f.protocol.encode = function (name, ...args) {
            if (name.replace(/^cs\./, '') === 'Rewards') throw Error('category reward codec failure')
            return encode.call(this, name, ...args)
        }
        assert.throws(() => f.call('AchievementReward', { u32: 2020012 }), /category reward codec failure/)
        assert.deepEqual(f.state(), before)
        f.protocol.encode = encode
        f.call('AchievementReward', { u32: 2020012 })
        assert(f.state().achievements.entries[2020012].claimed)
    } finally {
        f.protocol.encode = encode
        f.store.close()
    }
})

test('damaged typed history is rejected and SQLite reopen retains per-account facts and monotonic receipts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-production-category-'))
    let f
    try {
        const file = path.join(dir, 'state.sqlite')
        f = productionProgressFixture('production-category-persistent', file)
        for (const ledger of [
            { version: 2, counts: {} },
            { version: 1, counts: { '02:3:1000001': 1 } },
            { version: 1, counts: { '2:3:1000001': -1 } },
            { version: 1, counts: { '2:3:1000001': 0x100000000 } },
        ]) {
            f.edit((s) => {
                s.home.productionProgress = ledger
            })
            assert.throws(
                () => value(f),
                (e) => e.code === ErrorCode.GameConfig,
            )
        }
        f.edit((s) => {
            delete s.home.productionProgress
        })
        for (let i = 0; i < 10; i++) f.produce(501004, 50)
        f.call('AchievementReward', { u32: 2020012 })
        const history = structuredClone(f.state().home.productionProgress)
        f.store.close()
        f = productionProgressFixture('production-category-persistent', file)
        assert.equal(value(f), 500)
        assert.deepEqual(f.state().home.productionProgress, history)
        assert(f.state().achievements.entries[2020012].claimed)
        const points = achievementPoints(f.tables, f.state())
        const repeat = f.call('AchievementReward', { u32: 2020012 })
        assert.deepEqual(f.protocol.decode('Rewards', repeat.find((p) => p.id === 9902).payload), { rewards: [] })
        assert.equal(achievementPoints(f.tables, f.state()), points)
        const other = {}
        f.call('EnterGame', { open_id: 'production-category-other' }, other)
        assert.equal(productionCategoryValue(f.tables, f.store.load(other.id).state, target), 0)
    } finally {
        f?.store.close()
        assert.equal(path.dirname(dir), os.tmpdir())
        assert(path.basename(dir).startsWith('lurukaps-production-category-'))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
