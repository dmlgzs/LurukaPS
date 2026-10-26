import test from 'node:test'
import assert from 'node:assert/strict'
import { rankFixture } from './cult-rank-fixture.js'
import { cultRankLedger } from '../src/cult-rank-progress.js'
import { ErrorCode } from '../src/error-codes.js'

test('internal SQLite accounts above UInt32 remain readable and an unranked high account cannot poison the leaderboard', () => {
    const f = rankFixture('rank-internal-id')
    try {
        f.prepare()
        f.finish(f, 1)
        f.store.db.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='accounts'").run(4294967296)
        const high = f.store.login('rank-internal-high', () => ({ marker: 'high-account' }))
        assert(high.id > 0xffffffff)
        assert(Number.isSafeInteger(high.id))
        const project = (value) => cultRankLedger(value)
        assert.equal(f.store.cultRankSnapshot(project, { id: f.session.id, state: f.state() }).size, 1)
        assert.equal(f.store.cultRankSnapshot(project, { id: high.id, state: high.state }).size, 1)
        f.store.transact(
            high.id,
            0,
            (s) => {
                s.cultRankProgress = structuredClone(f.state().cultRankProgress)
            },
            { defer: true },
        )
        const pending = f.store.pending.get(high.id)
        assert.equal(f.store.cultRankSnapshot(project, { id: high.id, state: f.store.load(high.id).state }).size, 2)
        assert.strictEqual(f.store.pending.get(high.id), pending)
        assert.throws(
            () => f.store.cultRankSnapshot(project, { id: Number.MAX_SAFE_INTEGER + 1, state: {} }),
            (e) => e.code === ErrorCode.GameConfig,
        )
        // This is Store identity/projection compatibility, not a claim that the uint32 player wire supports high IDs.
    } finally {
        f.store.close()
    }
})

test('actual final wave codec and SQL failure preserve tag chest visibility, all pending roots and disk before exactly one durable settlement', () => {
    const f = rankFixture('rank-source-final-cow')
    try {
        f.prepare()
        f.enter()
        for (let i = 0; i < 39; i++) f.kill()
        const before = f.state(),
            pending = f.store.pending.get(f.session.id),
            raw = f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
            encode = f.protocol.encode.bind(f.protocol)
        f.protocol.encode = (type, value) => {
            if (type === 'cs.SyncArchiveGrowupData') throw Error('rank-last-codec')
            return encode(type, value)
        }
        assert.throws(() => f.kill(), /rank-last-codec/)
        assert.deepEqual(f.state(), before)
        assert.strictEqual(f.store.pending.get(f.session.id), pending)
        assert.deepEqual(
            f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
            raw,
        )
        f.protocol.encode = encode
        f.store.db.exec(
            "CREATE TRIGGER rank_last_abort BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'rank-last-sql'); END",
        )
        assert.throws(() => f.kill(), /rank-last-sql/)
        assert.deepEqual(f.state(), before)
        assert.strictEqual(f.store.pending.get(f.session.id), pending)
        assert.deepEqual(
            f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
            raw,
        )
        f.store.db.exec('DROP TRIGGER rank_last_abort')
        f.kill()
        assert.equal(f.state().cultRankRevision, 1)
        assert.equal(f.store.pending.has(f.session.id), false)
        assert.equal(
            JSON.parse(f.store.db.prepare('SELECT state FROM players WHERE account_id=?').get(f.session.id).state)
                .cultRankRevision,
            1,
        )
    } finally {
        f.store.close()
    }
})
