import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { showcaseFixture, sceneData } from './scene-showcase-fixture.js'
import { ErrorCode } from '../src/error-codes.js'
import { publicProfile } from '../src/public-profile.js'
const basic = (f, who = f.a) => f.state(who).player.basic_info

test('6145 selects an unlocked unsaved default slot and synchronizes before null ACK', () => {
    const f = showcaseFixture('select-default')
    try {
        f.store.transact(f.a.id, 0, (s) => {
            s.player.basic_info.lv = 2
            s.player.basic_info.show_case = 0
        })
        const other = f.state(f.b)
        const packets = f.call(f.a, 'ChangeShowcaseId', { u32: 2 })
        assert.equal(basic(f).show_case_id, 2)
        assert.equal(basic(f).scene_showcase, undefined)
        assert.equal(basic(f).show_case, 0)
        const entry = f.protocol.byName.get('CSProtoSyncPlayerData')
        const sync = packets.find((p) => p.id === entry.id),
            ack = packets.find((p) => p.id === 6145)
        assert(packets.indexOf(sync) < packets.indexOf(ack))
        const update = f.protocol.decode(entry.rsp, sync.payload).basic_info
        assert.equal(update.show_case_id, 2)
        assert.deepEqual(update.scene_showcase, [])
        assert.deepEqual(f.protocol.decode('ProtoNullRsp', ack.payload), {})
        assert.deepEqual(f.state(f.b), other)
        assert.equal(publicProfile(basic(f)).show_case_id, 2)
        f.call(f.a, 'ChangeShowcaseId', { u32: 2 })
        assert.equal(basic(f).scene_showcase, undefined)
    } finally {
        f.store.close()
    }
})

test('6145 uses table levels for every slot without bypassing locks or inventing absent IDs', () => {
    const f = showcaseFixture('select-level')
    try {
        for (const row of f.tables.get('photo_space_case')) {
            const level = Number(row.unlock.split('#')[1])
            if (level > 1) {
                f.store.transact(f.a.id, 0, (s) => {
                    s.player.basic_info.lv = level - 1
                })
                const before = f.state(f.a)
                assert.throws(
                    () => f.call(f.a, 'ChangeShowcaseId', { u32: row.id }),
                    (e) => e.code === ErrorCode.FunctionClosed,
                )
                assert.deepEqual(f.state(f.a), before)
            }
            f.store.transact(f.a.id, 0, (s) => {
                s.player.basic_info.lv = level
            })
            f.call(f.a, 'ChangeShowcaseId', { u32: row.id })
            assert.equal(basic(f).show_case_id, row.id)
        }
        const before = f.state(f.a)
        for (const request of [{}, { u32: 0 }, { u32: 999 }])
            assert.throws(
                () => f.call(f.a, 'ChangeShowcaseId', request),
                (e) => e.code === (request.u32 ? ErrorCode.GameConfig : ErrorCode.InvalidArgument),
            )
        assert.deepEqual(f.state(f.a), before)
        assert.equal(basic(f).scene_showcase, undefined)
    } finally {
        f.store.close()
    }
})

test('6145 keeps saved content and showcase type separate and exposes selected public card', () => {
    const f = showcaseFixture('select-saved')
    try {
        f.store.transact(f.a.id, 0, (s) => {
            s.player.basic_info.lv = 10
        })
        const first = sceneData(f, 1),
            third = { ...sceneData(f, 3), name: '第三方案' }
        f.call(f.a, 'ChangeSceneShowcase', { data: first })
        f.call(f.a, 'ChangeSceneShowcase', { data: third })
        f.call(f.a, 'ChangeShowcaseType', { u32: 1 })
        const saved = basic(f).scene_showcase
        f.call(f.a, 'ChangeShowcaseId', { u32: 3 })
        assert.deepEqual(basic(f).scene_showcase, saved)
        assert.equal(basic(f).show_case, 1)
        const projected = publicProfile(basic(f))
        assert.equal(projected.show_case_id, 3)
        assert.equal(projected.show_case, 1)
        assert.deepEqual(projected.scene_showcase, [first, third])
        assert.equal(basic(f, f.b).show_case_id, undefined)
    } finally {
        f.store.close()
    }
})

test('6145 actual sync/ACK encoding failure rolls back the selected slot and other account', () => {
    const f = showcaseFixture('select-codec'),
        encode = f.protocol.encode
    try {
        const before = f.state(f.a),
            other = f.state(f.b)
        for (const failed of [f.protocol.byName.get('CSProtoSyncPlayerData').rsp, 'cs.ProtoNullRsp']) {
            f.protocol.encode = function (name, ...args) {
                if (name === failed) throw Error('select codec failed')
                return encode.call(this, name, ...args)
            }
            assert.throws(() => f.call(f.a, 'ChangeShowcaseId', { u32: 1 }), /select codec failed/)
            assert.deepEqual(f.state(f.a), before)
            assert.deepEqual(f.state(f.b), other)
            f.protocol.encode = encode
        }
    } finally {
        f.protocol.encode = encode
        f.store.close()
    }
})

test('6145 selection persists through SQLite reopen/login without fabricating default content', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-showcase-select-'))
    let f
    try {
        const file = path.join(dir, 'state.sqlite')
        f = showcaseFixture('select-reopen', file)
        f.store.transact(f.a.id, 0, (s) => {
            s.player.basic_info.lv = 2
        })
        f.call(f.a, 'ChangeShowcaseId', { u32: 2 })
        f.store.close()
        f = showcaseFixture('select-reopen', file)
        assert.equal(basic(f).show_case_id, 2)
        assert.equal(basic(f).scene_showcase, undefined)
        const packets = f.call({}, 'EnterGame', { open_id: 'shield-showcase-select-reopen-a' })
        const login = f.protocol.decode(f.protocol.byId.get(5001).rsp, packets.find((p) => p.id === 5001).payload)
        assert.equal(login.data.basic_info.show_case_id, 2)
        assert.deepEqual(login.data.basic_info.scene_showcase, [])
        assert.equal(basic(f, f.b).show_case_id, undefined)
    } finally {
        f?.store.close()
        assert.equal(path.dirname(dir), os.tmpdir())
        assert(path.basename(dir).startsWith('lurukaps-showcase-select-'))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
