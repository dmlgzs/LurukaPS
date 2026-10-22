import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { photoFixture, assertFailure } from './photo-templates-fixture.js'
import { ErrorCode } from '../src/error-codes.js'
const rename = (f, name, id = 1001) =>
    f.call('ChangePhotoGraphTempletName', { id, name: Buffer.from(name).toString('base64') })

test('9809 UTF-8 bytes rename updates 9810 before the ACK, preserving the image key and exact parameters', () => {
    const f = photoFixture()
    try {
        const original = f.data()
        f.save(original)
        const name = '甲'.repeat(16),
            out = rename(f, name),
            row = { ...original, name }
        assert(out.findIndex((p) => p.id === 9810) < out.findIndex((p) => p.id === 9809))
        assert.deepEqual(out.find((p) => p.id === 9810).data, { infos: [row], dels: [] })
        assert.deepEqual(f.state().photoTemplates, { 1001: row })
        rename(f, name)
        assert.equal(Object.keys(f.state().photoTemplates).length, 1)
        assert.equal(f.store.load(f.other.id).state.photoTemplates, undefined)
    } finally {
        f.store.close()
    }
})

test('9809 checks custom ownership, missing IDs and invalid UTF-8 or name limits without replacing valid metadata', () => {
    const f = photoFixture()
    try {
        f.save()
        for (const id of [0, 1, 1000])
            assertFailure(f, () => rename(f, '新名字', id), ErrorCode.PhotoTempletIdFail, assert)
        const actor = { id: f.other.id, token: 'other' }
        f.call('ChangePhotoGraphTempletInfo', f.data(1002), actor)
        assertFailure(f, () => rename(f, '新名字', 1002), ErrorCode.PhotoTempletNotExist, assert)
        for (const name of ['', ' ', '甲'.repeat(17), 'line\nfeed'])
            assertFailure(f, () => rename(f, name), ErrorCode.InvalidArgument, assert)
        assertFailure(
            f,
            () =>
                f.call('ChangePhotoGraphTempletName', { id: 1001, name: Buffer.from([0xc3, 0x28]).toString('base64') }),
            ErrorCode.InvalidArgument,
            assert,
        )
        assert.equal(f.store.load(f.other.id).state.photoTemplates[1002].name, f.data().name)
    } finally {
        f.store.close()
    }
})

test('9809 synchronization and ACK encoding failures both roll back the original row', () => {
    for (const type of ['cs.AllPhotoGraphTempletInfo', 'cs.ProtoNullRsp']) {
        const f = photoFixture()
        try {
            f.save()
            const before = f.state(),
                encode = f.p.encode,
                writes = f.store.db.prepare('select total_changes() n').get().n
            f.p.encode = function (name, value) {
                if (name === type) throw Error('photo rename codec')
                return encode.call(this, name, value)
            }
            assert.throws(() => rename(f, '改变名称'), /photo rename codec/)
            assert.deepEqual(f.state(), before)
            assert.equal(f.store.db.prepare('select total_changes() n').get().n, writes)
            f.p.encode = encode
        } finally {
            f.store.close()
        }
    }
})

test('9809 persists through SQLite close/reopen and actual login without rewriting the stored image or settings', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luruka-photo-rename-'))
    let f
    try {
        const file = path.join(dir, 'state.sqlite')
        f = photoFixture(file)
        const row = f.data()
        f.save(row)
        rename(f, '改名后的模板')
        f.store.close()
        f = photoFixture(file)
        const out = f.call('EnterGame', { open_id: 'photo-a' }, {})
        assert.deepEqual(out.find((p) => p.id === 9810).data.infos, [{ ...row, name: '改名后的模板' }])
    } finally {
        if (f?.store.db.open) f.store.close()
        assert.equal(path.dirname(dir), os.tmpdir())
        assert(path.basename(dir).startsWith('luruka-photo-rename-'))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
