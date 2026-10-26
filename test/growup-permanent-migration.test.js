import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from './cult-archive-fixture.js'
import { permanentModel, pushPermanent } from '../src/growup-permanent.js'
import { ErrorCode } from '../src/error-codes.js'

// This file uses the existing trusted persisted-result fixture, not a claim of three actual battles.
test('complete legacy ending migrates only its proven party with merged openings and historical score; weak/current/foreign records never unlock partners', () => {
    const f = fixture('permanent-legacy')
    try {
        f.start()
        f.complete()
        f.store.transact(f.session.id, 0, (s) => {
            const e = s.activities[60001],
                record = e.growup.end_data.complete_end[0]
            delete e.growupPermanent
            record.starting_ids = [101, 102]
            record.top_rating = '999999999'
            e.growup.assist_chars = [{ assist_char_id: 101, bond: 500 }]
            const foreign = structuredClone(record)
            foreign.id = 102
            foreign.trails.forEach((t) => {
                t.guid = String((BigInt(f.session.id + 1) << 32n) | 1n)
            })
            e.growup.end_data.complete_end.push(foreign, { id: 103, chrs: [{ assist_char_id: 102, bond: 999 }] })
        })
        const old = structuredClone(f.g().end_data)
        const packets = f.call('ActivityGet'),
            ledger = f.state().activities[60001].growupPermanent
        assert.deepEqual(ledger.unlocked, [100])
        assert.equal(Object.keys(ledger.endings).length, 1)
        assert.equal(Object.values(ledger.endings)[0].source, 'legacy-ending')
        assert.equal(ledger.migration.skipped.length, 2)
        assert.equal(ledger.levels[1], 1)
        assert.deepEqual(f.g().end_data, old)
        assert.deepEqual(
            f.decode(packets, 'CSProtoSyncGrowupExcultivationAssistCharData').excultivation_assist_chars,
            [100],
        )
        f.call('ActivityGet')
        assert.deepEqual(f.state().activities[60001].growupPermanent, ledger)
        f.store.transact(f.session.id, 0, (s) => {
            s.activities[60001].growupPermanent.levels[1] = 4
        })
        const bad = structuredClone(f.state()),
            pending = f.store.pending.get(f.session.id)
        assert.throws(
            () => f.call('ActivityGet'),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), bad)
        assert.strictEqual(f.store.pending.get(f.session.id), pending)
    } finally {
        f.store.close()
    }
})

test('legacy migration codec and SQL failure preserve full state and do not commit a partial roster', () => {
    const f = fixture('permanent-legacy-atomic')
    try {
        f.start()
        f.complete()
        f.store.transact(f.session.id, 0, (s) => {
            delete s.activities[60001].growupPermanent
        })
        const before = structuredClone(f.state()),
            pending = f.store.pending.get(f.session.id),
            disk = f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id)
        const encode = f.protocol.encode.bind(f.protocol)
        f.protocol.encode = (name, value) => {
            if (name === 'cs.SyncGrowupExcultivationAssistCharData') throw Error('legacy-codec')
            return encode(name, value)
        }
        assert.throws(() => f.call('ActivityGet'), /legacy-codec/)
        assert.deepEqual(f.state(), before)
        assert.strictEqual(f.store.pending.get(f.session.id), pending)
        f.protocol.encode = encode
        f.store.db.exec(
            "CREATE TRIGGER legacy_abort BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'legacy-sql'); END",
        )
        assert.throws(() => f.call('ActivityGet'), /legacy-sql/)
        assert.deepEqual(f.state(), before)
        assert.strictEqual(f.store.pending.get(f.session.id), pending)
        assert.deepEqual(
            f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
            disk,
        )
        f.store.db.exec('DROP TRIGGER legacy_abort')
        f.call('ActivityGet')
        assert.deepEqual(f.state().activities[60001].growupPermanent.unlocked, [100])
    } finally {
        f.store.close()
    }
})

test('optional static permanent model skips unsupported future effects, while codec and damaged typed ledger are not caught', () => {
    const f = fixture('permanent-model-boundary')
    try {
        const real = f.game.activities,
            original = real.growup.tables
        const system = {
            config: real.growup.config.bind(real.growup),
            tables: {
                get: (name) =>
                    original.get(name).map((r) => (name === 'game_events_cul_effect' ? { ...r, type: 999 } : r)),
            },
        }
        assert.throws(
            () => permanentModel(system, 60001),
            (e) => e.code === ErrorCode.FunctionClosed,
        )
        const entry = {},
            packets = []
        pushPermanent(
            {
                id: f.session.id,
                now: 1800000000,
                state: {},
                pushBefore: (name, value) => packets.push({ name, value }),
            },
            { rows: real.rows, growup: system, entry: () => entry },
        )
        assert.equal(entry.growupPermanent, undefined)
        assert.equal(
            packets.some((p) => p.name === 'CSProtoSyncGrowupExcultivationAssistCharData'),
            false,
        )
        assert.throws(
            () =>
                pushPermanent(
                    {
                        id: f.session.id,
                        now: 1800000000,
                        state: f.state(),
                        pushBefore: () => {
                            throw Error('not-optional-codec')
                        },
                    },
                    real,
                ),
            /not-optional-codec/,
        )
    } finally {
        f.store.close()
    }
})
