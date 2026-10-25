import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { achievementCatalogue } from '../src/achievements.js'
import { ErrorCode } from '../src/error-codes.js'
import { entrustStarProgressRule, entrustStarProgressValue } from '../src/entrust-star-progress.js'
import { tables, catalog, entrustProgressFixture } from './entrust-star-progress-fixture.js'

const value = (state) => entrustStarProgressValue(tables, state, [12252, 3, 30])
function recorded(id, star = 3) {
    return {
        entrust_id: id,
        entrust_star: star,
        group_id: tables.find('dungeon_entrust', id).groupId,
        success_time: '1',
        entrust_start_bit: star === 3 ? 7 : 0,
    }
}
test('complete current12252 family compiles by explicit compatibility policy and strict configured record identities', () => {
    const model = achievementCatalogue(tables)
    const rows = model.rows.filter((r) => r.finishCondition.startsWith('12252#'))
    assert.deepEqual(
        rows.map((r) => r.id),
        [5050018, 5050019],
    )
    assert(rows.every((r) => model.rules.get(r.id).supported))
    assert.equal([...model.rules.values()].filter((r) => r.supported).length, 111)
    const ids = tables.get('dungeon_entrust').map((r) => r.id)
    assert.equal(ids.length, 32)
    assert.equal(value({ entrust: { records: { 1: { ...recorded(1, 2), entrust_start_bit: 7 } } } }), 0)
    assert.equal(
        value({
            entrust: { records: {} },
            materialDungeonRecords: { 1: recorded(1) },
            weeklyDungeonRecords: { 1: recorded(1) },
        }),
        0,
    )
    for (const bad of [
        { '01': recorded(1) },
        { 1: { ...recorded(1), entrust_id: 2 } },
        { 1: { ...recorded(1), group_id: 999 } },
        { 1: { ...recorded(1), entrust_star: 4 } },
        { 1: { ...recorded(1), entrust_star: Number.NaN } },
        { 1: { ...recorded(1), entrust_star: null } },
    ])
        assert.throws(
            () => value({ entrust: { records: bad } }),
            (e) => e.code === ErrorCode.GameConfig,
        )
    assert.equal(value({ entrust: { records: { 999999: { entrust_star: 3 } } } }), 0)
    for (const tokens of [
        [12252, 0, 10],
        [12252, 4, 10],
        [12252, 3, 0],
        [12252, 3, 10, 1],
    ])
        assert.equal(entrustStarProgressRule(tables, tokens), false)
    // Historical aggregate boundary only: this is not32 simulated battles.
    const records = Object.fromEntries(ids.slice(0, 30).map((id) => [id, recorded(id)]))
    assert.equal(value({ entrust: { records } }), 30)
})

test('real repeated commission reports retain best stars, never turn cross-run OR bits into a three-star finish', () => {
    const f = entrustProgressFixture('entrust-star-real-runs')
    try {
        const scene = catalog.get(1).scene
        const thresholds = tables
            .get('common_challenge')
            .filter((r) => r.group === scene.challengeGroup && r.type === 1)
            .map((r) => r.challengeCondition.split('#').map(Number))
            .filter((p) => p[0] === 3006)
            .map((p) => p[1])
            .sort((a, b) => a - b)
        assert.equal(thresholds.length, 2)
        f.finish(1, { death: true })
        assert.equal(f.state().entrust.records[1].entrust_star, 2)
        const firstBits = f.state().entrust.records[1].entrust_start_bit
        assert.equal(value(f.state()), 0)
        f.quit()
        f.finish(1, { elapsed: thresholds[0] + 1 })
        assert.equal(f.state().entrust.records[1].entrust_star, 2)
        assert.equal(f.state().entrust.records[1].entrust_start_bit, 7)
        assert.notEqual(firstBits, 7)
        assert.equal(value(f.state()), 0)
        f.quit()
        const length = Object.keys(f.state().entrust.records).length
        f.finish(1)
        assert.equal(Object.keys(f.state().entrust.records).length, length)
        assert.equal(f.state().entrust.records[1].entrust_star, 3)
        assert.equal(value(f.state()), 1)
        f.call('EndDungeonScene', { result: 3 })
        assert.equal(f.state().achievements.entries[5050018].value, 1)
        f.quit()
        f.finish(1)
        f.call('EndDungeonScene', { result: 3 })
        assert.equal(value(f.state()), 1)
        f.quit()
        f.finish(2)
        f.call('EndDungeonScene', { result: 3 })
        assert.equal(value(f.state()), 2)
    } finally {
        f.close()
    }
})

test('real final-clear transaction,9902 reward and reopened history are atomic at the ten-stage boundary', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'entrust-star-progress-'))
    const file = path.join(directory, 'state.sqlite')
    let f
    try {
        f = entrustProgressFixture('entrust-star-transaction', file)
        f.edit((s) => {
            // Nine valid historical records plus one actual battle below;
            // this verifies aggregation, not ten newly completed battles.
            s.entrust ??= { records: {}, starRewards: {}, nextInstanceId: 1 }
            for (const row of tables
                .get('dungeon_entrust')
                .filter((r) => r.id !== 1)
                .slice(0, 9))
                s.entrust.records[row.id] = recorded(row.id)
        })
        f.call('ActivityGet')
        assert.equal(f.state().achievements.entries[5050018].value, 9)
        f.enter(1)
        while (
            catalog.stages(1).find((r) => r.index === f.state().entrust.run.stage_index).index !==
            catalog.stages(1).at(-2).index
        )
            f.killWave()
        const before = f.state()
        const original = f.protocol.encode
        const sync = f.protocol.byName.get('CSProtoEntrustInfoSync').rsp
        f.protocol.encode = function (name, ...args) {
            if (name === sync) throw Error('entrust-star-final-sync')
            return original.call(this, name, ...args)
        }
        assert.throws(() => f.killWave(), /entrust-star-final-sync/)
        assert.deepEqual(f.state(), before)
        f.protocol.encode = original
        f.killWave()
        assert.equal(f.state().entrust.records[1].entrust_star, 3)
        // BattleInfoReduce deliberately defers full achievement observation.
        assert.equal(f.state().achievements.entries[5050018].value, 9)
        f.call('EndDungeonScene', { result: 3 })
        assert.equal(f.state().achievements.entries[5050018].value, 10)
        assert(f.state().achievements.entries[5050018].finishTime > 0)
        const ready = f.state()
        const reply = f.protocol.byName.get('CSProtoAchievementReward').rsp
        f.protocol.encode = function (name, ...args) {
            if (name === reply) throw Error('entrust-star-reward-ack')
            return original.call(this, name, ...args)
        }
        assert.throws(() => f.call('AchievementReward', { u32: 5050018 }), /entrust-star-reward-ack/)
        assert.deepEqual(f.state(), ready)
        f.protocol.encode = original
        f.call('AchievementReward', { u32: 5050018 })
        assert.equal(f.state().achievements.entries[5050018].claimed, true)
        f.close()
        f = undefined
        f = entrustProgressFixture('entrust-star-transaction', file)
        assert.equal(value(f.state()), 10)
        assert.equal(f.state().achievements.entries[5050018].claimed, true)
        const again = f.call('AchievementReward', { u32: 5050018 }).find((p) => p.id === 9902)
        assert.deepEqual(f.protocol.decode(reply, again.payload).rewards, [])
        // Thirty-record fixture only verifies the second complete family leaf.
        f.edit((s) => {
            s.entrust.records = Object.fromEntries(
                tables
                    .get('dungeon_entrust')
                    .slice(0, 30)
                    .map((r) => [r.id, recorded(r.id)]),
            )
        })
        f.call('ActivityGet')
        assert.equal(f.state().achievements.entries[5050019].value, 30)
        assert(f.state().achievements.entries[5050019].finishTime > 0)
    } finally {
        f?.close()
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()))
        assert(path.basename(directory).startsWith('entrust-star-progress-'))
        fs.rmSync(directory, { recursive: true, force: true })
    }
})
