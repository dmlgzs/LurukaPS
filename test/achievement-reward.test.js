import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { achievementFixture } from './achievement-fixture.js'
import { achievementCatalogue, achievementPoints } from '../src/achievements.js'
import { ErrorCode } from '../src/error-codes.js'

test('login publishes all configured achievement IDs and unfinished counters without unlocking unsupported events', () => {
    const f = achievementFixture('achievement-login')
    try {
        const model = achievementCatalogue(f.tables)
        assert.equal(model.rows.length, 355)
        assert(model.rows.every((r) => (r.nextAchi_id ?? r.nextAchi) === 0 && r.firstAchi === r.id && r.reward === ''))
        const packet = f.entryPackets.find((p) => p.id === 9900)
        const sync = f.protocol.decode('SCAchievementSync', packet.payload)
        assert.equal(sync.achievements.length, model.rows.length)
        assert.equal(sync.groups.length, model.groups.length)
        for (const item of sync.achievements) {
            const saved = f.state().achievements.entries[item.id]
            assert.equal(item.id, item.achievement_id)
            assert.equal(item.finish_time, String(saved?.finishTime ?? 0))
            assert.equal(item.is_reward, false)
        }
        const expectedPoints = model.rows.reduce(
            (sum, row) => sum + (f.state().achievements.entries[row.id]?.finishTime ? row.achPoint : 0),
            0,
        )
        assert.equal(achievementPoints(f.tables, f.state()), expectedPoints)
        const unsupported = model.rows.find((r) => !model.rules.get(r.id).supported)
        assert.deepEqual(sync.achievements.find((r) => r.id === unsupported.id).count, [])
    } finally {
        f.store.close()
    }
})

test('9902 decodes its real uint32 request, checks actual task receipts, and persists empty declared rewards once', () => {
    const f = achievementFixture('achievement-claim')
    try {
        assert.equal(f.protocol.byName.get('CSProtoAchievementReward').req, 'cs.CSUint32')
        const row = f.tables.get('achievement').find((r) => r.finishCondition.startsWith('2007#'))
        const task = Number(row.finishCondition.split('#')[1])
        assert(f.tables.find('task', task))
        assert.throws(
            () => f.call('AchievementReward', { u32: row.id }),
            (e) => e.code === ErrorCode.AchievementIsRunning,
        )
        const initialPoints = achievementPoints(f.tables, f.state())
        f.completedTask(task)
        const before = structuredClone(f.state().player.sbag_infos)
        const packets = f.call('AchievementReward', { u32: row.id })
        assert.deepEqual(f.reply(packets, 9902), { rewards: [], src: 20 })
        assert(packets.findIndex((p) => p.id === 9900) < packets.findIndex((p) => p.id === 9902))
        const item = f.protocol
            .decode('SCAchievementSync', packets.find((p) => p.id === 9900).payload)
            .achievements.find((r) => r.id === row.id)
        assert.equal(item.is_reward, true)
        assert.equal(item.finish_time, '1800000000')
        assert.equal(achievementPoints(f.tables, f.state()), initialPoints + row.achPoint)
        assert.deepEqual(f.state().player.sbag_infos, before)
        assert.deepEqual(f.reply(f.call('AchievementReward', { u32: row.id }), 9902), { rewards: [] })
        assert.equal(achievementPoints(f.tables, f.state()), initialPoints + row.achPoint)
    } finally {
        f.store.close()
    }
})

test('task-node and player-level observations use actual server state and preserve earned progress', () => {
    const f = achievementFixture('achievement-observation')
    try {
        const nodeRow = f.tables.get('achievement').find((r) => r.finishCondition.startsWith('12045#'))
        const [, task, node] = nodeRow.finishCondition.split('#').map(Number)
        f.store.transact(f.session.id, 0, (s) => {
            s.tasks = s.tasks.filter((t) => t.task_id !== task)
            s.tasks.push({ task_id: task, finish_nodes: [node], nodes: [] })
            s.player.basic_info.lv = 20
        })
        f.call('AchievementReward', { u32: nodeRow.id })
        const levelRow = f.tables.get('achievement').find((r) => r.finishCondition === '2004#20')
        assert(f.state().achievements.entries[levelRow.id].finishTime > 0)
        f.store.transact(f.session.id, 0, (s) => {
            s.player.basic_info.lv = 1
        })
        f.call('AchievementReward', { u32: levelRow.id })
        assert(f.state().achievements.entries[levelRow.id].claimed)
    } finally {
        f.store.close()
    }
})

test('unsupported conditions, unknown IDs and corrupted saved receipts fail without issuing rewards', () => {
    const f = achievementFixture('achievement-invalid')
    try {
        const model = achievementCatalogue(f.tables),
            unsupported = model.rows.find((r) => !model.rules.get(r.id).supported)
        for (const [id, code] of [
            [0, ErrorCode.AchievementConfFail],
            [unsupported.id, ErrorCode.FunctionClosed],
        ]) {
            const before = structuredClone(f.state())
            assert.throws(
                () => f.call('AchievementReward', { u32: id }),
                (e) => e.code === code,
            )
            assert.deepEqual(f.state(), before)
        }
        const row = model.rows.find((r) => r.finishCondition === '2004#20')
        f.store.transact(f.session.id, 0, (s) => {
            s.achievements.entries[row.id] = { value: 999, finishTime: 1, claimed: false }
        })
        const before = structuredClone(f.state())
        assert.throws(
            () => f.call('AchievementReward', { u32: row.id }),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})

test('sync and actual Rewards encoding failures roll back newly observed completion and claim state', () => {
    const f = achievementFixture('achievement-codec'),
        encode = f.protocol.encode
    try {
        const row = f.tables.get('achievement').find((r) => r.finishCondition.startsWith('2007#'))
        f.completedTask(Number(row.finishCondition.split('#')[1]))
        for (const type of ['SCAchievementSync', 'Rewards']) {
            const shared = f.state(),
                before = structuredClone(shared)
            f.protocol.encode = function (name, ...args) {
                if (name === type || name === 'cs.' + type) throw Error('achievement encoding failed')
                return encode.call(this, name, ...args)
            }
            assert.throws(() => f.call('AchievementReward', { u32: row.id }), /achievement encoding failed/)
            assert.deepEqual(f.state(), before)
            assert.deepEqual(shared, before)
            f.protocol.encode = encode
        }
        f.call('AchievementReward', { u32: row.id })
        assert(f.state().achievements.entries[row.id].claimed)
    } finally {
        f.protocol.encode = encode
        f.store.close()
    }
})

test('real SQLite reopen and login retain completion times and claims and do not duplicate achievement points', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-achievement-'))
    let f
    try {
        const file = path.join(dir, 'state.sqlite')
        f = achievementFixture('achievement-reopen', file)
        const row = f.tables.get('achievement').find((r) => r.finishCondition.startsWith('2007#'))
        f.completedTask(Number(row.finishCondition.split('#')[1]))
        f.call('AchievementReward', { u32: row.id })
        const before = structuredClone(f.state().achievements),
            points = achievementPoints(f.tables, f.state())
        f.store.close()
        f = achievementFixture('achievement-reopen', file)
        assert.deepEqual(f.state().achievements, before)
        assert.equal(achievementPoints(f.tables, f.state()), points)
        assert.deepEqual(f.reply(f.call('AchievementReward', { u32: row.id }), 9902), { rewards: [] })
    } finally {
        f?.store.close()
        assert.equal(path.dirname(dir), os.tmpdir())
        assert(path.basename(dir).startsWith('lurukaps-achievement-'))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
