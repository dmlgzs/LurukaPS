import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { permanentFixture } from './growup-permanent-fixture.js'
import { permanentModel } from '../src/growup-permanent.js'
import { ErrorCode } from '../src/error-codes.js'

test('source initialization sends distinct empty permanent caches and compiles all72 rows without unlock-all or paid endpoint', () => {
    const f = permanentFixture('permanent-empty')
    try {
        const packets = f.call('ActivityGet'),
            roster = f.decode(packets, 'CSProtoSyncGrowupExcultivationAssistCharData'),
            levels = f.decode(packets, 'CSProtoSyncGrowupExcultivationData')
        assert.deepEqual(roster.excultivation_assist_chars, [])
        assert.equal(levels.data[0].datas.length, 18)
        assert(levels.data[0].datas.every((x) => x.level === 1))
        const model = permanentModel(f.system, 60001)
        assert.equal(
            [...model.groups.values()].reduce((n, g) => n + g.rows.size, 0),
            72,
        )
        assert.equal(f.game.handlers.has(10421), false)
        assert.equal(f.game.handlers.has(10426), false)
        assert.throws(
            () => f.call('ActivityGrowUpExcultivationReq', { activity_id: 60001, type: 1 }),
            (e) => e.code === ErrorCode.InvalidProtoID,
        )
        f.start()
        assert.deepEqual(f.state().activities[60001].growupPermanent.unlocked, [])
        assert(f.g().assist_chars.some((x) => x.assist_char_id === 100))
    } finally {
        f.store.close()
    }
})

test('actual travel companion remains local until real three-examination ending; a later lower-score ending registers its actual new partner despite best snapshot staying old', () => {
    const f = permanentFixture('permanent-earned')
    try {
        f.unlock()
        f.start()
        const first = f.travelJoin()
        assert.deepEqual(f.state().activities[60001].growupPermanent.unlocked, [])
        const packets = f.complete(1000),
            firstEnding = f.g().end_data.complete_end[0],
            firstScore = BigInt(firstEnding.top_rating)
        assert(f.state().activities[60001].growupPermanent.unlocked.includes(first))
        assert(f.state().activities[60001].growupPermanent.unlocked.includes(100))
        assert(
            f
                .decode(packets, 'CSProtoSyncGrowupExcultivationAssistCharData')
                .excultivation_assist_chars.includes(first),
        )
        f.call('ActivityGrowUpResetReq', { activity_id: 60001 })
        f.start()
        const second = f.travelJoin([first])
        assert.notEqual(second, first)
        f.complete(100)
        const ledger = f.state().activities[60001].growupPermanent
        assert(ledger.unlocked.includes(second))
        assert.equal(Object.keys(ledger.endings).length, 2)
        assert.equal(BigInt(f.g().end_data.complete_end[0].top_rating), firstScore)
        assert(!f.g().end_data.complete_end[0].chrs.some((x) => x.assist_char_id === second))
    } finally {
        f.store.close()
    }
})

test('source publication and SQL failures preserve original pending and full state; reentry restores only successful permanent roster', () => {
    const parent = path.resolve(os.tmpdir()),
        dir = fs.mkdtempSync(path.join(parent, 'growup-permanent-source-')),
        file = path.join(dir, 'state.sqlite')
    let f = permanentFixture('permanent-source-atomic', file)
    try {
        f.unlock()
        f.start()
        f.examination(1)
        f.examination(2)
        f.examination(3, { submit: false })
        const before = f.state(),
            pending = f.store.pending.get(f.session.id),
            disk = f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
            encode = f.protocol.encode.bind(f.protocol),
            request = { activity_id: 60001, trial_id: 301 }
        for (const type of ['cs.SyncGrowupExcultivationAssistCharData', 'cs.SyncGrowupExcultivationData']) {
            f.protocol.encode = (name, value) => {
                if (name === type) throw Error('permanent-source-codec')
                return encode(name, value)
            }
            assert.throws(() => f.call('CultTrialSwitchStep', request), /permanent-source-codec/)
            assert.deepEqual(f.state(), before)
            assert.strictEqual(f.store.pending.get(f.session.id), pending)
            assert.deepEqual(
                f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
                disk,
            )
            f.protocol.encode = encode
        }
        f.store.db.exec(
            "CREATE TRIGGER permanent_source_abort BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'permanent-source-sql'); END",
        )
        assert.throws(() => f.call('CultTrialSwitchStep', request), /permanent-source-sql/)
        assert.deepEqual(f.state(), before)
        assert.strictEqual(f.store.pending.get(f.session.id), pending)
        f.store.db.exec('DROP TRIGGER permanent_source_abort')
        f.call('CultTrialSwitchStep', request)
        const ledger = f.state().activities[60001].growupPermanent
        assert.equal(Object.keys(ledger.endings).length, 1)
        f.call('CultTrialSwitchStep', request)
        assert.deepEqual(f.state().activities[60001].growupPermanent, ledger)
        f.store.close()
        f = permanentFixture('permanent-source-atomic', file, true)
        assert.deepEqual(f.state().activities[60001].growupPermanent, ledger)
        assert(
            f
                .decode(f.call('ActivityGet'), 'CSProtoSyncGrowupExcultivationAssistCharData')
                .excultivation_assist_chars.includes(100),
        )
    } finally {
        f.store.close()
        const target = path.resolve(dir)
        assert.equal(path.dirname(target), parent)
        assert(path.basename(target).startsWith('growup-permanent-source-'))
        fs.rmSync(target, { recursive: true, force: true })
    }
})

test('legal actual sweep completion shares the same source, preserves history and currency, and cannot register twice', () => {
    const f = permanentFixture('permanent-sweep')
    try {
        f.unlock()
        f.start()
        f.complete(1000)
        const beforeHistory = structuredClone(f.state().activities[60001].growupArchive.trails)
        f.call('ActivityGrowUpResetReq', { activity_id: 60001 })
        f.start()
        const companion = f.travelJoin()
        for (let phase = 1; phase <= 3; phase++) {
            f.atTrial(phase, 1000)
            f.call('SweepCultTrial', { activity_id: 60001, trial_id: [101, 201, 301][phase - 1] })
        }
        const ledger = f.state().activities[60001].growupPermanent
        assert(ledger.unlocked.includes(companion))
        assert.equal(Object.values(ledger.endings).filter((x) => x.source === 'sweep-completion').length, 1)
        const saved = structuredClone(ledger)
        f.call('SweepCultTrial', { activity_id: 60001, trial_id: 301 })
        assert.deepEqual(f.state().activities[60001].growupPermanent, saved)
        assert.deepEqual(f.state().activities[60001].growupArchive.trails, beforeHistory)
    } finally {
        f.store.close()
    }
})
