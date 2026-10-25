import test from 'node:test'
import assert from 'node:assert/strict'
import { entrustChallengeGoals } from '../src/entrust-challenge-goals.js'
import { tables, catalog, entrustProgressFixture } from './entrust-star-progress-fixture.js'
import { ErrorCode } from '../src/error-codes.js'
import { achievementCatalogue } from '../src/achievements.js'

test('normal commission source fallback covers only explicit zero groups and preserves all27 existing scene goal lists', () => {
    const fallback = []
    for (const row of tables.get('dungeon_entrust')) {
        const { scene, dungeon } = catalog.get(row.id)
        const prior = tables
            .get('common_challenge')
            .filter((r) => r.group === scene.challengeGroup && r.type === 1)
            .sort((a, b) => a.id - b.id)
        const goals = entrustChallengeGoals(tables, { entrust_id: row.id }, scene, dungeon)
        if (scene.challengeGroup === 0) {
            fallback.push(row.id)
            assert.deepEqual(
                goals.map((r) => r.challengeCondition),
                dungeon.challenge.split('|'),
            )
        } else assert.deepEqual(goals, prior)
    }
    assert.deepEqual(fallback, [23, 24, 25, 27, 29])
    const { scene, dungeon } = catalog.get(23)
    for (const kind of ['material', 'weekly', 'repeat'])
        assert.deepEqual(entrustChallengeGoals(tables, { entrust_id: 23, kind }, scene, dungeon), [])
    assert.throws(
        () => entrustChallengeGoals(tables, { entrust_id: 23 }, { ...scene, challengeGroup: 999999 }, dungeon),
        (e) => e.code === ErrorCode.GameConfig,
    )
    assert.throws(
        () => entrustChallengeGoals(tables, { entrust_id: 23 }, scene, { ...dungeon, challenge: '' }),
        (e) => e.code === ErrorCode.GameConfig,
    )
    assert.throws(
        () => entrustChallengeGoals(tables, { entrust_id: 23 }, scene, { ...dungeon, challenge: '99999#1' }),
        (e) => e.code === ErrorCode.FunctionClosed,
    )
    assert.throws(
        () => entrustChallengeGoals(tables, { entrust_id: 23 }, scene, { ...dungeon, challenge: '60007#0' }),
        (e) => e.code === ErrorCode.GameConfig,
    )
})

test('all32 main commissions can earn three stars through real entry,configured waves,battle reports and settlement', () => {
    const f = entrustProgressFixture('entrust-star-all-real')
    try {
        let completed = 0
        for (const row of tables.get('dungeon_entrust')) {
            f.finish(row.id)
            assert.equal(f.state().entrust.records[row.id].entrust_star, 3, `Commission${row.id}`)
            assert.equal(f.state().entrust.run.star_mask, 7)
            f.call('EndDungeonScene', { result: 3 })
            completed++
            assert.equal(Object.keys(f.state().entrust.records).length, completed)
            f.quit()
        }
        assert.equal(completed, 32)
        // Consumers may be absent when running this file after producer-only
        // application; records above alone prove all32 actual settlements.
        if (achievementCatalogue(tables).rules.get(5050019).supported) {
            assert.equal(f.state().achievements.entries[5050018].value, 10)
            assert.equal(f.state().achievements.entries[5050019].value, 30)
            assert(f.state().achievements.entries[5050019].finishTime > 0)
        }
    } finally {
        f.close()
    }
})

test('affected commission final10705 sync failure rolls back combat and stars before a successful9507 confirmation', () => {
    const f = entrustProgressFixture('entrust-source-final-codec')
    const encode = f.protocol.encode
    try {
        f.edit((s) => {
            s.entrust ??= { records: {}, starRewards: {}, nextInstanceId: 1 }
            // Prerequisite one-star records unlock the affected route only;
            // none of them earns the three-star condition under review.
            for (const row of tables.get('dungeon_entrust').filter((r) => r.id < 23))
                s.entrust.records[row.id] = {
                    entrust_id: row.id,
                    group_id: row.groupId,
                    entrust_star: 1,
                    success_time: '1',
                }
        })
        f.enter(23)
        const final = catalog.stages(23).at(-2).index
        while (f.state().entrust.run.stage_index !== final) f.killWave()
        const before = f.state()
        const sync = f.protocol.byName.get('CSProtoEntrustInfoSync').rsp
        f.protocol.encode = function (name, ...args) {
            if (name === sync) throw Error('entrust-source-10705-sync')
            return encode.call(this, name, ...args)
        }
        assert.throws(() => f.killWave(), /entrust-source-10705-sync/)
        assert.deepEqual(f.state(), before)
        f.protocol.encode = encode
        f.killWave()
        assert.equal(f.state().entrust.records[23].entrust_star, 3)
        const confirmed = f.state()
        const response = f.protocol.byName.get('CSProtoEndDungeonScene').rsp
        f.protocol.encode = function (name, ...args) {
            if (name === response) throw Error('entrust-source-9507-ack')
            return encode.call(this, name, ...args)
        }
        assert.throws(() => f.call('EndDungeonScene', { result: 3 }), /entrust-source-9507-ack/)
        assert.deepEqual(f.state(), confirmed)
        f.protocol.encode = encode
        f.call('EndDungeonScene', { result: 3 })
        assert.equal(f.state().entrust.records[23].entrust_star, 3)
    } finally {
        f.protocol.encode = encode
        f.close()
    }
})
