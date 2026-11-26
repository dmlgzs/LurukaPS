import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { grantRewards } from '../src/rewards.js'
import { accessoryProductionChoices, accessoryProductionPlan } from '../src/accessory-production.js'
import { forgeProgressRule, forgeProgressValue } from '../src/forge-progress.js'
import { ErrorCode } from '../src/error-codes.js'
import { ObtInventoryConsumer } from './helpers/obt-inventory-consumer.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables)
function fixture(name, database = ':memory:') {
    const store = new Store(database),
        protocol = new Protocol(cfg.base),
        client = new ObtInventoryConsumer(tables, protocol)
    let now = 1800000000,
        seq = 1,
        session = {}
    const game = new Game(protocol, store, tables, { clock: () => now })
    const call = (name, request = {}) => {
        const entry = protocol.byName.get('CSProto' + name),
            packets = game.dispatch(session, {
                id: entry.id,
                seq: seq++,
                payload: entry.req ? protocol.encode(entry.req, request) : Buffer.alloc(0),
            })
        client.consumePackets(packets)
        return packets
    }
    const login = () => {
        session = {}
        return call('EnterGame', { open_id: name, reconnect: true })
    }
    login()
    const state = () => store.load(session.id).state,
        edit = (fn) => store.transact(session.id, 0, fn)
    // Trusted current station/unlock baseline, not a claim that this fixture
    // built a late-game station or cleared every material dungeon naturally.
    edit((s) => {
        s.player.basic_info.lv = 45
        if (!s.home.builds.some((b) => b.guid === 200))
            s.home.builds.push({
                guid: 200,
                build_id: 20241,
                build_type: 8,
                status: 1,
                locate: { block_id: 101, anchor: 6750239, direction: 0 },
            })
        s.materialDungeonRecords = Object.fromEntries(
            tables.get('dungeon_material').map((r) => [
                r.id,
                {
                    material_id: r.id,
                    material_star: 0,
                    success_count: 1,
                    difficulty_id: r.diff,
                    success_time: String(now),
                },
            ]),
        )
    })
    const request = (id, directed = true, count = 1) => {
        const row = tables.find('accessory_product', id),
            target = [...accessoryProductionChoices(tables, row.dropId).leaves.keys()][0]
        const select = String(row.materialSelect)
            .split('|')
            .filter(Boolean)
            .map((group) => {
                const option = tables.get('products_material_group').find((r) => r.materialGroupId === Number(group))
                assert(option)
                return option.Id
            })
        return {
            build_guid: 200,
            product_id: id,
            count,
            designated_item_id: directed ? target : 0,
            select_material: select,
        }
    }
    const prepare = (id, directed = true, count = 1) => {
        const r = request(id, directed, count),
            plan = accessoryProductionPlan(
                tables,
                state(),
                state().home.builds.find((b) => b.guid === 200),
                r,
            )
        edit((s) =>
            grantRewards(
                tables,
                s,
                plan.costs.map((row) => ({ ...row, itemnum: row.itemnum * count })),
            ),
        )
        return { request: r, plan }
    }
    const start = (id, directed = true, count = 1) => {
        const input = prepare(id, directed, count),
            before = new Set((state().home.productionJobs?.[200] ?? []).map((j) => j.guid)),
            packets = call('ProductOrnamentStart', input.request)
        return { ...input, packets, jobs: state().home.productionJobs[200].filter((j) => !before.has(j.guid)) }
    }
    const due = (jobs) => {
        now = Math.max(now, ...jobs.map((j) => j.start + j.count * j.seconds))
    }
    const finish = (jobs, mode = 'finish') =>
        mode === 'aggregate'
            ? call('GetAllBuildReward', { build_guid: [200] })
            : call(mode === 'cancel' ? 'ProductCancel' : 'ProductFinish', {
                  guid: 200,
                  product_guids: jobs.map((j) => j.guid),
              })
    return {
        store,
        protocol,
        client,
        game,
        call,
        login,
        state,
        edit,
        request,
        prepare,
        start,
        due,
        finish,
        value: (difficulty = 0) => forgeProgressValue(tables, state(), [15072, difficulty, 100]),
        snapshot: () => store.load(session.id),
        get session() {
            return session
        },
    }
}

test('all22 current recipes seal versioned current definitions including20 exact material-choice vectors; accept/cancel before output gives no15072 credit', () => {
    const f = fixture('forge-current-all22')
    try {
        const rows = tables.get('accessory_product')
        assert.equal(rows.length, 22)
        assert.equal(rows.filter((row) => row.materialSelect).length, 20)
        for (const row of rows) {
            const result = f.start(row.id),
                source = result.jobs[0].forgeProgressSource
            assert.equal(source.version, 2)
            assert.equal(source.resourceVersion, '3217420')
            assert.equal(source.productId, row.id)
            assert.equal(source.difficulty, row.difficulty)
            assert.equal(source.recipe.dropId, row.dropId)
            assert.deepEqual(source.recipe.groups, [21])
            assert.match(source.recipeFingerprint, /^[a-f0-9]{64}$/)
            assert.equal(source.outputItemId, result.request.designated_item_id)
            assert(source.isDirected)
            assert.equal(f.value(), 0)
            f.finish(result.jobs, 'cancel')
            assert.equal(f.value(), 0)
        }
        assert(forgeProgressRule(tables, [15072, 2, 1]), 'Current difficultyII is a real supported selector')
        assert.equal(forgeProgressRule(tables, [15072, 99, 1]), false)
        assert.equal(forgeProgressRule(tables, [15072, 0, 0]), false)
    } finally {
        f.store.close()
    }
})

test('actual current directed claims complete1/10/100 achievements, random remains separate and repeated claims/rewards cannot duplicate facts', () => {
    const f = fixture('forge-current-thresholds')
    try {
        assert.deepEqual(
            tables
                .get('achievement')
                .filter((r) => r.finishCondition.startsWith('15072#'))
                .map((r) => [r.id, r.finishCondition]),
            [
                [2020023, '15072#0#1'],
                [2020024, '15072#0#10'],
                [2020025, '15072#0#100'],
            ],
        )
        const random = f.start(2, false)
        f.due(random.jobs)
        f.finish(random.jobs)
        assert.equal(f.value(), 0)
        let total = 0
        const limit = tables.find('home_building_production', 20241).productionQueueNum
        for (const [threshold, id] of [
            [1, 2020023],
            [10, 2020024],
            [100, 2020025],
        ]) {
            while (total < threshold) {
                const count = Math.min(limit, threshold - total),
                    accepted = f.start(2, true, count)
                assert.equal(f.value(), total)
                f.due(accepted.jobs)
                f.game.tick(f.session.id)
                assert.equal(f.value(), total, 'Finished but unclaimed jobs are not ownership facts')
                f.finish(accepted.jobs, total % 2 ? 'aggregate' : 'finish')
                total += count
                assert.equal(f.value(), total)
            }
            assert.equal(f.state().achievements.entries[id].value, total)
            assert(f.state().achievements.entries[id].finishTime > 0)
            f.call('AchievementReward', { u32: id })
            const before = structuredClone(f.state().player)
            f.call('AchievementReward', { u32: id })
            assert.deepEqual(f.state().player, before)
        }
        assert.equal(f.value(2), 100)
        assert.equal(f.value(3), 0)
        assert.equal(f.client.ornaments.size, 101)
        const count = f.value()
        f.call('GetAllBuildReward', { build_guid: [200] })
        assert.equal(f.value(), count)
        f.login()
        assert.equal(f.value(), 100)
        assert([2020023, 2020024, 2020025].every((id) => f.state().achievements.entries[id].claimed))
    } finally {
        f.store.close()
    }
})

test('trusted old sealed pending and typed histories retain their old difficulty while a reused current ID writes an independent fingerprint namespace', () => {
    const f = fixture('forge-current-legacy')
    try {
        f.edit((s) => {
            s.home.forgeProgress = { version: 1, revision: 1, counts: { 'accessory_product:2:3:1': 5 } }
        })
        const accepted = f.start(2)
        f.edit((s) => {
            const job = s.home.productionJobs[200][0]
            // Trusted preexisting v1-source fixture, not current classification
            // by the reused product ID. Its already-paid output is preserved.
            job.forgeProgressSource = {
                version: 1,
                catalogue: 'CBT3-2451868-accessory-v1',
                namespace: 'accessory_product',
                productId: 2,
                difficulty: 3,
                isDirected: true,
                outputItemId: job.rewards[0].itemid,
                outputItemNum: 1,
            }
        })
        f.due(accepted.jobs)
        f.finish(accepted.jobs)
        assert.equal(f.value(3), 6)
        const current = f.start(2)
        f.due(current.jobs)
        f.finish(current.jobs)
        assert.equal(f.value(2), 1)
        assert.equal(f.value(3), 6)
        assert.equal(f.value(), 7)
        assert.equal(f.state().home.forgeProgress.counts['accessory_product:2:3:1'], 6)
        const key = Object.keys(f.state().home.forgeProgress.counts).find((key) =>
            key.startsWith('accessory_product_v3217420_'),
        )
        assert(key && key.endsWith(':2:2:1'))
        assert.equal(Object.keys(f.state().home.forgeProgress.sources).length, 1)
        const changed = Object.create(tables)
        changed.get = (name) =>
            name === 'accessory_product'
                ? tables.get(name).map((r) => (r.id === 2 ? { ...r, difficulty: 4, dropId: 660004 } : r))
                : tables.get(name)
        assert.equal(
            forgeProgressValue(changed, f.state(), [15072, 2, 1]),
            1,
            'Trusted claimed history is not reinterpreted by later same-ID rows',
        )
        f.login()
        assert.equal(f.value(), 7)
    } finally {
        f.store.close()
    }
})

test('only exact old unsealed definitions can recover; unknown/mutated source still awards output without inventing missing history', () => {
    const f = fixture('forge-current-unsealed')
    try {
        for (const [id, expected] of [
            [1, 1],
            [2, 1],
        ]) {
            const accepted = f.start(id)
            f.edit((s) => {
                delete s.home.productionJobs[200][0].forgeProgressSource
            })
            f.due(accepted.jobs)
            f.finish(accepted.jobs)
            assert.equal(f.value(), expected)
        }
        for (const mode of ['tampered', 'version0']) {
            const accepted = f.start(22)
            f.edit((s) => {
                const job = s.home.productionJobs[200][0]
                if (mode === 'tampered') job.forgeProgressSource.recipe.difficulty = 1
                else job.forgeProgressSource = { version: 0, namespace: 'accessory_product', productId: 22 }
            })
            f.due(accepted.jobs)
            f.finish(accepted.jobs)
            assert.equal(f.value(), 1)
        }
        assert.equal(f.state().ornaments.length, 4)
        f.edit((s) => {
            s.home.productionProgress = { version: 1, counts: { '8:33:10001': 999 } }
            s.home.craftCounts = { 2: 999 }
        })
        assert.equal(f.value(), 1, 'Stock, generic production and craft totals never become typed forge facts')
    } finally {
        f.store.close()
    }
})

test('current acceptance/claim codec and SQLite failures roll back source definitions, counts, outputs and achievements, with one clean retry', () => {
    const f = fixture('forge-current-rollback'),
        encode = f.protocol.encode.bind(f.protocol)
    try {
        const input = f.prepare(22),
            before = f.snapshot(),
            startRsp = f.protocol.byName.get('CSProtoProductOrnamentStart').rsp
        f.protocol.encode = (name, data) => {
            if (name === startRsp) throw Error('forge current acceptance codec')
            return encode(name, data)
        }
        assert.throws(() => f.call('ProductOrnamentStart', input.request), /forge current acceptance codec/)
        assert.deepEqual(f.snapshot(), before)
        f.protocol.encode = encode
        f.call('ProductOrnamentStart', input.request)
        const jobs = f.state().home.productionJobs[200]
        f.due(jobs)
        const pending = f.snapshot(),
            finishRsp = f.protocol.byName.get('CSProtoProductFinish').rsp
        f.protocol.encode = (name, data) => {
            if (name === finishRsp) throw Error('forge current claim codec')
            return encode(name, data)
        }
        assert.throws(() => f.finish(jobs), /forge current claim codec/)
        assert.deepEqual(f.snapshot(), pending)
        f.protocol.encode = encode
        f.store.db.exec(
            "CREATE TRIGGER forge_current_test BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT, 'forge current SQL'); END",
        )
        assert.throws(() => f.finish(jobs), /forge current SQL/)
        assert.deepEqual(f.snapshot(), pending)
        f.store.db.exec('DROP TRIGGER forge_current_test')
        f.finish(jobs)
        assert.equal(f.value(), 1)
        assert.equal(f.state().ornaments.length, 1)
        assert.equal(Object.keys(f.state().home.forgeProgress.sources).length, 1)
        assert.throws(
            () => f.finish(jobs),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
        assert.equal(f.value(), 1)
    } finally {
        f.protocol.encode = encode
        f.store.close()
    }
})

test('actual temporary SQLite close/reopen keeps current source proof and old counters, with strict metadata corruption checks', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-current-')),
        file = path.join(directory, 'state.sqlite')
    let f
    try {
        f = fixture('forge-current-persist', file)
        f.edit((s) => {
            s.home.forgeProgress = { version: 1, revision: 1, counts: { 'accessory_product:2:3:1': 3 } }
        })
        const accepted = f.start(22)
        f.store.close()
        f = fixture('forge-current-persist', file)
        const pending = f.state().home.productionJobs[200]
        assert.deepEqual(pending[0].forgeProgressSource, accepted.jobs[0].forgeProgressSource)
        f.due(pending)
        f.finish(pending)
        assert.equal(f.value(), 4)
        f.store.close()
        f = fixture('forge-current-persist', file)
        assert.equal(f.value(), 4)
        f.edit((s) => {
            Object.values(s.home.forgeProgress.sources)[0].recipe.dropId++
        })
        assert.throws(
            () => f.value(),
            (e) => e.code === ErrorCode.GameConfig,
        )
    } finally {
        f?.store.close()
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()))
        assert(path.basename(directory).startsWith('forge-current-'))
        for (const name of fs.readdirSync(directory)) {
            assert(['state.sqlite', 'state.sqlite-journal'].includes(name))
            fs.unlinkSync(path.join(directory, name))
        }
        fs.rmdirSync(directory)
    }
})
