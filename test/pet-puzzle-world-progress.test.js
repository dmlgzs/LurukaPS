import test from 'node:test'
import assert from 'node:assert/strict'
import { puzzleFixture, puzzlePolicy, puzzleProtocol, puzzleTables } from './pet-puzzle-progress-fixture.js'
import { petPuzzleProgressFacts, petPuzzleContextActor } from '../src/pet-puzzle-progress.js'
import { achievementCatalogue } from '../src/achievements.js'
import { ErrorCode } from '../src/error-codes.js'

test('9133 records only a fresh marked root with owned element context; no release/history/step backfill', () => {
    const f = puzzleFixture('puzzle-world-first')
    try {
        assert.equal(puzzlePolicy.worlds.length, 352)
        assert.equal(puzzlePolicy.playables.length, 33)
        const [entry, missing, invalid] = f.worldEntries()
        f.near(entry)
        const request = f.request(entry)
        request.obj.complete = false
        f.call('WorldObjInteract', { objs: [request] })
        assert.equal(petPuzzleProgressFacts(puzzleTables, f.state()).revision, 0)
        request.obj.complete = true
        f.call('WorldObjInteract', { objs: [request] })
        assert.equal(petPuzzleProgressFacts(puzzleTables, f.state()).revision, 1)
        const ledger = f.state().petPuzzleProgress
        f.call('WorldObjInteract', { objs: [request] })
        assert.deepEqual(f.state().petPuzzleProgress, ledger)
        f.finishWorld(missing, null)
        f.finishWorld(invalid, { ext_type: 1, ext_uint32_1: invalid.attribute, ext_uint64_1: '18446744073709551615' })
        assert.equal(f.state().petPuzzleProgress.revision, 1)
        assert.equal(f.state().worldObjects[`${missing.map}:${missing.id}`].complete, true)
        f.call('EnterGame', { open_id: 'puzzle-world-first' }, {})
        assert.deepEqual(f.state().petPuzzleProgress, ledger)
    } finally {
        f.close()
    }
})

test('9133 mixed invalid batch, ACK encoding and actual SQLite save failures roll original award and typed fact back', () => {
    const f = puzzleFixture('puzzle-world-rollback')
    const encode = puzzleProtocol.encode
    try {
        const entry = f.worldEntries()[0]
        f.near(entry)
        const request = f.request(entry)
        let before = f.state()
        assert.throws(() => f.call('WorldObjInteract', { objs: [request, { obj: { obj_id: 0, complete: true } }] }))
        assert.deepEqual(f.state(), before)
        puzzleProtocol.encode = function (type, data) {
            if (type === puzzleProtocol.byId.get(9133).rsp) throw Error('puzzle-world-ACK')
            return encode.call(this, type, data)
        }
        assert.throws(() => f.call('WorldObjInteract', { objs: [request] }), /puzzle-world-ACK/)
        assert.deepEqual(f.state(), before)
        puzzleProtocol.encode = encode
        f.store.flushPending()
        before = f.state()
        f.store.db.exec(
            "CREATE TRIGGER reject_puzzle_world BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT, 'puzzle-world-SQL'); END",
        )
        assert.throws(() => f.call('WorldObjInteract', { objs: [request] }), /puzzle-world-SQL/)
        assert.deepEqual(f.state(), before)
        f.store.db.exec('DROP TRIGGER reject_puzzle_world')
        f.call('WorldObjInteract', { objs: [request] })
        assert.equal(f.state().petPuzzleProgress.revision, 1)
    } finally {
        puzzleProtocol.encode = encode
        f.close()
    }
})

test('normal missing context is not a corrupt ledger; full UInt64 aliases and malformed saved facts do not create extra identities', () => {
    const f = puzzleFixture('puzzle-context-shapes')
    try {
        const entry = f.worldEntries()[0],
            context = f.context(entry.attribute),
            s = f.state()
        assert.ok(petPuzzleContextActor(puzzleTables, s, { ...context, ext_uint64_1: '0' + context.ext_uint64_1 }))
        s.pets.push({ ...s.pets.find((p) => p.guid === context.ext_uint64_1), guid: '0' + context.ext_uint64_1 })
        assert.equal(petPuzzleContextActor(puzzleTables, s, context), null)
        assert.ok(
            petPuzzleContextActor(puzzleTables, f.state(), { ...context, ext_uint64_1: Number(context.ext_uint64_1) }),
        )
        for (const guid of ['18446744073709551616', Number.MAX_SAFE_INTEGER + 1, '-1', null])
            assert.equal(petPuzzleContextActor(puzzleTables, f.state(), { ...context, ext_uint64_1: guid }), null)
        f.edit((state) => {
            state.petPuzzleProgress = { version: 1, revision: 1, facts: {} }
        })
        f.near(entry)
        const before = f.state()
        assert.throws(
            () => f.call('WorldObjInteract', { objs: [f.request(entry, null)] }),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.close()
    }
})
