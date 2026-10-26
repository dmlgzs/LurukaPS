import test from 'node:test'
import assert from 'node:assert/strict'
import { rankFixture } from './cult-rank-fixture.js'
import { cultRankSnapshot } from '../src/cult-rank-progress.js'
import { ErrorCode } from '../src/error-codes.js'

const request = { rank_key: { typ: 1, activity_id: 60001 } }
const query = (f, actor = f) => {
    const packets = actor.call('GetRankDetail', request)
    const value = f.decode(packets, 'CSProtoGetRankDetailNtf')
    assert(!packets.some((p) => p.id === 11860), '11860 request-only protocol does not invent a response')
    return value
}

test('11860 rejects missing/legacy/zero/unranked participation without sending false zero; selected mode, parent and config are explicit', () => {
    const f = rankFixture('cult-rank-empty')
    try {
        assert.throws(
            () => query(f),
            (e) => e.code === ErrorCode.ActivityDataNone,
        )
        f.store.transact(f.session.id, 0, (s) => {
            s.activities[60001].growupArchive = {
                version: 1,
                archive: [],
                trails: [],
                endless_max_score: '999999',
                endless_max_wave: 40,
                rank_permyriad_max: 1,
            }
        })
        assert.throws(
            () => query(f),
            (e) => e.code === ErrorCode.ActivityDataNone,
        )
        f.prepare()
        f.enter()
        f.call('EndDungeonScene', { result: 4 })
        assert.throws(
            () => query(f),
            (e) => e.code === ErrorCode.ActivityDataNone,
        )
        assert.throws(
            () => f.call('GetRankDetail', {}),
            (e) => e.code === ErrorCode.ActivityGrowUpInvalidParam,
        )
        assert.throws(
            () => f.call('GetRankDetail', { rank_key: { typ: 2, activity_id: 60001 } }),
            (e) => e.code === ErrorCode.FunctionClosed,
        )
        assert.throws(
            () => f.call('GetRankDetail', { rank_key: { typ: 1, activity_id: 60001, conf_id: 1 } }),
            (e) => e.code === ErrorCode.ActivityGrowUpInvalidParam,
        )
        assert.throws(
            () => f.call('GetRankDetail', { rank_key: { typ: 1, activity_id: 99999 } }),
            (e) => e.code === ErrorCode.NoActivityConf,
        )
        f.game.clock = () => 2000000000
        assert.throws(
            () => query(f),
            (e) => e.code === ErrorCode.ActivityNotOpen,
        )
    } finally {
        f.store.close()
    }
})

test('11861 uses actual two-account battles, competition ties and current population; later higher participant changes P and G without rewriting facts', () => {
    const f = rankFixture('cult-rank-tie')
    try {
        f.prepare()
        f.finish(f, 40)
        const single = query(f),
            own = structuredClone(f.state().cultRankProgress)
        assert.equal(single.rank, '1')
        assert.equal(single.rank_size, '1')
        assert.equal(single.permyriad, '10000')
        assert.equal(
            cultRankSnapshot(f.store, f.tables, f.state(), f.session.id, 60001, 1800000000).qualification,
            2000,
        )
        const peer = f.add('cult-rank-tie-peer')
        f.prepare(peer)
        f.finish(peer, 40)
        const tied = query(f),
            tiedPeer = query(f, peer)
        assert.equal(tied.rank, '1')
        assert.equal(tiedPeer.rank, '1')
        assert.equal(tied.rank_size, '2')
        assert.equal(tied.permyriad, '5000')
        const high = f.add('cult-rank-higher')
        f.prepare(high)
        // Legal archived actor attributes are prerequisites, not injected score or participation.
        f.store.transact(high.session.id, 0, (s) => {
            s.activities[60001].growupArchive.archive[0].growup_train_attr.forEach((x) => {
                x.attr_value = 2000
            })
        })
        f.finish(high, 40)
        const lower = query(f),
            best = query(f, high)
        assert.equal(lower.rank, '2')
        assert.equal(lower.rank_size, '3')
        assert.equal(lower.permyriad, '6667')
        assert.equal(best.rank, '1')
        assert.equal(best.permyriad, '3334')
        assert.deepEqual(f.state().cultRankProgress, own)
        assert.equal(
            f.game.activities.condition('80008|60001|2000', f.state(), 60001),
            0,
            'query stage does not enable reward consumer',
        )
        f.store.transact(
            f.session.id,
            0,
            (s) => {
                s.rankReadOnlyPending = true
            },
            { defer: true },
        )
        const before = f.state(),
            pending = f.store.pending.get(f.session.id),
            encode = f.protocol.encode.bind(f.protocol),
            changesAtRead = f.store.db.prepare('SELECT total_changes() AS n').get().n,
            diskAtRead = f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id)
        assert.equal(query(f).permyriad, '6667')
        assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n, changesAtRead)
        assert.strictEqual(f.store.pending.get(f.session.id), pending)
        assert.deepEqual(f.state(), before)
        assert.deepEqual(
            f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
            diskAtRead,
        )
        f.protocol.encode = (type, value) => {
            if (type === 'cs.GetRankDetailRsp') throw Error('rank-query-codec')
            return encode(type, value)
        }
        assert.throws(() => query(f), /rank-query-codec/)
        assert.deepEqual(f.state(), before)
        assert.strictEqual(f.store.pending.get(f.session.id), pending)
        assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n, changesAtRead)
        assert.deepEqual(
            f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
            diskAtRead,
        )
        f.protocol.encode = encode
        f.store.db.exec(
            "CREATE TRIGGER rank_query_abort BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'rank-query-sql'); END",
        )
        const changesBefore = f.store.db.prepare('SELECT total_changes() AS n').get().n
        assert.equal(query(f).permyriad, '6667', 'read-only query does not hit UPDATE trigger')
        assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n, changesBefore)
        assert.deepEqual(f.state(), before)
        assert.strictEqual(f.store.pending.get(f.session.id), pending)
        f.store.db.exec('DROP TRIGGER rank_query_abort')
        assert.equal(query(f).permyriad, '6667')
    } finally {
        f.store.close()
    }
})

test('pure rank interpolation uses exact permyriad boundaries and Int64 without rounded UI qualification; malformed trusted facts fail', () => {
    const f = rankFixture('cult-rank-math')
    try {
        f.prepare()
        f.finish(f, 1)
        const saved = f.state(),
            key = Object.keys(saved.cultRankProgress.periods)[0]
        for (const [value, expected] of [
            [7999, null],
            [8000, 5000],
            [11999, 3001],
            [12000, 3000],
            [15999, 2501],
            [16000, 2500],
            [19999, 2001],
        ]) {
            const s = structuredClone(saved),
                row = s.cultRankProgress.periods[key]
            row.best_score = row.last_score = String(value)
            assert.equal(
                cultRankSnapshot(f.store, f.tables, s, f.session.id, 60001, 1800000000)?.qualification ?? null,
                expected,
            )
        }
        const max = structuredClone(saved)
        max.cultRankProgress.periods[key].best_score = max.cultRankProgress.periods[key].last_score =
            '9223372036854775807'
        assert.equal(cultRankSnapshot(f.store, f.tables, max, f.session.id, 60001, 1800000000).permyriad, 10000)
        max.cultRankProgress.periods[key].best_score = '9223372036854775808'
        assert.throws(
            () => cultRankSnapshot(f.store, f.tables, max, f.session.id, 60001, 1800000000),
            (e) => e.code === ErrorCode.GameConfig,
        )
    } finally {
        f.store.close()
    }
})
