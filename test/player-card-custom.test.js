import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { chatShieldFixture } from './chat-shield-fixture.js'
import { ErrorCode } from '../src/error-codes.js'
const fixture = (n, file) => chatShieldFixture('card-custom-' + n, file)
const key = (f, slot = 20301, stamp = 1800000000) =>
    'project-3/playerdata/standee/hero/' +
    f.a.id +
    '_' +
    slot +
    '_' +
    f.state(f.a).player.heros_info.heros.find((h) => !h.trail).conf_id +
    '_1_' +
    stamp
const saved = (f) => f.state(f.a).playerCardItems.find((r) => r.config === 20301)

test('6142 saves real client object keys to only table-defined custom slots and syncs bag before ACK', () => {
    const f = fixture('save')
    try {
        const url = key(f),
            other = f.state(f.b)
        const out = f.call(f.a, 'SetStandPlatesRole', { config: 20301, url })
        assert(out.findIndex((p) => p.id === 5104) < out.findIndex((p) => p.id === 6142))
        const bag = f.protocol.decode('AllStandPlatesBagInfo', out.find((p) => p.id === 5104).payload)
        assert.deepEqual(
            bag.bags.find((r) => r.config === 20301),
            { config: 20301, url },
        )
        assert.deepEqual(f.protocol.decode('ProtoNullRsp', out.find((p) => p.id === 6142).payload), {})
        assert.equal(f.state(f.a).player.basic_info.stand_plates, undefined)
        f.call(f.a, 'ChangeStandPlates', { role: { config: 20301, url } })
        const next = key(f, 20301, 1800000001)
        f.call(f.a, 'SetStandPlatesRole', { config: 20301, url: next })
        assert.equal(f.state(f.a).player.basic_info.stand_plates.role.url, next)
        const revision = f.state(f.a).playerCardRevision
        const again = f.call(f.a, 'SetStandPlatesRole', { config: 20301, url: next })
        assert(!again.some((p) => p.id === 5104))
        assert.equal(f.state(f.a).playerCardRevision, revision)
        assert.equal(f.state(f.a).playerCardItems.filter((r) => r.config === 20301).length, 1)
        assert.deepEqual(f.state(f.b), other)
    } finally {
        f.store.close()
    }
})
test('6142 rejects other owners, wrong category, static decorations and unsaved image URLs atomically', () => {
    const f = fixture('reject')
    try {
        const before = f.state(f.a),
            url = key(f)
        for (const value of [
            '',
            url.replace('/' + f.a.id + '_', '/' + f.b.id + '_'),
            url.replace('_20301_', '_20302_'),
            'https://example.invalid/image.png',
            url + '/../x',
            url.replace(/_\d+_1_/, '_999999_1_'),
        ])
            assert.throws(() => f.call(f.a, 'SetStandPlatesRole', { config: 20301, url: value }))
        assert.throws(
            () => f.call(f.a, 'SetStandPlatesRole', { config: 10101, url }),
            (e) => e.code === ErrorCode.CardDressConfNone,
        )
        assert.throws(
            () => f.call(f.a, 'SetStandPlatesRole', { config: 20305, url }),
            (e) => e.code === ErrorCode.NCardDressConfCustomZero,
        )
        assert.throws(
            () => f.call(f.a, 'ChangeStandPlates', { role: { config: 20301, url } }),
            (e) => e.code === ErrorCode.CardDressStandPlatesNone,
        )
        assert.deepEqual(f.state(f.a), before)
    } finally {
        f.store.close()
    }
})
test('6142 bag/ACK codec failures roll back image metadata and worn selection', () => {
    const f = fixture('codec')
    const encode = f.protocol.encode
    try {
        const url = key(f),
            before = f.state(f.a)
        for (const type of ['cs.AllStandPlatesBagInfo', 'cs.ProtoNullRsp']) {
            f.protocol.encode = function (name, ...args) {
                if (name === type) throw Error('custom card encode failed')
                return encode.call(this, name, ...args)
            }
            assert.throws(() => f.call(f.a, 'SetStandPlatesRole', { config: 20301, url }), /custom card encode failed/)
            assert.deepEqual(f.state(f.a), before)
            f.protocol.encode = encode
        }
    } finally {
        f.protocol.encode = encode
        f.store.close()
    }
})
test('6142 custom image and selected role persist across SQLite reopen and actual login bag', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-custom-card-'))
    let f
    try {
        const file = path.join(dir, 'state.sqlite')
        f = fixture('reopen', file)
        const url = key(f)
        f.call(f.a, 'SetStandPlatesRole', { config: 20301, url })
        f.call(f.a, 'ChangeStandPlates', { role: { config: 20301, url } })
        f.store.close()
        f = fixture('reopen', file)
        assert.deepEqual(saved(f), { config: 20301, url })
        const out = f.call({}, 'EnterGame', { open_id: 'shield-card-custom-reopen-a' })
        const bag = f.protocol.decode('AllStandPlatesBagInfo', out.find((p) => p.id === 5104).payload)
        assert.equal(bag.bags.find((r) => r.config === 20301).url, url)
        assert.equal(
            f.protocol.decode(f.protocol.byId.get(5001).rsp, out.find((p) => p.id === 5001).payload).data.basic_info
                .stand_plates.role.url,
            url,
        )
    } finally {
        f?.store.close()
        assert.equal(path.dirname(dir), os.tmpdir())
        assert(path.basename(dir).startsWith('lurukaps-custom-card-'))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
