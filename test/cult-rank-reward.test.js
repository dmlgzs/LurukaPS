import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { rankFixture } from './cult-rank-fixture.js'
import { cultRankOwnValue } from '../src/activity-cult-rank.js'
import { ErrorCode } from '../src/error-codes.js'
const claim = (f, ids) => f.call('ActivityReward', { activity_id: 60001, reward_id_list: ids })
const status = (f) =>
    f
        .decode(f.call('ActivityGet'), 'CSProtoActivitySync')
        .activitys.find((x) => x.id === 60001)
        .rewards.filter((x) => [600010201, 600010202].includes(x.id))

test('actual archive partial score unlocks only top50; mixed lower tier rollback and actual stronger new run unlocks both original drops exactly once', () => {
    const f = rankFixture('rank-reward-real')
    try {
        f.prepare()
        f.store.transact(f.session.id, 0, (s) =>
            s.activities[60001].growupArchive.archive[0].growup_train_attr.forEach((x) => {
                x.attr_value = 0
            }),
        )
        f.enter()
        while (f.state().cultTrial.score < 8000) f.kill()
        assert(f.state().cultTrial.score < 20000)
        f.call('EndDungeonScene', { result: 4 })
        assert.deepEqual(
            status(f).map((x) => x.state),
            [1, 0],
        )
        const before = f.state()
        assert.throws(
            () => claim(f, [600010201, 600010202]),
            (e) => e.code === ErrorCode.ActivityRewardStateError,
        )
        assert.deepEqual(f.state(), before)
        const first = f.decode(claim(f, [600010201]), 'CSProtoActivityReward')
        assert(first.rewards.length)
        const fact = f.state().activities[60001].cultRankClaims[600010201]
        assert(fact.qualification <= 5000 && fact.qualification > 2000)
        assert.equal(fact.rank, undefined)
        f.store.transact(f.session.id, 0, (s) =>
            s.activities[60001].growupArchive.archive[0].growup_train_attr.forEach((x) => {
                x.attr_value = 1000
            }),
        )
        f.call('ReEnterCultTrial', { activity_id: 60001, trial_id: 306, archive_id: 1 })
        f.call('MultiCampaignPlayerLoaded')
        for (let i = 0; i < 40; i++) f.kill()
        assert.deepEqual(
            status(f).map((x) => x.state),
            [2, 1],
        )
        const second = f.decode(claim(f, [600010201, 600010202, 600010202]), 'CSProtoActivityReward')
        assert(second.rewards.length)
        assert.equal(f.state().activities[60001].cultRankClaims[600010202].qualification, 2000)
        assert.equal(f.state().activities[60001].cultRankClaims[600010202].permyriad, 10000)
        assert.deepEqual(f.decode(claim(f, [600010201, 600010202]), 'CSProtoActivityReward').rewards, [])
        assert.deepEqual(
            status(f).map((x) => x.state),
            [2, 2],
        )
        assert.equal(f.state().cultRankRevision, 2)
    } finally {
        f.store.close()
    }
})

test('rank reward and final death ActivitySync failures rollback roots, pending and SQLite; restart keeps received receipts without new participation', () => {
    const parent = path.resolve(os.tmpdir()),
        dir = fs.mkdtempSync(path.join(parent, 'cult-rank-reward-')),
        file = path.join(dir, 'state.sqlite')
    let f = rankFixture('rank-reward-atomic', file)
    try {
        f.prepare()
        f.enter()
        for (let i = 0; i < 39; i++) f.kill()
        let before = f.state(),
            pending = f.store.pending.get(f.session.id),
            encode = f.protocol.encode.bind(f.protocol)
        f.protocol.encode = (type, value) => {
            if (type === 'cs.ActivitySync') throw Error('rank-death-activity')
            return encode(type, value)
        }
        assert.throws(() => f.kill(), /rank-death-activity/)
        assert.deepEqual(f.state(), before)
        assert.strictEqual(f.store.pending.get(f.session.id), pending)
        f.protocol.encode = encode
        f.kill()
        for (const type of ['cs.Rewards', 'cs.ActivitySync']) {
            before = f.state()
            pending = f.store.pending.get(f.session.id)
            const disk = f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id)
            f.protocol.encode = (name, value) => {
                if (name === type) throw Error('rank-reward-codec')
                return encode(name, value)
            }
            assert.throws(() => claim(f, [600010201, 600010202]), /rank-reward-codec/)
            assert.deepEqual(f.state(), before)
            assert.strictEqual(f.store.pending.get(f.session.id), pending)
            assert.deepEqual(
                f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
                disk,
            )
            f.protocol.encode = encode
        }
        before = f.state()
        f.store.db.exec(
            "CREATE TRIGGER rank_reward_abort BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'rank-reward-sql'); END",
        )
        assert.throws(() => claim(f, [600010201, 600010202]), /rank-reward-sql/)
        assert.deepEqual(f.state(), before)
        f.store.db.exec('DROP TRIGGER rank_reward_abort')
        assert(f.decode(claim(f, [600010201, 600010202]), 'CSProtoActivityReward').rewards.length)
        const facts = f.state().cultRankProgress,
            receipts = f.state().activities[60001].cultRankClaims
        f.store.close()
        f = rankFixture('rank-reward-atomic', file, true)
        assert.deepEqual(f.state().cultRankProgress, facts)
        assert.deepEqual(f.state().activities[60001].cultRankClaims, receipts)
        assert.deepEqual(f.decode(claim(f, [600010201, 600010202]), 'CSProtoActivityReward').rewards, [])
        assert.deepEqual(
            status(f).map((x) => x.state),
            [2, 2],
        )
    } finally {
        f.store.close()
        const target = path.resolve(dir)
        assert.equal(path.dirname(target), parent)
        assert(path.basename(target).startsWith('cult-rank-reward-'))
        fs.rmSync(target, { recursive: true, force: true })
    }
})

test('one request reuses its rank population; other activity claims and pure synchronization do not scan all players or fake exact rank', () => {
    const f = rankFixture('rank-reward-scan')
    try {
        f.prepare()
        f.finish(f, 40)
        let reads = 0
        const project = f.store.cultRankSnapshot.bind(f.store)
        f.store.cultRankSnapshot = (...args) => {
            reads++
            return project(...args)
        }
        status(f)
        assert.equal(reads, 1)
        reads = 0
        f.call('GetRankDetail', { rank_key: { typ: 1, activity_id: 60001 } })
        assert.equal(reads, 1)
        reads = 0
        claim(f, [600010201, 600010202])
        assert.equal(reads, 1)
        reads = 0
        claim(f, [600010201, 600010202])
        assert.equal(reads, 0)
        const normal = f.game.activities.rewards.find(
            (x) =>
                x.groupId === 60001 &&
                String(x.finishCondition).startsWith('80003|') &&
                f.game.activities.condition(x.finishCondition, f.state(), 60001) >= x.para,
        )
        assert(normal)
        reads = 0
        claim(f, [normal.id])
        assert.equal(reads, 0)
        for (const kind of [13123, 81002]) {
            const row = f.game.activities.rewards.find((x) => String(x.finishCondition).startsWith(kind + '|'))
            assert(row)
            reads = 0
            assert.throws(() => f.call('ActivityReward', { activity_id: row.groupId, reward_id_list: [row.id] }))
            assert.equal(reads, 0)
        }
        const own = f.state(),
            tokens = [80008, 60001, 2000]
        assert.equal(cultRankOwnValue(f.tables, own, tokens, 60001, 1800000000), 2000)
        assert.equal(
            cultRankOwnValue(f.tables, own, [80008, 60001, 1000], 60001, 1800000000),
            null,
            'future narrower threshold requires actual population',
        )
        assert.equal(reads, 0)
    } finally {
        f.store.close()
    }
})
