import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { forgeFixture } from './forge-progress-fixture.js'
import { forgeProgressRule, forgeProgressValue, forgeProgressRevision } from '../src/forge-progress.js'
import { achievementCatalogue } from '../src/achievements.js'
import { journeyModel } from '../src/journey.js'
import { ErrorCode } from '../src/error-codes.js'
import { grantRewards, parseRewards } from '../src/rewards.js'

const value = (f, difficulty = 0) => forgeProgressValue(f.tables, f.state(), [15072, difficulty, 100])

test('stage10202 seals all17 recipe sources, while both complete consumers remain unsupported until their own stages', () => {
    const f = forgeFixture('forge-source-seal')
    try {
        const ach = achievementCatalogue(f.tables),
            journey = journeyModel(f.tables)
        //This source test intentionally does not assert a global catalogue
        //number: later independent consumer patches must remain composable.
        assert.equal(ach.rows.filter((r) => r.finishCondition.startsWith('15072#')).length, 3)
        const initialSupport = ach.rows
            .filter((r) => r.finishCondition.startsWith('15072#'))
            .filter((r) => ach.rules.get(r.id).supported).length
        assert([0, 3].includes(initialSupport))
        assert.equal(journey.targets.filter((r) => r.tokens[0] === 15072).length, 2)
        for (const recipe of f.tables.get('accessory_product')) {
            const accepted = f.start(recipe.id, true)
            const source = accepted.jobs[0].forgeProgressSource
            assert.equal(source.namespace, 'accessory_product')
            assert.equal(source.productId, recipe.id)
            assert.equal(source.difficulty, recipe.difficulty)
            assert.equal(source.isDirected, true)
            assert.equal(source.outputItemId, accepted.plan.target)
            assert.equal(value(f), 0)
            f.finish(accepted.jobs, 'cancel')
            assert.equal(value(f), 0)
        }
        for (const rule of [
            [15072, 0, 0],
            [15072, 2, 1],
            [15072, 4],
            [15072, 4, 1, 0],
        ])
            assert.equal(forgeProgressRule(f.tables, rule), false)
    } finally {
        f.store.close()
    }
})

test('random and directed same output remain distinct facts;100 actual directed pieces include10 difficultyIV through all three claims', () => {
    const f = forgeFixture('forge-source-counts')
    try {
        const all = f.tables.get('accessory_product'),
            low = all.find((r) => r.difficulty === 1),
            iv = all.find((r) => r.difficulty === 4)
        f.make(low.id, false)
        assert.equal(value(f), 0)
        assert.equal(
            Object.values(f.state().home.forgeProgress.counts).reduce((a, b) => a + b, 0),
            1,
        )
        let total = 0
        for (const [recipe, goal] of [
            [low, 90],
            [iv, 100],
        ])
            while (total < goal) {
                const limit = f.tables.find('home_building_production', 20241).productionQueueNum
                const count = Math.min(limit, goal - total),
                    mode = ['finish', 'cancel', 'aggregate'][total % 3]
                f.make(recipe.id, true, count, mode)
                total += count
                assert.equal(value(f), total)
            }
        assert.equal(value(f, 4), 10)
        assert.equal(forgeProgressRevision(f.state()), 101)
        assert.equal(
            Object.values(f.state().home.forgeProgress.counts).reduce((a, b) => a + b, 0),
            101,
        )
    } finally {
        f.store.close()
    }
})

test('partial finish,cancel refunds,retime and aggregate retries preserve accepted provenance and count only real awarded items', () => {
    const f = forgeFixture('forge-source-partial')
    try {
        const recipe = f.tables.get('accessory_product').find((r) => r.difficulty === 1)
        const accepted = f.start(recipe.id, true, 3),
            source = structuredClone(accepted.jobs.map((j) => j.forgeProgressSource))
        const station = f.tables.find('home_building_production', 20241),
            labor = String(station.laborType).split('|').map(Number),
            sizes = String(station.petSize).split('|').map(Number)
        const worker = f
            .state()
            .pets.find(
                (p) =>
                    !p.work_status &&
                    p.labor_infos.some((info) => labor.includes(info.labor_id)) &&
                    sizes.includes(f.tables.find('pet_home_talent', p.config_id)?.sizeType),
            )
        assert(worker)
        f.call('PetStationed', { pet_guid: worker.guid, build_guid: 200, build_type: 1 })
        const retimed = f.state().home.productionJobs[200]
        assert(retimed.every((job) => job.seconds < accepted.jobs[0].seconds))
        assert.deepEqual(
            retimed.map((job) => job.forgeProgressSource),
            source,
        )
        f.advance(retimed[0].seconds)
        f.game.tick(f.session.id)
        assert.equal(value(f), 0)
        f.finish([accepted.jobs[0]])
        assert.equal(value(f), 1)
        const pending = f.state().home.productionJobs[200]
        assert.deepEqual(
            pending.map((j) => j.forgeProgressSource),
            source.slice(1),
        )
        f.advance(pending[0].seconds)
        f.finish(pending, 'cancel')
        assert.equal(value(f), 2)
        f.call('GetAllBuildReward', { build_guid: [200] })
        assert.equal(value(f), 2)
        assert.equal(f.state().home.productionJobs[200].length, 0)
    } finally {
        f.store.close()
    }
})

test('stable0035 pending classifies without forcing discounted paid costs to current original prices', () => {
    const f = forgeFixture('forge-source-legacy')
    try {
        f.edit((s) => {
            s.home.technology ??= { levels: {} }
            s.home.technology.levels[10093] = { level: 1, lastTime: 0, isOpened: true }
        })
        const accepted = f.start(1, true, 2)
        const paid = structuredClone(accepted.jobs[0].costs)
        const original = [
            ...parseRewards(f.tables.find('accessory_product', 1).material),
            ...parseRewards(f.tables.find('accessory_product', 1).locateCost),
        ]
        assert(
            paid.some(
                (row) =>
                    row.itemnum <
                    original.find((old) => old.itemtype === row.itemtype && old.itemid === row.itemid).itemnum,
            ),
        )
        f.edit((s) => {
            for (const job of s.home.productionJobs[200]) delete job.forgeProgressSource
        })
        f.advance(accepted.jobs[0].seconds)
        const stock = () =>
            f
                .state()
                .player.sbag_infos.items.filter((row) => row.itemid === 353016)
                .reduce((sum, row) => sum + row.itemnum, 0)
        const beforeRefund = stock()
        f.finish(f.state().home.productionJobs[200], 'cancel')
        assert.equal(stock() - beforeRefund, paid.find((row) => row.itemid === 353016).itemnum)
        assert.equal(value(f), 1)
        assert.deepEqual(accepted.jobs[0].costs, paid)
        assert.equal(f.state().home.productionJobs[200].length, 0)
    } finally {
        f.store.close()
    }
})

test('unknown namespaces/recipe histories keep original awards and log once without borrowing mixed8:33 totals', () => {
    const f = forgeFixture('forge-source-unknown'),
        warn = console.warn,
        events = []
    console.warn = (tag, text) => {
        if (tag === '[forge-progress]') events.push(JSON.parse(text))
    }
    try {
        for (let i = 0; i < 2; i++) {
            const accepted = f.start(1, true)
            f.edit((s) => {
                s.home.productionJobs[200][0].forgeProgressSource.namespace = 'future_source'
            })
            f.due(accepted.jobs)
            f.finish(accepted.jobs)
        }
        assert.equal(f.state().ornaments.length, 2)
        assert.equal(value(f), 0)
        assert.equal(events.filter((e) => e.namespace === 'future_source').length, 1)
        assert.equal(events.filter((e) => e.namespace === 'untyped-history').length, 1)
        const accepted = f.start(1, true)
        f.edit((s) => {
            const job = s.home.productionJobs[200][0]
            delete job.forgeProgressSource
            job.productId = 999999
        })
        f.due(accepted.jobs)
        f.finish(accepted.jobs)
        assert.equal(f.state().ornaments.length, 3)
        assert.equal(value(f), 0)
        assert.equal(events.filter((e) => e.productId === 999999).length, 1)
        const other = forgeFixture('forge-source-mixed-history')
        try {
            other.edit((s) => {
                s.home.productionProgress = { version: 1, counts: { '8:33:50017': 20 } }
            })
            other.make(1, true)
            const beforeWarnings = events.length
            assert.equal(value(other), 1)
            assert.equal(value(other), 1)
            assert.equal(events.length - beforeWarnings, 1)
            assert.equal(events.at(-1).namespace, 'untyped-history')
        } finally {
            other.store.close()
        }
    } finally {
        console.warn = warn
        f.store.close()
    }
})

test('actual acceptance and claim codec failures are atomic; SQLite reopen preserves provenance, facts and account isolation', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-forge-progress-'))
    let f
    try {
        const file = path.join(directory, 'state.sqlite')
        f = forgeFixture('forge-source-persistent', file)
        const plan = f.plan(1, true)
        f.edit((s) => grantRewards(f.tables, s, plan.costs))
        const initial = structuredClone(f.state()),
            initialEncode = f.protocol.encode
        const acceptedType = f.protocol.byName.get('CSProtoProductOrnamentStart').rsp
        let acceptFault = false
        f.protocol.encode = function (name, ...args) {
            if (name === acceptedType) {
                acceptFault = true
                throw Error('forge-accept-codec')
            }
            return initialEncode.call(this, name, ...args)
        }
        try {
            assert.throws(
                () =>
                    f.call('ProductOrnamentStart', {
                        build_guid: 200,
                        product_id: 1,
                        count: 1,
                        designated_item_id: plan.target,
                    }),
                /forge-accept-codec/,
            )
        } finally {
            f.protocol.encode = initialEncode
        }
        assert(acceptFault)
        assert.deepEqual(f.state(), initial)
        const accepted = f.start(1, true)
        const source = structuredClone(accepted.jobs[0].forgeProgressSource)
        f.store.close()
        f = forgeFixture('forge-source-persistent', file)
        assert.deepEqual(f.state().home.productionJobs[200][0].forgeProgressSource, source)
        f.due(f.state().home.productionJobs[200])
        const encode = f.protocol.encode
        for (const wire of [
            'CSProtoProductFinish',
            'CSProtoProductCancel',
            'CSProtoGetAllBuildReward',
            'CSProtoHomeSync',
        ]) {
            const before = structuredClone(f.state()),
                shared = f.state(),
                type = f.protocol.byName.get(wire).rsp
            f.protocol.encode = function (name, ...args) {
                if (name === type) throw Error('forge-codec')
                return encode.call(this, name, ...args)
            }
            const mode =
                wire === 'CSProtoProductCancel'
                    ? 'cancel'
                    : wire === 'CSProtoGetAllBuildReward'
                      ? 'aggregate'
                      : 'finish'
            try {
                assert.throws(() => f.finish(f.state().home.productionJobs[200], mode), /forge-codec/)
            } finally {
                f.protocol.encode = encode
            }
            assert.deepEqual(f.state(), before)
            assert.deepEqual(shared, before)
        }
        f.finish(f.state().home.productionJobs[200])
        assert.equal(value(f), 1)
        f.store.close()
        f = forgeFixture('forge-source-persistent', file)
        assert.equal(value(f), 1)
        const other = {}
        f.call('EnterGame', { open_id: 'forge-source-other' }, other)
        assert.equal(forgeProgressValue(f.tables, f.store.load(other.id).state, [15072, 0, 1]), 0)
        f.edit((s) => {
            s.home.forgeProgress.counts['accessory_product:01:1:1'] = 1
        })
        assert.throws(
            () => value(f),
            (e) => e.code === ErrorCode.GameConfig,
        )
    } finally {
        f?.store.close()
        assert.equal(path.dirname(directory), os.tmpdir())
        assert(path.basename(directory).startsWith('lurukaps-forge-progress-'))
        fs.rmSync(directory, { recursive: true, force: true })
    }
})
