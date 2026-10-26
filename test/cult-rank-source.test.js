import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { rankFixture } from './cult-rank-fixture.js'
import { cultRankLedger, cultRankSnapshot } from '../src/cult-rank-progress.js'
import { ErrorCode } from '../src/error-codes.js'

test('ranking projection distinguishes missing facts from SQL null/scalars and retains current-draft precedence without flushing pending', () => {
    const f = rankFixture('rank-source-shapes')
    try {
        const peer = f.add('rank-source-shapes-peer')
        for (const value of [null, 'broken', 7, [], { version: 1, periods: null }]) {
            f.store.transact(peer.session.id, 0, (s) => {
                s.cultRankProgress = value
            })
            assert.throws(
                () => f.store.cultRankSnapshot((x) => cultRankLedger(x), { id: f.session.id, state: f.state() }),
                (e) => e.code === ErrorCode.GameConfig,
            )
        }
        f.store.transact(peer.session.id, 0, (s) => {
            delete s.cultRankProgress
        })
        const draft = f.state()
        draft.cultRankProgress = null
        assert.throws(
            () => f.store.cultRankSnapshot((x) => cultRankLedger(x), { id: f.session.id, state: draft }),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.equal(f.store.cultRankSnapshot((x) => cultRankLedger(x), { id: f.session.id, state: f.state() }).size, 0)
    } finally {
        f.store.close()
    }
})

test('rank source records only new true archive settlements; result4, zero, deadline and repeated reports preserve own score and ordinary growth', () => {
    const f = rankFixture('rank-source')
    try {
        f.prepare()
        f.enter()
        assert.equal(f.state().cultRankProgress, undefined)
        f.call('EndDungeonScene', { result: 4 })
        const zero = f.state(),
            key = Object.keys(zero.cultRankProgress.periods)[0]
        assert.equal(zero.cultRankProgress.periods[key].best_score, '0')
        assert.equal(cultRankSnapshot(f.store, f.tables, zero, f.session.id, 60001, 1800000000), null)
        f.call('EndDungeonScene', { result: 4 })
        assert.equal(f.state().cultRankRevision, 1)
        f.call('ReEnterCultTrial', { activity_id: 60001, trial_id: 306, archive_id: 1 })
        f.call('MultiCampaignPlayerLoaded')
        f.kill()
        const actual = f.state().cultTrial.score
        f.game.clock = () => 1800000301
        f.call('MultiCampaignPlayerLoaded')
        const s = f.state()
        assert.equal(s.cultRankProgress.periods[key].best_score, String(actual))
        assert.equal(s.cultRankRevision, 2)
        assert.equal(s.activities[60001].growupArchive.endless_max_score, String(actual))
        f.call('MultiCampaignPlayerLoadFinish')
        assert.equal(f.state().cultRankRevision, 2)
        f.store.transact(f.session.id, 0, (s) => {
            delete s.nextCultTrialInstanceId
        })
        f.call('ReEnterCultTrial', { activity_id: 60001, trial_id: 306, archive_id: 1 })
        assert(f.state().cultTrial.instance_id > s.cultRankProgress.periods[key].last_instance)
    } finally {
        f.store.close()
    }
})

test('source has no retrospective participation from old score or old unfinished login run; genuine new run persists last death immediately and two-account snapshots do not flush unrelated pending', () => {
    const f = rankFixture('rank-source-old')
    try {
        f.prepare()
        f.enter()
        f.kill()
        f.store.transact(f.session.id, 0, (s) => {
            delete s.cultTrial.rank_acceptance
            s.activities[60001].growupArchive.endless_max_score = '999999'
        })
        f.game.clock = () => 1800000301
        delete f.session.entered
        f.call('EnterGame', { open_id: 'rank-source-old', reconnect: true })
        assert.equal(f.state().cultRankProgress, undefined)
        assert.equal(f.state().activities[60001].growupArchive.endless_max_score, '999999')
        f.game.clock = () => 1800000400
        f.call('ReEnterCultTrial', { activity_id: 60001, trial_id: 306, archive_id: 1 })
        f.call('MultiCampaignPlayerLoaded')
        for (let i = 0; i < 40; i++) f.kill()
        const s = f.state(),
            sql = JSON.parse(f.store.db.prepare('SELECT state FROM players WHERE account_id=?').get(f.session.id).state)
        assert.equal(s.cultRankRevision, 1)
        assert.equal(sql.cultRankRevision, 1)
        assert.equal(f.store.pending.has(f.session.id), false)
        const peer = f.add('rank-source-peer')
        f.prepare(peer)
        f.finish(peer, 1)
        const before = f.store.db
            .prepare('SELECT revision FROM players WHERE account_id=?')
            .get(peer.session.id).revision
        f.store.transact(
            peer.session.id,
            0,
            (s) => {
                s.rankProbePending = true
            },
            { defer: true },
        )
        const pending = f.store.pending.get(peer.session.id)
        const snap = cultRankSnapshot(f.store, f.tables, s, f.session.id, 60001, 1800000400)
        assert(snap.ranked)
        assert.equal(snap.count, 1)
        assert.strictEqual(f.store.pending.get(peer.session.id), pending)
        assert.equal(
            f.store.db.prepare('SELECT revision FROM players WHERE account_id=?').get(peer.session.id).revision,
            before,
        )
        const all = f.store.cultRankSnapshot((value) => cultRankLedger(value), { id: f.session.id, state: s })
        assert.equal(all.size, 2)
    } finally {
        f.store.close()
    }
})

test('rank source deadline and primary codec/SQLite failures rollback new fact, archive score and original pending; reopening preserves only real successful result', () => {
    const parent = path.resolve(os.tmpdir()),
        dir = fs.mkdtempSync(path.join(parent, 'cult-rank-source-')),
        file = path.join(dir, 'state.sqlite')
    let f = rankFixture('rank-source-atomic', file)
    try {
        f.prepare()
        f.enter()
        f.kill()
        const before = f.state(),
            pending = f.store.pending.get(f.session.id)
        const encode = f.protocol.encode.bind(f.protocol)
        f.protocol.encode = (type, value) => {
            if (type === 'cs.SyncArchiveGrowupData') throw Error('rank-source-codec')
            return encode(type, value)
        }
        assert.throws(() => f.call('EndDungeonScene', { result: 4 }), /rank-source-codec/)
        assert.deepEqual(f.state(), before)
        assert.strictEqual(f.store.pending.get(f.session.id), pending)
        f.protocol.encode = encode
        f.store.db.exec(
            "CREATE TRIGGER rank_source_abort BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'rank-source-sql'); END",
        )
        assert.throws(() => f.call('EndDungeonScene', { result: 4 }), /rank-source-sql/)
        assert.deepEqual(f.state(), before)
        assert.strictEqual(f.store.pending.get(f.session.id), pending)
        f.store.db.exec('DROP TRIGGER rank_source_abort')
        f.call('EndDungeonScene', { result: 4 })
        const accepted = f.state().cultRankProgress
        assert.equal(f.state().cultRankRevision, 1)
        f.store.close()
        f = rankFixture('rank-source-atomic', file, true)
        assert.deepEqual(f.state().cultRankProgress, accepted)
        f.call('MultiCampaignPlayerLoaded')
        assert.equal(f.state().cultRankRevision, 1)
        assert.throws(
            () => cultRankLedger(null),
            (e) => e.code === ErrorCode.GameConfig,
        )
    } finally {
        f.store.close()
        const target = path.resolve(dir)
        assert.equal(path.dirname(target), parent)
        assert(path.basename(target).startsWith('cult-rank-source-'))
        fs.rmSync(target, { recursive: true, force: true })
    }
})
