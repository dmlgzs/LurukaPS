import test from 'node:test'
import assert from 'node:assert/strict'
import { farmHarvestFixture } from './farm-harvest-fixture.js'
import { farmHarvestProgressValue, farmHarvestProgressRule } from '../src/farm-harvest-progress.js'
import { achievementCatalogue } from '../src/achievements.js'
import { journeyModel } from '../src/journey.js'
import { ErrorCode } from '../src/error-codes.js'
const manual = (f, type = 15) => farmHarvestProgressValue(f.tables, f.state(), [12005, type, 10000])
const item = (f, id) => farmHarvestProgressValue(f.tables, f.state(), [12062, 3, id, 10000])

test('farm source works before or after whole-family consumers and keeps literal15/19 roots and quantities distinct', () => {
    const f = farmHarvestFixture('farm-single-classification')
    try {
        const achievements = achievementCatalogue(f.tables)
        assert(
            [0, 3].includes(
                achievements.rows.filter(
                    (row) => row.finishCondition.startsWith('12005#') && achievements.rules.get(row.id).supported,
                ).length,
            ),
        )
        assert(
            [0, 2].includes(
                journeyModel(f.tables).targets.filter((row) => row.tokens[0] === 12062 && row.supported).length,
            ),
        )
        f.grow(31)
        f.harvest()
        assert.equal(manual(f), 4)
        assert.equal(item(f, 305901), 4)
        f.grow(31, 101)
        f.harvest(101)
        assert.equal(manual(f), 4)
        assert.equal(manual(f, 19), 4)
        assert.equal(item(f, 305901), 8)
        assert.deepEqual(f.state().home.farmHarvestProgress.roots, { '15:31': 1, '19:31': 1 })
        const once = f.state()
        assert.throws(
            () => f.harvest(),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
        assert.deepEqual(f.state(), once)
        for (const tokens of [
            [12005, 16, 1],
            [12005, 15, 0],
            [12062, 3, 310901, 1],
            [12062, 10, 1003, 1],
        ])
            assert.equal(farmHarvestProgressRule(f.tables, tokens), false)
    } finally {
        f.close()
    }
})

test('fifty actual plant,water,mature and6117 harvest cycles produce200 product units without injected harvest history', () => {
    const f = farmHarvestFixture('farm-single-two-hundred')
    try {
        for (let cycle = 1; cycle <= 50; cycle++) {
            f.grow(31)
            f.harvest()
            assert.equal(manual(f), cycle * 4)
        }
        assert.equal(f.state().home.farmHarvestProgress.roots['15:31'], 50)
        assert.equal(manual(f), 200)
    } finally {
        f.close()
    }
})

test('still-present old mature outcomes classify sealed products, exclude seed returns/EXP and preserve unknown awards with one diagnostic', () => {
    const f = farmHarvestFixture('farm-single-legacy'),
        warn = console.warn,
        logs = []
    console.warn = (...args) => {
        if (args[0] === '[farm-harvest-progress]') logs.push(JSON.parse(args[1]))
        else warn(...args)
    }
    try {
        const first = f.grow(31, 100, { seedReturn: true })
        assert(first.rewards.some((row) => row.itemid === 310901))
        f.edit((s) => {
            delete s.home.cropOutcomes[100].version
            delete s.home.builds.find((row) => row.guid === 100).build_type
            s.home.cropOutcomes[100].rewards.push({ itemtype: 10, itemid: 1003, itemnum: 1 })
        })
        f.harvest()
        assert.equal(manual(f), 4)
        const exp = f.grow(1)
        assert(exp.rewards.some((row) => row.itemtype === 10 && row.itemid === 1003))
        f.harvest()
        assert.equal(manual(f), 8)
        assert.equal(logs.length, 0)
        for (let cycle = 0; cycle < 2; cycle++) {
            f.grow(31)
            f.edit((s) => s.home.cropOutcomes[100].rewards.push({ itemtype: 3, itemid: 300000, itemnum: 1 }))
            const before = f
                .state()
                .player.sbag_infos.items.filter((row) => row.itemid === 300000)
                .reduce((n, row) => n + row.itemnum, 0)
            f.harvest()
            assert.equal(
                f
                    .state()
                    .player.sbag_infos.items.filter((row) => row.itemid === 300000)
                    .reduce((n, row) => n + row.itemnum, 0) - before,
                1,
            )
        }
        assert.equal(manual(f), 16)
        assert.equal(logs.filter((row) => row.item === '3:300000').length, 1)
    } finally {
        console.warn = warn
        f.close()
    }
})

test('6117 and HomeSync codec failures roll back actual rewards,cleared crop and prospective facts before one retry; worker deposit is not a manual grant', () => {
    const f = farmHarvestFixture('farm-single-atomic')
    try {
        for (const packetId of [6117, 6102]) {
            f.grow(31)
            const before = f.state(),
                encode = f.protocol.encode
            let visited = false
            f.protocol.encode = function (name, payload) {
                if (name === f.protocol.byId.get(packetId).rsp) {
                    visited = true
                    throw Error('farm-single-encode')
                }
                return encode.call(this, name, payload)
            }
            assert.throws(() => f.harvest(), /farm-single-encode/)
            assert(visited)
            assert.deepEqual(f.state(), before)
            f.protocol.encode = encode
            f.harvest()
        }
        assert.equal(manual(f), 8)
        f.assign()
        f.grow(32)
        f.harvest(100, true)
        assert.equal(manual(f), 8)
        assert.equal(item(f, 305902), 0)
        assert(
            f
                .state()
                .home.builds.find((row) => row.guid === 20)
                .auto_info.crops.some((row) => row.itemid === 305902 && row.itemnum === 4),
        )
    } finally {
        f.close()
    }
})

test('farm fact schema,aliases and unknown role history cannot forge products,and actual source overflow rolls back a ready harvest', () => {
    const f = farmHarvestFixture('farm-single-integrity'),
        warn = console.warn,
        logs = []
    console.warn = (...args) => {
        if (args[0] === '[farm-harvest-progress]') logs.push(JSON.parse(args[1]))
        else warn(...args)
    }
    try {
        for (const ledger of [
            null,
            { version: 1, revision: null, roots: {}, counts: {} },
            { version: 1, revision: 0, roots: { '15:031': 1 }, counts: {} },
            { version: 1, revision: 0, roots: {}, counts: { 'worker:15:31:3:305901': 1 } },
            { version: 1, revision: 0, roots: {}, counts: { 'manual:15:31:3:305901': -1 } },
        ])
            assert.throws(
                () => farmHarvestProgressValue(f.tables, { home: { farmHarvestProgress: ledger } }, [12005, 15, 200]),
                (e) => e.code === ErrorCode.GameConfig,
            )
        const unknown = {
            home: {
                farmHarvestProgress: { version: 1, revision: 1, roots: {}, counts: { 'manual:15:31:10:1003': 16 } },
            },
        }
        assert.equal(farmHarvestProgressValue(f.tables, unknown, [12005, 15, 200]), 0)
        assert.equal(farmHarvestProgressValue(f.tables, unknown, [12005, 15, 200]), 0)
        assert.equal(logs.filter((row) => row.source === 'typed-history-manual').length, 1)
        f.grow(31)
        f.edit((s) => {
            s.home.farmHarvestProgress = { version: 1, revision: 0xffffffff, roots: {}, counts: {} }
        })
        const before = f.state()
        assert.throws(
            () => f.harvest(),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        console.warn = warn
        f.close()
    }
})
