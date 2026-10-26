import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { permanentFixture } from './growup-permanent-fixture.js'
import { grantRewards } from '../src/rewards.js'
import { ErrorCode } from '../src/error-codes.js'

const currency = (f) => f.state().player.attr_infos.attrs.find((a) => a.attr_id === 1002)?.attr_val ?? '0'
const funding = (f, n) =>
    f.store.transact(f.session.id, 0, (s) => grantRewards(f.tables, s, [{ itemtype: 10, itemid: 1002, itemnum: n }]))
const frame = (f, seq, type = 1) => ({
    id: 10420,
    seq,
    payload: f.protocol.encode('cs.CSActivityGrowUpExcultivationReq', { activity_id: 60001, type }),
})

test('actual earned assistant upgrades current-row cost with sequence dedup, distinct same-type requests charge separately and only next new cycle uses replacement effects', () => {
    const f = permanentFixture('permanent-upgrade-real')
    try {
        assert.throws(
            () => f.call('ActivityGrowUpExcultivationReq', { activity_id: 60001, type: 1 }),
            (e) => e.code === ErrorCode.ActivityGrowUpExcultivationCondLimit,
        )
        f.unlock()
        f.start()
        const baseBond = f.g().assist_chars.find((a) => a.assist_char_id === 100).bond
        f.complete()
        f.call('ActivityGrowUpResetReq', { activity_id: 60001 })
        f.start()
        const running = structuredClone(f.g()),
            seal = structuredClone(f.state().activities[60001].growupRuntime.initialPerks)
        assert.throws(
            () => f.call('ActivityGrowUpExcultivationReq', { activity_id: 60001, type: 1 }),
            (e) => e.code === ErrorCode.ActivityGrowUpExcultivationCostLimit,
        )
        // Existing generic type10 issuance is a test precondition, not a new natural currency source.
        funding(f, 15)
        const request = frame(f, 60001),
            first = f.game.dispatch(f.session, request)
        assert.equal(currency(f), '10')
        assert.equal(
            f.decode(first, 'CSProtoSyncGrowupExcultivationData').data[0].datas.find((x) => x.type === 1).level,
            2,
        )
        f.game.dispatch(f.session, request)
        assert.equal(currency(f), '10')
        assert.equal(f.state().activities[60001].growupPermanent.levels[1], 2)
        f.game.dispatch(f.session, frame(f, 60002))
        f.game.dispatch(f.session, frame(f, 60003))
        assert.equal(currency(f), '0')
        assert.equal(f.state().activities[60001].growupPermanent.levels[1], 4)
        assert.equal(Object.keys(f.state().activities[60001].growupPermanent.upgrades).length, 3)
        assert.deepEqual(f.g(), running)
        assert.deepEqual(f.state().activities[60001].growupRuntime.initialPerks, seal)
        assert.throws(
            () => f.game.dispatch(f.session, frame(f, 60004)),
            (e) => e.code === ErrorCode.ActivityGrowUpInvalidParam,
        )
        assert.throws(
            () => f.game.dispatch(f.session, frame(f, 60005, 999)),
            (e) => e.code === ErrorCode.ActivityGrowUpInvalidParam,
        )
        f.call('ActivityGrowUpResetReq', { activity_id: 60001 })
        f.start()
        const next = f.state().activities[60001].growupRuntime.initialPerks
        assert.deepEqual(next.attributes, { 101: 5, 102: 5, 103: 5, 104: 5 })
        assert.equal(next.bonds[100], 20)
        assert.equal(f.g().assist_chars.find((a) => a.assist_char_id === 100).bond, baseBond + 20)
        assert.deepEqual(f.g().day_start_snapshot.train_attrs, f.g().growup_train_attr)
        assert.equal(
            f.g().assist_chars.some((a) => a.assist_char_id === 101),
            false,
        )
    } finally {
        f.store.close()
    }
})

test('upgrade10421 and balance-codec plus SQL failures roll back fee, level, receipt and current cycle; successful file reopen keeps paid chain', () => {
    const parent = path.resolve(os.tmpdir()),
        dir = fs.mkdtempSync(path.join(parent, 'growup-permanent-upgrade-')),
        file = path.join(dir, 'state.db')
    let f = permanentFixture('permanent-upgrade-atomic', file)
    try {
        f.unlock()
        f.start()
        f.complete()
        funding(f, 15)
        const before = structuredClone(f.state()),
            pending = f.store.pending.get(f.session.id),
            disk = f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
            encode = f.protocol.encode.bind(f.protocol),
            request = frame(f, 61001)
        for (const type of ['cs.SyncGrowupExcultivationData', 'cs.PlayerData']) {
            f.protocol.encode = (name, value) => {
                if (name === type) throw Error('upgrade-codec')
                return encode(name, value)
            }
            assert.throws(() => f.game.dispatch(f.session, request), /upgrade-codec/)
            assert.deepEqual(f.state(), before)
            assert.strictEqual(f.store.pending.get(f.session.id), pending)
            assert.deepEqual(
                f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
                disk,
            )
            f.protocol.encode = encode
        }
        f.store.db.exec(
            "CREATE TRIGGER upgrade_abort BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'upgrade-sql'); END",
        )
        assert.throws(() => f.game.dispatch(f.session, request), /upgrade-sql/)
        assert.deepEqual(f.state(), before)
        assert.strictEqual(f.store.pending.get(f.session.id), pending)
        f.store.db.exec('DROP TRIGGER upgrade_abort')
        f.game.dispatch(f.session, request)
        assert.equal(currency(f), '10')
        const ledger = structuredClone(f.state().activities[60001].growupPermanent)
        f.game.dispatch(f.session, request)
        assert.equal(currency(f), '10')
        assert.deepEqual(f.state().activities[60001].growupPermanent, ledger)
        f.store.close()
        f = permanentFixture('permanent-upgrade-atomic', file, true)
        assert.equal(currency(f), '10')
        assert.deepEqual(f.state().activities[60001].growupPermanent, ledger)
        const levels = f.decode(f.call('ActivityGet'), 'CSProtoSyncGrowupExcultivationData')
        assert.equal(levels.data[0].datas.find((x) => x.type === 1).level, 2)
        assert(levels.data[0].datas.filter((x) => x.type !== 1).every((x) => x.level === 1))
    } finally {
        f.store.close()
        const target = path.resolve(dir)
        assert.equal(path.dirname(target), parent)
        assert(path.basename(target).startsWith('growup-permanent-upgrade-'))
        fs.rmSync(target, { recursive: true, force: true })
    }
})

test('paid rights never transfer to another account and forged old high levels without a receipt chain do not become free upgrades', () => {
    const f = permanentFixture('permanent-upgrade-integrity'),
        other = permanentFixture('permanent-upgrade-other')
    try {
        f.unlock()
        f.start()
        f.complete()
        funding(f, 10)
        f.game.dispatch(f.session, frame(f, 62001))
        funding(other, 10)
        const guide = other.game.activities.rows.find((r) => r.id === 60001).guideTaskId
        assert(guide > 0)
        other.store.transact(other.session.id, 0, (s) => {
            s.taskRecords = s.taskRecords.filter((t) => t.task_id !== guide)
            s.tasks = s.tasks.filter((t) => t.task_id !== guide)
        })
        assert.throws(
            () => other.call('ActivityGrowUpExcultivationReq', { activity_id: 60001, type: 1 }),
            (e) => e.code === ErrorCode.ActivityGrowUpExcultivationCondLimit && /guide task/.test(e.message),
        )
        assert.equal(currency(other), '10')
        f.store.transact(f.session.id, 0, (s) => {
            s.activities[60001].growupPermanent.levels[1] = 4
        })
        const bad = structuredClone(f.state())
        assert.throws(
            () => f.call('ActivityGrowUpExcultivationReq', { activity_id: 60001, type: 1 }),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), bad)
    } finally {
        f.store.close()
        other.store.close()
    }
})
