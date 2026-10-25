import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { cookingVarietyRule, cookingVarietyValue } from '../src/production-progress.js'
import { achievementCatalogue, achievementPoints } from '../src/achievements.js'
import { grantRewards } from '../src/rewards.js'
import { ErrorCode } from '../src/error-codes.js'
import { cookingVarietyFixture } from './cooking-variety-fixture.js'

const count = (f, facts) => cookingVarietyValue(f.tables, f.state(), [12210, 30], facts)
const catalogueRows = (f) =>
    achievementCatalogue(f.tables)
        .rows.filter((row) => row.finishCondition.startsWith('12210#'))
        .sort((a, b) => a.param - b.param)

test('complete12210 catalogue maps food groups across all known qualities and rejects malformed/unsupported classification', () => {
    const f = cookingVarietyFixture('cook-variety-catalogue')
    try {
        const model = achievementCatalogue(f.tables),
            rows = catalogueRows(f)
        assert.deepEqual(
            rows.map((row) => row.param),
            [10, 20, 30],
        )
        assert(rows.every((row) => model.rules.get(row.id).supported))
        assert.equal(model.rows.length, 355)
        assert.equal([...model.rules.values()].filter((row) => row.supported).length, 111)
        assert.equal(f.current.length, 212)
        assert.equal(f.groups.size, 48)
        assert.equal(count(f), 0)
        for (const tokens of [[12210], [12210, 0], [12210, 49], [12210, 10, 1], [15021, 10]])
            assert.equal(cookingVarietyRule(f.tables, tokens), false)
        const selected = f.current.filter((row) => row.productGroup === 1)
        f.edit((s) => {
            s.home.productionProgress = {
                version: 1,
                counts: Object.fromEntries(selected.map((row) => ['10:3:' + row.id, 1])),
            }
        })
        assert.equal(count(f), 1, 'this synthetic ledger classifies five qualities; it is not the real30-group test')
        const bad = Object.create(f.tables)
        bad.get = (name) =>
            name === 'products_multi_quality' ? [...f.tables.get(name), { ...selected[0] }] : f.tables.get(name)
        assert.throws(
            () => cookingVarietyRule(bad, [12210, 10]),
            (error) => error.code === ErrorCode.GameConfig,
        )
        const missing = Object.create(f.tables)
        missing.get = (name) =>
            name === 'products_multi_quality'
                ? f.tables.get(name).filter((row) => row.id !== selected[0].id)
                : f.tables.get(name)
        assert.throws(
            () => cookingVarietyRule(missing, [12210, 10]),
            (error) => error.code === ErrorCode.GameConfig,
        )
    } finally {
        f.close()
    }
})

test('thirty real recipe groups cook through10201 and6111/6554 and earn all three12210 rewards exactly once', () => {
    const f = cookingVarietyFixture('cook-variety-thirty')
    try {
        const recipes = [...f.groups.entries()].sort((a, b) => a[0] - b[0]).slice(0, 30),
            rows = catalogueRows(f)
        assert.equal(count(f), 0)
        for (const [index, [, recipe]] of recipes.entries()) {
            f.cook(recipe.id, index % 2 === 1)
            assert.equal(count(f), index + 1)
            for (const row of rows)
                assert.equal((f.state().achievements.entries[row.id]?.finishTime ?? 0) > 0, index + 1 >= row.param)
        }
        assert.equal(Object.keys(f.state().home.productionProgress.counts).length, 30)
        for (const row of rows) {
            const first = f.call('AchievementReward', { u32: row.id }).find((packet) => packet.id === 9902)
            assert.deepEqual(f.protocol.decode('Rewards', first.payload).rewards, [])
            const points = achievementPoints(f.tables, f.state())
            const second = f.call('AchievementReward', { u32: row.id }).find((packet) => packet.id === 9902)
            assert.deepEqual(f.protocol.decode('Rewards', second.payload).rewards, [])
            assert.equal(achievementPoints(f.tables, f.state()), points)
            assert.equal(f.state().achievements.entries[row.id].claimed, true)
        }
    } finally {
        f.close()
    }
})

test('same dish five real qualities count once; home and world remote maps retain the same owned source while mill processing is excluded', () => {
    const f = cookingVarietyFixture('cook-variety-qualities')
    try {
        f.edit((state) => {
            // This scene-navigation case assumes a post-prologue account.
            // Otherwise the starter task intentionally redirects EnterHome
            // back into its task scene. These are isolated prerequisites,
            // never cooking history or target achievement receipts.
            state.taskRecords ??= []
            for (const task of f.tables.get('task').filter((row) => row.type === 1))
                if (!state.taskRecords.some((row) => row.task_id === task.id))
                    state.taskRecords.push({ task_id: task.id, count: 1, time: 1799999900 })
            delete state.pendingTaskScene
            delete state.pendingTaskStorySync
        })
        const variants = f.current
            .filter((row) => row.productGroup === 1)
            .sort((a, b) => a.productRarity - b.productRarity)
        assert.equal(variants.length, 5)
        f.call('EnterHome')
        const homeMap = f.state().world.map_id
        f.cook(variants[0].id)
        assert.equal(count(f), 1)
        const point = f.tables.get('world_borthpos').find((row) => row.cityId === 100)
        f.call('EnterWorldMap', { map_id: 100, point_id: point.id })
        assert.notEqual(f.state().world.map_id, homeMap)
        for (const variant of variants.slice(1)) {
            f.cook(variant.id)
            assert.equal(count(f), 1)
        }
        const mill = f.tables.get('products_multi_quality').find((row) => {
            const product = f.tables.find('products', row.productId)
            return product?.type === 2 && !product.notReleased
        })
        assert(mill)
        const warn = console.warn,
            messages = []
        try {
            console.warn = (...args) => messages.push(args)
            const accepted = f.start(mill.id)
            f.due(accepted)
            f.finish(accepted)
            assert.equal(count(f), 1)
            assert.equal(messages.filter((args) => args[0] === '[cooking-variety]').length, 0)
        } finally {
            console.warn = warn
        }
        f.edit((s) => {
            grantRewards(f.tables, s, [{ itemtype: 3, itemid: variants[0].id, itemnum: 5 }])
            s.home.craftCounts[999999] = 99999
            s.home.cookCounts = { [variants[0].id]: 99999 }
        })
        assert.equal(count(f), 1)
    } finally {
        f.close()
    }
})

test('unclaimed stock, incomplete cancellation, partial/repeated claims and unknown legacy outputs cannot invent cooked groups', () => {
    const f = cookingVarietyFixture('cook-variety-partial')
    try {
        const choices = [...f.groups.values()].slice(0, 3)
        let accepted = f.start(choices[0].id, 3)
        f.finish(accepted, true)
        assert.equal(count(f), 0)
        accepted = f.start(choices[1].id, 3)
        f.due(accepted, 1)
        f.game.tick(f.session.id)
        assert.equal(count(f), 0)
        f.finish(accepted)
        assert.equal(count(f), 1)
        assert.throws(() => f.finish(accepted))
        f.finish(accepted, true)
        assert.equal(count(f), 1)
        accepted = f.start(choices[2].id, 2)
        f.due(accepted)
        f.aggregate(accepted)
        f.aggregate(accepted)
        assert.equal(count(f), 2)
        const unknown = f.tables
            .get('food')
            .find((row) => !f.tables.get('products_multi_quality').some((quality) => quality.id === row.id))
        const warn = console.warn,
            messages = []
        try {
            console.warn = (...args) => messages.push(args)
            const processing = f.tables
                .get('products_multi_quality')
                .find((row) => f.tables.find('products', row.productId)?.type === 2)
            f.edit((s) => {
                s.home.productionProgress.counts['10:3:' + processing.id] = 1
            })
            assert.equal(count(f), 2)
            assert.equal(
                messages.filter((args) => args[0] === '[cooking-variety]').length,
                0,
                'known non-food processing has no unknown warning even in legacy typed stock',
            )
            f.edit((s) => {
                s.home.productionProgress.counts['10:3:' + unknown.id] = 1
                s.home.productionProgress.counts['10:10:' + choices[0].id] = 1
                s.home.productionProgress.counts['2:3:' + choices[0].id] = 1
            })
            assert.equal(count(f), 2)
            assert.equal(count(f), 2)
            assert.equal(messages.filter((args) => args[0] === '[cooking-variety]').length, 1)
        } finally {
            console.warn = warn
        }
    } finally {
        f.close()
    }
})

test('real final cooked group and achievement reward encoding roll back atomically; SQLite reopen retains classified facts and claims', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cooking-variety-')),
        filename = path.join(directory, 'state.sqlite')
    let f
    try {
        f = cookingVarietyFixture('cook-variety-file', filename)
        const recipes = [...f.groups.values()].slice(0, 10)
        for (const recipe of recipes.slice(0, 9)) f.cook(recipe.id)
        assert.equal(count(f), 9)
        const accepted = f.start(recipes[9].id)
        f.due(accepted)
        const encode = f.protocol.encode
        for (const type of [
            f.protocol.byName.get('CSProtoProductFinish').rsp,
            f.protocol.byName.get('CSProtoHomeSync').rsp,
            'cs.SCAchievementSync',
        ]) {
            const before = structuredClone(f.store.load(f.session.id))
            let hit = false
            f.protocol.encode = function (name, ...args) {
                if (name === type) {
                    hit = true
                    throw Error('cooking-variety-codec')
                }
                return encode.call(this, name, ...args)
            }
            assert.throws(() => f.finish(accepted), /cooking-variety-codec/)
            assert(hit)
            assert.deepEqual(f.store.load(f.session.id), before)
            assert.equal(count(f), 9)
            f.protocol.encode = encode
        }
        f.finish(accepted)
        assert.equal(count(f), 10)
        const target = catalogueRows(f)[0],
            before = structuredClone(f.store.load(f.session.id))
        f.protocol.encode = function (name, ...args) {
            if (name === 'cs.Rewards') throw Error('cooking-variety-reward')
            return encode.call(this, name, ...args)
        }
        assert.throws(() => f.call('AchievementReward', { u32: target.id }), /cooking-variety-reward/)
        assert.deepEqual(f.store.load(f.session.id), before)
        f.protocol.encode = encode
        f.call('AchievementReward', { u32: target.id })
        const history = structuredClone(f.state().home.productionProgress)
        f.close()
        f = undefined
        f = cookingVarietyFixture('cook-variety-file', filename, true)
        assert.equal(count(f), 10)
        assert.deepEqual(f.state().home.productionProgress, history)
        assert(f.state().achievements.entries[target.id].claimed)
        const other = {}
        f.call('EnterGame', { open_id: 'cook-variety-other' }, other)
        assert.equal(cookingVarietyValue(f.tables, f.store.load(other.id).state, [12210, 10]), 0)
    } finally {
        f?.close()
        const resolved = path.resolve(directory)
        assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()))
        assert(path.basename(resolved).startsWith('cooking-variety-'))
        fs.rmSync(resolved, { recursive: true, force: true })
    }
})
