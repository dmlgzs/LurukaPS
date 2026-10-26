import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { reclamationFixture } from './field-reclamation-fixture.js'
import {
    fieldReclamationRule,
    fieldReclamationValue,
    recordFieldReclamation,
} from '../src/field-reclamation-progress.js'
import { ErrorCode } from '../src/error-codes.js'

const tokens = [12031, 0, 30]
const value = (f) => fieldReclamationValue(f.state(), tokens)
const error = (code) => (e) => e.code === code

test('real FieldOpen creates one fact, existing retries do not, and close/reopen creates a distinct accepted field', () => {
    const f = reclamationFixture('reclamation-source-real')
    try {
        assert(f.state().home.builds.some((row) => row.crop_info))
        assert.equal(value(f), 0) // Legal old/default fields are not historic proof.
        const first = f.open()
        assert.equal(value(f), 1)
        const receipt = structuredClone(f.state().home.reclamationProgress)
        const repeated = f.open()
        assert.equal(repeated.build.guid, first.build.guid)
        assert.deepEqual(f.state().home.reclamationProgress, receipt)
        f.close(first.build.guid)
        assert.equal(value(f), 1)
        const second = f.open()
        assert(second.build.guid > first.build.guid)
        assert.equal(value(f), 2)
        const state = f.state(),
            build = state.home.builds.find((row) => row.guid === second.build.guid)
        assert.equal(recordFieldReclamation(f.tables, state, build), false)
        assert.equal(fieldReclamationValue(state, tokens), 2)
    } finally {
        f.store.close()
    }
})

test('failed type, location and unavailable fertile-field creation never count; no outside-home operation is accepted', () => {
    const f = reclamationFixture('reclamation-source-reject')
    try {
        for (const request of [
            { field_type: 999999, locate: f.locate },
            { field_type: f.fieldType.id, locate: { ...f.locate, block_id: 0 } },
        ]) {
            const before = f.state()
            assert.throws(() => f.open(request))
            assert.deepEqual(f.state(), before)
            assert.equal(value(f), 0)
        }
        const otherType = f.tables.get('home_fieldtype').find((row) => row.id !== f.fieldType.id)
        assert(otherType)
        assert.throws(() => f.open({ field_type: otherType.id, locate: f.locate }))
        assert.equal(value(f), 0)
        f.edit((s) => {
            s.world.map_id = f.tables.get('world_city').find((row) => row.id !== s.world.map_id).id
        })
        const before = f.state()
        assert.throws(() => f.open())
        assert.deepEqual(f.state(), before)
        assert.equal(value(f), 0)
    } finally {
        f.store.close()
    }
})

test('actual FieldOpen response and SQL failures restore new GUID, fields, counters and pending state together', () => {
    const f = reclamationFixture('reclamation-source-rollback')
    try {
        const before = f.state(),
            pending = f.store.pending.get(f.session.id),
            token = f.store.readCacheToken(f.session.id)
        const encode = f.protocol.encode,
            reply = f.protocol.byName.get('CSProtoFieldOpen').rsp
        f.protocol.encode = function (type, ...args) {
            if (type === reply) throw Error('reclamation-source-codec')
            return encode.call(this, type, ...args)
        }
        try {
            assert.throws(() => f.open(), /reclamation-source-codec/)
        } finally {
            f.protocol.encode = encode
        }
        assert.deepEqual(f.state(), before)
        assert.equal(f.store.pending.get(f.session.id), pending)
        assert.equal(f.store.readCacheToken(f.session.id), token)
        assert(Number.isSafeInteger(f.session.id) && f.session.id > 0)
        f.store.db.exec(
            `CREATE TEMP TRIGGER reclamation_abort BEFORE UPDATE ON players WHEN OLD.account_id=${f.session.id} BEGIN SELECT RAISE(ABORT,'reclamation-source-SQL'); END`,
        )
        try {
            assert.throws(() => f.open(), /reclamation-source-SQL/)
        } finally {
            f.store.db.exec('DROP TRIGGER reclamation_abort')
        }
        assert.deepEqual(f.state(), before)
        assert.equal(f.store.pending.get(f.session.id), pending)
        f.open()
        assert.equal(value(f), 1)
    } finally {
        f.store.close()
    }
})

test('source versions, canonical type identities and GUID receipts are checked without using old field stock', () => {
    const f = reclamationFixture('reclamation-source-integrity')
    try {
        assert.equal(fieldReclamationRule(tokens), true)
        for (const t of [null, {}, [12031], [12031, 1, 30], [12031, 0, 0], [12031, 0, 30, 1]]) {
            assert.equal(fieldReclamationRule(t), false)
            assert.equal(fieldReclamationValue(f.state(), t), null)
        }
        for (const [saved, code] of [
            [{ version: 2 }, ErrorCode.FunctionClosed],
            [{ version: 1, countsByType: { '01': 1 }, lastGuid: 200, lastFieldType: 1 }, ErrorCode.GameConfig],
            [{ version: 1, countsByType: { 1: 3 }, lastGuid: 2, lastFieldType: 1 }, ErrorCode.GameConfig],
        ]) {
            f.edit((s) => {
                s.home.reclamationProgress = saved
            })
            const before = f.state()
            assert.throws(() => f.open(), error(code))
            assert.deepEqual(f.state(), before)
        }
        f.edit((s) => {
            delete s.home.reclamationProgress
        })
        assert.equal(value(f), 0)
        f.open()
        assert.equal(value(f), 1)
    } finally {
        f.store.close()
    }
})

test('SQLite reopening retains committed counts and another account keeps an independent empty reclamation history', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'field-reclamation-')),
        filename = path.join(directory, 'probe.sqlite')
    let f = reclamationFixture('reclamation-source-reopen', filename)
    try {
        const first = f.open().build.guid
        f.close(first)
        f.store.close()
        f = reclamationFixture('reclamation-source-reopen', filename, true)
        assert.equal(value(f), 1)
        f.open()
        assert.equal(value(f), 2)
        const other = reclamationFixture('reclamation-source-other', filename)
        try {
            assert.equal(value(other), 0)
        } finally {
            other.store.close()
        }
        assert.equal(value(f), 2)
    } finally {
        f.store.close()
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()))
        assert(path.basename(directory).startsWith('field-reclamation-'))
        fs.rmSync(directory, { recursive: true, force: true })
    }
})
