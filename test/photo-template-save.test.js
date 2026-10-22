import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { photoFixture, assertFailure, fullArguments, tables } from './photo-templates-fixture.js'
import { ErrorCode } from '../src/error-codes.js'
const synced = (out) => out.find((p) => p.id === 9810).data

test('9808 preserves actual complete client parameters and object-key bytes, and 9810 precedes the ACK', () => {
    const f = photoFixture()
    try {
        const before = f.state(),
            row = f.data(),
            out = f.save(row)
        assert(out.findIndex((p) => p.id === 9810) < out.findIndex((p) => p.id === 9808))
        assert.deepEqual(synced(out), { infos: [row], dels: [] })
        assert.equal(synced(out).infos[0].arg, fullArguments)
        assert.equal(Buffer.from(synced(out).infos[0].url, 'base64').toString(), '1001_cellBg_' + f.session.id)
        assert.deepEqual(f.state().player.sbag_infos, before.player.sbag_infos)
        assert.deepEqual(f.state().photoTemplates, { 1001: row })
        assert.deepEqual(f.store.load(f.other.id).state.photoTemplates, undefined)
        assert.deepEqual(synced(f.save(row)), { infos: [row], dels: [] })
        const otherSession = { id: f.other.id, token: 'other' },
            otherRow = { ...row, name: '另一个账号' }
        f.call('ChangePhotoGraphTempletInfo', otherRow, otherSession)
        assert.equal(f.state().photoTemplates[1001].name, row.name)
        assert.equal(f.store.load(f.other.id).state.photoTemplates[1001].name, otherRow.name)
    } finally {
        f.store.close()
    }
})

test('reserved IDs and malformed names/arguments fail atomically without mutating configured templates', () => {
    const f = photoFixture()
    try {
        const configured = structuredClone(tables.get('photo_template'))
        for (const id of [0, 1, 1000])
            assertFailure(f, () => f.save({ ...f.data(), id }), ErrorCode.PhotoTempletIdFail, assert)
        for (const name of ['', ' ', '甲'.repeat(17), 'bad\0name'])
            assertFailure(f, () => f.save({ ...f.data(), name }), ErrorCode.InvalidArgument, assert)
        for (const arg of [
            'no-field',
            'time_{val|bad}',
            'player_{v3Val|1|2}',
            'setting_{extStrTb|1|0',
            'time_{val|Infinity}',
            'x'.repeat(16385),
        ])
            assertFailure(f, () => f.save({ ...f.data(), arg }), ErrorCode.InvalidArgument, assert)
        assert.deepEqual(tables.get('photo_template'), configured)
        assert.equal(synced(f.save({ ...f.data(), arg: '', url: '' })).infos[0].arg, '')
    } finally {
        f.store.close()
    }
})

test('real 20-template capacity blocks only new rows while current IDs remain editable', () => {
    const f = photoFixture()
    try {
        assert.equal(Number(tables.get('game').find((r) => r.title === 'PHOTO_FORMWORK_MAX').value), 20)
        for (let n = 0; n < 20; n++) f.save(f.data(1001 + n, '模板' + n))
        assertFailure(f, () => f.save(f.data(1021)), ErrorCode.PhotoTempletNumIsMax, assert)
        assert.equal(synced(f.save(f.data(1001, '已修改'))).infos[0].name, '已修改')
        assert.equal(Object.keys(f.state().photoTemplates).length, 20)
        f.save({ ...f.data(1001, '十六字合法'), name: '甲'.repeat(16) })
    } finally {
        f.store.close()
    }
})

test('9810 and actual save ACK encoding failures roll back the same metadata transaction', () => {
    for (const wire of ['cs.AllPhotoGraphTempletInfo', 'cs.ProtoNullRsp']) {
        const f = photoFixture()
        try {
            f.save()
            const state = f.state(),
                writes = f.store.db.prepare('select total_changes() n').get().n,
                encode = f.p.encode
            f.p.encode = function (name, data) {
                if (name === wire) throw Error('photo save codec')
                return encode.call(this, name, data)
            }
            assert.throws(() => f.save(f.data(1002)), /photo save codec/)
            assert.deepEqual(f.state(), state)
            assert.equal(f.store.db.prepare('select total_changes() n').get().n, writes)
            f.p.encode = encode
        } finally {
            f.store.close()
        }
    }
})

test('SQLite reopen and real login restore a sorted complete list and empty accounts receive an empty list', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luruka-photo-save-'))
    let f
    try {
        const file = path.join(dir, 'test.sqlite')
        f = photoFixture(file)
        f.save(f.data(1002))
        f.save(f.data(1001))
        const expected = [f.data(1001), f.data(1002)]
        f.store.close()
        f = photoFixture(file)
        assert.deepEqual(synced(f.call('EnterGame', { open_id: 'photo-a' }, {})), { infos: expected, dels: [] })
        assert.deepEqual(synced(f.call('EnterGame', { open_id: 'photo-b' }, {})), { infos: [], dels: [] })
    } finally {
        if (f?.store.db.open) f.store.close()
        assert.equal(path.dirname(dir), os.tmpdir())
        assert(path.basename(dir).startsWith('luruka-photo-save-'))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
