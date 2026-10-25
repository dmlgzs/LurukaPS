import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { productionProgressFixture } from './production-progress-fixture.js'
import { achievementCatalogue, achievementPoints } from '../src/achievements.js'
import { productionProgressRule, productionProgressValue, recordProductionOutput } from '../src/production-progress.js'
import { grantRewards } from '../src/rewards.js'
import { ErrorCode } from '../src/error-codes.js'

const value = (f, tokens) => productionProgressValue(f.tables, f.state(), tokens)
const saddle = [12018, 2, 25, 0, 1]

test('all15 current production achievements compile from station/reward selectors, without untyped history backfill', () => {
    const f = productionProgressFixture('production-achievement-catalogue')
    try {
        const model = achievementCatalogue(f.tables),
            rows = model.rows.filter((row) => row.finishCondition.startsWith('12018#'))
        assert.equal(rows.length, 15)
        assert.equal(
            rows.reduce((sum, row) => sum + row.achPoint, 0),
            71,
        )
        assert(rows.every((row) => model.rules.get(row.id).supported))
        assert.equal([...model.rules.values()].filter((row) => row.supported).length, 83)
        f.edit((s) => {
            s.home.craftCounts = { 600029: 999, 501005: 999, 9100101: 999, 9102001: 9999 }
            s.cookCounts = { 9000101: 9999 }
            grantRewards(f.tables, s, [
                { itemtype: 25, itemid: 500370, itemnum: 1 },
                { itemtype: 3, itemid: 9002901, itemnum: 1000 },
            ])
        })
        f.reload()
        assert.equal(value(f, saddle), 0)
        assert(rows.every((row) => !f.state().achievements.entries[row.id]?.finishTime))
        for (const tokens of [
            [12018, 6, 3, 1000008, 1],
            [12018, 2, 33, 0, 1],
            [12018, 2, 25, 0, 0],
            [12018, 2, 25, 0],
        ])
            assert.equal(productionProgressRule(f.tables, tokens), false)
        assert.equal(productionProgressRule(f.tables, [12018, 2, 3, 1000008, 1]), true)
        assert.equal(productionProgressRule(f.tables, [12018, 8, 33, 0, 1]), true)
    } finally {
        f.store.close()
    }
})

test('real saddle and star-card start/claim requests satisfy all ten exact/wildcard achievements and claim once', () => {
    const f = productionProgressFixture('production-achievement-exact')
    try {
        for (const id of [600029, 600024, 600035, 600009, 600018, 501005, 501006, 501007, 501008]) f.produce(id)
        for (let id = 2020001; id <= 2020010; id++) {
            assert.equal(f.state().achievements.entries[id]?.value, 1, String(id))
            const packets = f.call('AchievementReward', { u32: id })
            assert.equal(f.state().achievements.entries[id].claimed, true)
            assert(packets.some((row) => row.id === 9900))
            const points = achievementPoints(f.tables, f.state())
            f.call('AchievementReward', { u32: id })
            assert.equal(achievementPoints(f.tables, f.state()), points)
        }
        assert.equal(value(f, saddle), 5)
        assert.equal(value(f, [12018, 2, 3, 1000008, 1]), 1)
    } finally {
        f.store.close()
    }
})

test('quality cooking counts only actually claimed servings across100/500/1000 thresholds', () => {
    const f = productionProgressFixture('production-achievement-cooking')
    try {
        for (const [recipe, thresholds] of [
            [
                9100101,
                [
                    [100, 2020015],
                    [500, 2020016],
                ],
            ],
            [
                9102001,
                [
                    [100, 2020017],
                    [500, 2020018],
                    [1000, 2020019],
                ],
            ],
        ]) {
            let made = 0
            for (const [threshold, achievement] of thresholds) {
                assert.equal(f.state().achievements.entries[achievement]?.finishTime ?? 0, 0)
                while (made < threshold) {
                    const n = Math.min(100, threshold - made)
                    f.produce(recipe, n)
                    made += n
                }
                assert.equal(f.state().achievements.entries[achievement]?.value, threshold)
                f.call('AchievementReward', { u32: achievement })
                assert(f.state().achievements.entries[achievement].claimed)
            }
        }
    } finally {
        f.store.close()
    }
})

test('partial finish/cancel count only real completed output, never unfinished refunds or duplicate requests', () => {
    const f = productionProgressFixture('production-progress-cancel')
    const tokens = [12018, 2, 3, 350000, 1]
    try {
        let accepted = f.start(302001, 3)
        assert.equal(value(f, tokens), 0)
        f.advance(accepted.job.seconds)
        f.game.tick(f.session.id)
        assert.equal(value(f, tokens), 0)
        f.finish(accepted, true)
        assert.equal(value(f, tokens), 1)
        const saved = structuredClone(f.state())
        assert.throws(() => f.finish(accepted, true))
        assert.deepEqual(f.state(), saved)
        accepted = f.start(302001, 3)
        f.finish(accepted, true)
        assert.equal(value(f, tokens), 1)
        accepted = f.start(302001, 3)
        f.advance(accepted.job.seconds)
        f.finish(accepted)
        assert.equal(value(f, tokens), 2)
        f.advance(accepted.job.seconds)
        f.finish(accepted, true)
        assert.equal(value(f, tokens), 3)
    } finally {
        f.store.close()
    }
})

test('aggregate6554 and later individual claims share one producer without counting refunds or replaying output', () => {
    const f = productionProgressFixture('production-progress-aggregate')
    try {
        const accepted = f.start(501005, 3)
        f.advance(accepted.job.seconds)
        f.call('GetAllBuildReward', { build_guid: [accepted.guid] })
        const tokens = [12018, 2, 3, 1000008, 1]
        assert.equal(value(f, tokens), 1)
        f.call('GetAllBuildReward', { build_guid: [accepted.guid] })
        assert.equal(value(f, tokens), 1)
        f.advance(accepted.job.seconds)
        f.finish(accepted, true)
        assert.equal(value(f, tokens), 2)
    } finally {
        f.store.close()
    }
})

test('real achievement and home/reward response encoding failures roll back output, job and progress together', () => {
    const f = productionProgressFixture('production-progress-codec'),
        encode = f.protocol.encode
    try {
        const accepted = f.start(600029)
        f.advance(accepted.job.seconds)
        for (const type of ['SCAchievementSync', 'SCHomeSync', 'SCProductFinish']) {
            const shared = f.state(),
                before = structuredClone(shared)
            f.protocol.encode = function (name, ...args) {
                if (name.replace(/^cs\./, '') === type) throw Error('production progress codec failure')
                return encode.call(this, name, ...args)
            }
            assert.throws(() => f.finish(accepted), /production progress codec failure/)
            assert.deepEqual(f.state(), before)
            assert.deepEqual(shared, before)
            f.protocol.encode = encode
        }
        f.finish(accepted)
        assert.equal(value(f, saddle), 1)
    } finally {
        f.protocol.encode = encode
        f.store.close()
    }
})

test('typed output totals validate saved counters, exact quantities and actual building type without touching legacy counters', () => {
    const f = productionProgressFixture('production-progress-integrity')
    try {
        const build = f.state().home.builds[0]
        f.edit((s) => recordProductionOutput(f.tables, s, build, [{ itemtype: 3, itemid: 350000, itemnum: 7 }]))
        assert.equal(value(f, [12018, 2, 3, 350000, 1]), 7)
        assert.throws(
            () => recordProductionOutput(f.tables, f.state(), { ...build, build_type: 10 }, []),
            (e) => e.code === ErrorCode.GameConfig,
        )
        for (const ledger of [
            { version: 2, counts: {} },
            { version: 1, counts: [] },
            { version: 1, counts: { '2:3:350000': -1 } },
            { version: 1, counts: { '02:3:350000': 1 } },
        ]) {
            f.edit((s) => {
                s.home.productionProgress = ledger
            })
            assert.throws(
                () => value(f, saddle),
                (e) => e.code === ErrorCode.GameConfig,
            )
        }
        f.edit((s) => {
            s.home.productionProgress = { version: 1, counts: { '2:3:350000': 0xffffffff } }
        })
        const before = structuredClone(f.state())
        assert.throws(
            () =>
                f.edit((s) =>
                    recordProductionOutput(f.tables, s, build, [{ itemtype: 3, itemid: 350000, itemnum: 1 }]),
                ),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})

test('SQLite reopen and separate accounts retain claimed progress and achievement idempotency', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-production-progress-'))
    let f
    try {
        const file = path.join(directory, 'state.sqlite')
        f = productionProgressFixture('production-progress-persistent', file)
        f.produce(600029)
        f.call('AchievementReward', { u32: 2020002 })
        const saved = structuredClone(f.state().home.productionProgress)
        f.store.close()
        f = productionProgressFixture('production-progress-persistent', file)
        assert.deepEqual(f.state().home.productionProgress, saved)
        assert.equal(f.state().achievements.entries[2020002].claimed, true)
        const packets = f.call('AchievementReward', { u32: 2020002 })
        assert.deepEqual(f.protocol.decode('Rewards', packets.find((row) => row.id === 9902).payload), { rewards: [] })
        const other = {}
        f.call('EnterGame', { open_id: 'production-progress-other' }, other)
        assert.equal(productionProgressValue(f.tables, f.store.load(other.id).state, saddle), 0)
    } finally {
        f?.store.close()
        assert.equal(path.dirname(directory), os.tmpdir())
        assert(path.basename(directory).startsWith('lurukaps-production-progress-'))
        fs.rmSync(directory, { recursive: true, force: true })
    }
})
