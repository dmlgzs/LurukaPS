import test from 'node:test'
import assert from 'node:assert/strict'
import { permanentFixture } from './growup-permanent-fixture.js'
import { permanentModel } from '../src/growup-permanent.js'
import { ErrorCode } from '../src/error-codes.js'

test('real earned level1 seals bond at new10410 before snapshot, never creates unselected partner, and later real travel join receives budget once', () => {
    const f = permanentFixture('permanent-start-earned')
    try {
        f.unlock()
        f.start()
        const base = f.g().assist_chars.find((a) => a.assist_char_id === 100).bond
        f.complete()
        f.call('ActivityGrowUpResetReq', { activity_id: 60001 })
        const packets = f.start(),
            state = f.state(),
            entry = state.activities[60001],
            g = f.g(),
            seal = structuredClone(entry.growupRuntime.initialPerks)
        assert.equal(g.assist_chars.find((a) => a.assist_char_id === 100).bond, base + 5)
        assert.equal(
            g.assist_chars.some((a) => a.assist_char_id === 101),
            false,
        )
        assert.equal(seal.bonds[101], 5)
        assert.deepEqual(g.day_start_snapshot.train_attrs, g.growup_train_attr)
        assert.equal(Object.hasOwn(g, 'initialPerks'), false)
        const all = f.tables
            .get('game_events_cul_assist')
            .filter((a) => a.systemId === 60001)
            .map((a) => a.assistId)
        assert.equal(f.travelJoin(all.filter((x) => x !== 101)), 101)
        const assistant = f.g().assist_chars.find((a) => a.assist_char_id === 101)
        assert(assistant.bond >= 5)
        const before = assistant.bond
        f.store.transact(f.session.id, 0, (s) => {
            const e = s.activities[60001],
                system = f.system
            system.ensure(e, 60001)
            const effect = f.tables.get('game_events_cul_effect').find(
                (e) =>
                    e.type === 13 &&
                    String(e.param)
                        .split('|')
                        .some((p) => p.startsWith('101#')),
            )
            const points = String(effect.param)
                .split('|')
                .filter((p) => p.startsWith('101#'))
                .reduce((n, p) => n + Number(p.split('#')[1]), 0)
            system.effects(e.growup, 60001, String(effect.Id))
            assert.equal(e.growup.assist_chars.find((a) => a.assist_char_id === 101).bond, before + points)
        })
        assert.equal(
            f.state().activities[60001].growupRuntime.initialPerks.applied_assistants.filter((x) => x === 101).length,
            1,
        )
        assert(packets.length > 0)
    } finally {
        f.store.close()
    }
})

test('unearned extra selection is rejected; old running cycles do not gain a retrospective seal or bond budget', () => {
    const f = permanentFixture('permanent-start-locked')
    try {
        f.unlock()
        f.start()
        f.complete()
        f.call('ActivityGrowUpResetReq', { activity_id: 60001 })
        const opening = f.tables
            .get('game_events_cul_starting')
            .find((r) => r.systemId === 60001 && r.exCharAmonut > 0 && f.system.condition(r.condition, f.g()))
        assert(opening, 'earned ending opens an extra-companion starting scenario')
        const requested = f.tables
            .get('game_events_cul_assist')
            .find(
                (a) =>
                    a.systemId === 60001 &&
                    a.assistId !== 100 &&
                    !String(opening.initialCharacter).split('|').includes(String(a.assistId)) &&
                    !String(opening.lockCharacter).split('|').includes(String(a.assistId)),
            ).assistId
        assert.throws(
            () =>
                f.call('ActivityGrowUpStartSelectReq', {
                    activity_id: 60001,
                    starting_id: opening.startingId,
                    select_assist_char_ids: [requested],
                }),
            (e) => e.code === ErrorCode.ActivityGrowUpExcultivationCondLimit,
        )
        f.start()
        f.store.transact(f.session.id, 0, (s) => {
            delete s.activities[60001].growupRuntime.initialPerks
        })
        const before = structuredClone(f.g().assist_chars)
        f.call('ActivityGet')
        f.start()
        assert.deepEqual(f.g().assist_chars, before)
        assert.equal(f.state().activities[60001].growupRuntime.initialPerks, undefined)
    } finally {
        f.store.close()
    }
})

test('new run allocation reserves legacy history even without counter; codec and SQL start rollback preserve sequence, runtime and permanent state', () => {
    const f = permanentFixture('permanent-start-atomic')
    try {
        f.unlock()
        f.start()
        f.complete()
        const old = BigInt(f.g().guid)
        f.call('ActivityGrowUpResetReq', { activity_id: 60001 })
        f.store.transact(f.session.id, 0, (s) => {
            delete s.activities[60001].nextGrowupGuid
        })
        const before = structuredClone(f.state()),
            pending = f.store.pending.get(f.session.id),
            disk = f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
            encode = f.protocol.encode.bind(f.protocol)
        f.protocol.encode = (name, value) => {
            if (name === 'cs.SyncGrowupTrainAssistCharData') throw Error('start-codec')
            return encode(name, value)
        }
        assert.throws(() => f.start(), /start-codec/)
        assert.deepEqual(f.state(), before)
        assert.strictEqual(f.store.pending.get(f.session.id), pending)
        f.protocol.encode = encode
        f.store.db.exec(
            "CREATE TRIGGER start_abort BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'start-sql'); END",
        )
        assert.throws(() => f.start(), /start-sql/)
        assert.deepEqual(f.state(), before)
        assert.strictEqual(f.store.pending.get(f.session.id), pending)
        assert.deepEqual(
            f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
            disk,
        )
        f.store.db.exec('DROP TRIGGER start_abort')
        f.start()
        assert(BigInt(f.g().guid) > old)
        const snap = structuredClone(f.g()),
            runtime = structuredClone(f.state().activities[60001].growupRuntime)
        f.start()
        assert.deepEqual(f.g(), snap)
        assert.deepEqual(f.state().activities[60001].growupRuntime, runtime)
    } finally {
        f.store.close()
    }
})

test('all18 current highest rows replace lower rows and combine type3 and type13 without cumulative-level arithmetic', () => {
    const f = permanentFixture('permanent-all-effects')
    try {
        const model = permanentModel(f.system, 60001),
            attrs = {},
            bonds = {}
        for (const group of model.groups.values()) {
            const row = group.rows.get(4)
            for (const [k, v] of Object.entries(row.attribute)) attrs[k] = (attrs[k] ?? 0) + v
            for (const [k, v] of Object.entries(row.bond)) bonds[k] = (bonds[k] ?? 0) + v
        }
        assert.deepEqual(attrs, { 101: 40, 102: 20, 103: 20, 104: 20 })
        assert.equal(model.groups.get(1).rows.get(4).bond[100], 20)
        assert.equal(model.groups.get(1).rows.get(4).attribute[101], 5)
        assert(Object.values(bonds).every((v) => Number.isInteger(v) && v >= 0))
    } finally {
        f.store.close()
    }
})
