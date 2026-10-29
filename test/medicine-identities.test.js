import test from 'node:test'
import assert from 'node:assert/strict'
import { medicineFixture } from './medicine-fixture.js'
import { ErrorCode } from '../src/error-codes.js'

function prepare(f, value) {
    f.dead()
    f.store.db
        .prepare('INSERT INTO sequences(name,value) VALUES(?,?)')
        .run('personal-world-buff:' + f.session.id, value)
    // Use the real deferred Game path so a failed durable producer must retain
    // both its borrowed pending object and the earlier saved SQLite preimage.
    f.call('BattleInfoReduce', { battle_info: [] })
    const pending = f.store.pending.get(f.session.id)
    assert(pending, 'The rollback test requires an actual deferred Game preimage')
    return {
        state: f.store.load(f.session.id),
        pending,
        sql: f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
        sequences: f.store.db.prepare('SELECT * FROM sequences ORDER BY name').all(),
    }
}
function unchanged(f, before) {
    assert.deepEqual(f.store.load(f.session.id), before.state)
    assert.strictEqual(f.store.pending.get(f.session.id), before.pending)
    assert.strictEqual(f.store.pending.get(f.session.id).state, before.pending.state)
    assert.equal(f.store.load(f.session.id).state.medicine, undefined)
    assert.deepEqual(
        f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
        before.sql,
    )
    assert.deepEqual(f.store.db.prepare('SELECT * FROM sequences ORDER BY name').all(), before.sequences)
}
const request = (f, itemid) => f.call('UseItem', { itemid, num: 1, args: [f.heroes[0]] })

test('both real medicines map exhausted uint32 personal identities to named GameConfig with all player, pending and SQL state rolled back', () => {
    for (const itemid of [2020001, 2020002]) {
        const f = medicineFixture('medicine-identity-exhausted-' + itemid)
        try {
            const before = prepare(f, 0xffffffff)
            assert.throws(
                () => request(f, itemid),
                (error) =>
                    error.code === ErrorCode.GameConfig &&
                    error.message === 'Medicine personal effect identity exhausted',
            )
            unchanged(f, before)
        } finally {
            f.store.close()
        }
    }
})

test('both real medicines preserve an unexpected SQL exception after an actual sequence increment and roll back every changed branch', () => {
    for (const itemid of [2020001, 2020002]) {
        const f = medicineFixture('medicine-identity-sql-fault-' + itemid),
            fault = Object.assign(Error('Controlled medicine identity SQL failure'), { code: 'SQLITE_IOERR_TEST' }),
            original = f.store.nextSequence.bind(f.store)
        try {
            const before = prepare(f, 7)
            let increments = 0
            f.store.nextSequence = (name, max) => {
                const value = original(name, max)
                if (name === 'personal-world-buff:' + f.session.id) {
                    assert.equal(value, 8)
                    increments++
                    throw fault
                }
                return value
            }
            assert.throws(
                () => request(f, itemid),
                (error) => error === fault && error.code === 'SQLITE_IOERR_TEST',
            )
            assert.equal(increments, 1)
            unchanged(f, before)
        } finally {
            f.store.nextSequence = original
            f.store.close()
        }
    }
})
