import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { photoFixture, assertFailure, tables } from './photo-templates-fixture.js'
import { ErrorCode } from '../src/error-codes.js'
const remove = (f, id = 1001) => f.call('DeletePhotoGraphTemplet', { u32: id })

test('9807 really removes only the owned template and emits 9810 dels before the ACK', () => {
    const f = photoFixture()
    try {
        f.save()
        f.save(f.data(1002))
        const other = { id: f.other.id, token: 'other' },
            otherRow = f.data(1001, '其他账号')
        f.call('ChangePhotoGraphTempletInfo', otherRow, other)
        const before = f.state(),
            out = remove(f)
        assert(out.findIndex((p) => p.id === 9810) < out.findIndex((p) => p.id === 9807))
        assert.deepEqual(out.find((p) => p.id === 9810).data, { infos: [], dels: [1001] })
        assert.equal(f.state().photoTemplates[1001], undefined)
        assert.deepEqual(f.state().photoTemplates[1002], before.photoTemplates[1002])
        assert.deepEqual(f.state().player.sbag_infos, before.player.sbag_infos)
        assert.deepEqual(f.store.load(f.other.id).state.photoTemplates, { 1001: otherRow })
    } finally {
        f.store.close()
    }
})

test('9807 distinguishes protected system IDs and nonexistent owned records, including a repeated deletion', () => {
    const f = photoFixture()
    try {
        const system = structuredClone(tables.get('photo_template'))
        f.save()
        remove(f)
        assertFailure(f, () => remove(f), ErrorCode.PhotoTempletNotExist, assert)
        for (const id of [0, 1, 1000]) assertFailure(f, () => remove(f, id), ErrorCode.PhotoTempletIdFail, assert)
        f.call('ChangePhotoGraphTempletInfo', f.data(1002), { id: f.other.id, token: 'other' })
        assertFailure(f, () => remove(f, 1002), ErrorCode.PhotoTempletNotExist, assert)
        assert.deepEqual(tables.get('photo_template'), system)
        assert.equal(f.store.load(f.other.id).state.photoTemplates[1002].id, 1002)
    } finally {
        f.store.close()
    }
})

test('9807 deletion sync and actual ACK codec failures restore the original row and do not write SQLite', () => {
    for (const type of ['cs.AllPhotoGraphTempletInfo', 'cs.ProtoNullRsp']) {
        const f = photoFixture()
        try {
            f.save()
            const before = f.state(),
                writes = f.store.db.prepare('select total_changes() n').get().n,
                encode = f.p.encode
            f.p.encode = function (name, data) {
                if (name === type) throw Error('photo delete codec')
                return encode.call(this, name, data)
            }
            assert.throws(() => remove(f), /photo delete codec/)
            assert.deepEqual(f.state(), before)
            assert.equal(f.store.db.prepare('select total_changes() n').get().n, writes)
            f.p.encode = encode
        } finally {
            f.store.close()
        }
    }
})

test('9807 releases actual capacity and SQLite reopen/login never reintroduce the deleted template', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luruka-photo-delete-'))
    let f
    try {
        const file = path.join(dir, 'state.sqlite')
        f = photoFixture(file)
        for (let n = 1001; n <= 1020; n++) f.save(f.data(n))
        remove(f, 1001)
        f.save(f.data(1021))
        assert.equal(Object.keys(f.state().photoTemplates).length, 20)
        f.store.close()
        f = photoFixture(file)
        const infos = f.call('EnterGame', { open_id: 'photo-a' }, {}).find((p) => p.id === 9810).data.infos
        assert.equal(infos.length, 20)
        assert.equal(
            infos.some((r) => r.id === 1001),
            false,
        )
        assert.equal(
            infos.some((r) => r.id === 1021),
            true,
        )
        for (let n = 1002; n <= 1021; n++) remove(f, n)
        assert.deepEqual(f.call('EnterGame', { open_id: 'photo-a' }, {}).find((p) => p.id === 9810).data, {
            infos: [],
            dels: [],
        })
    } finally {
        if (f?.store.db.open) f.store.close()
        assert.equal(path.dirname(dir), os.tmpdir())
        assert(path.basename(dir).startsWith('luruka-photo-delete-'))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
