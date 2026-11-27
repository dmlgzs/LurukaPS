import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
const uploaded = JSON.parse(fs.readFileSync(new URL('./fixtures/pinch-face-request.json', import.meta.url)))
for (const part of uploaded.parts)
    assert(part.id === 0 || tables.find('wardrobe', part.id), 'nonempty appearance part uses a current row')
const sync = protocol.byName.get('SCProtoPresetWardrobeSync'),
    save = protocol.byName.get('CSProtoPresetWardrobeReq')
assert.equal(sync.id, 9813)
assert.equal(save.id, 9814)
const url = (version) => `project-3/playerdata/123_preset_${version}.png`
const request = (version, sex = 2, present = 1) => ({
    ...structuredClone(uploaded),
    sex,
    present,
    avatars: [{ avatar_type: 'presetHead', avatar_url: url(version) }],
})
// Current IL contract model, not Unity execution or a cloud uploader:
// ModStore.SetPresetWardrobeInfos stores per-sex dictionaries; ACK callback
// synchronously calls SaveAsPreset→RefreshView→InitSprites, which reads them.
class PresetCache {
    constructor() {
        this.bySex = new Map([
            [1, new Map()],
            [2, new Map()],
        ])
        this.atAck = []
    }
    consume(packets, expected) {
        for (const p of packets) {
            if (p.id === sync.id) {
                for (const info of protocol.decode(sync.rsp, p.payload).info_list)
                    this.bySex.get(info.sex).set(info.present, structuredClone(info))
            } else if (p.id === save.id) {
                const r = this.bySex.get(expected.sex).get(expected.present)
                const observed = r?.avatars.find((a) => a.avatar_type === 'presetHead')?.avatar_url
                this.atAck.push(observed)
                assert.equal(
                    observed,
                    expected.avatars[0].avatar_url,
                    'success callback must refresh the current cached preset thumbnail key',
                )
            }
        }
    }
}
function fixture(file = ':memory:') {
    const name = 'current-preset-cache-' + ++fixture.counter
    let store = new Store(file),
        game = new Game(protocol, store, tables, { clock: () => 1800000000, rng: () => 0 }),
        session = {},
        seq = 1
    const call = (name, value = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, {
            id: e.id,
            seq: seq++,
            payload: e.req ? protocol.encode(e.req, value) : Buffer.alloc(0),
        })
    }
    const state = () => store.load(session.id).state
    const login = call('EnterGame', { open_id: name })
    return {
        name,
        call,
        state,
        login,
        get store() {
            return store
        },
        sql: () => store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(session.id),
        get id() {
            return session.id
        },
        reopen() {
            store.close()
            store = new Store(file)
            game = new Game(protocol, store, tables, { clock: () => 1800000000, rng: () => 0 })
            session = {}
            return call('EnterGame', { open_id: name, reconnect: true })
        },
        close() {
            store.close()
        },
    }
}
fixture.counter = 0

test('current preset first save and overwrite publish9813 before9814 so the actual success callback sees the new list/thumbnail key', () => {
    const f = fixture(),
        client = new PresetCache()
    try {
        const wardrobe = structuredClone(f.state().player.basic_info.wardrobe),
            clothes = structuredClone(f.state().player.basic_info.clothes_info)
        for (const version of ['first', 'overwrite']) {
            const req = request(version),
                packets = f.call('PresetWardrobeReq', req)
            client.consume(packets, req)
            assert(packets.findIndex((p) => p.id === sync.id) < packets.findIndex((p) => p.id === save.id))
        }
        assert.deepEqual(client.atAck, [url('first'), url('overwrite')])
        assert.equal(f.state().wardrobePresets.length, 1)
        assert.equal(f.state().wardrobePresets[0].avatars[0].avatar_url, url('overwrite'))
        assert.deepEqual(f.state().player.basic_info.wardrobe, wardrobe)
        assert.deepEqual(f.state().player.basic_info.clothes_info, clothes)
    } finally {
        f.close()
    }
})

test('all three slots per sex remain isolated and SQLite cold login restores exact preset metadata without wearing or granting clothes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-preset-cache-')),
        f = fixture(path.join(dir, 'synthetic.sqlite')),
        client = new PresetCache()
    try {
        const asset = JSON.stringify({
            bag: f.state().player.sbag_infos,
            clothes: f.state().unlockedClothes,
            wardrobe: f.state().player.basic_info.wardrobe,
            worn: f.state().player.basic_info.clothes_info,
            party: f.state().player.group_mgrs,
        })
        for (const sex of [1, 2])
            for (const present of [1, 2, 3]) {
                const req = request(`${sex}-${present}`, sex, present)
                client.consume(f.call('PresetWardrobeReq', req), req)
            }
        assert.equal(f.state().wardrobePresets.length, 6)
        const saved = structuredClone(f.state().wardrobePresets),
            packets = f.reopen(),
            fresh = new PresetCache()
        fresh.consume(packets)
        for (const r of saved)
            assert.equal(fresh.bySex.get(r.sex).get(r.present).avatars[0].avatar_url, r.avatars[0].avatar_url)
        assert.deepEqual(f.state().wardrobePresets, saved)
        assert.equal(
            JSON.stringify({
                bag: f.state().player.sbag_infos,
                clothes: f.state().unlockedClothes,
                wardrobe: f.state().player.basic_info.wardrobe,
                worn: f.state().player.basic_info.clothes_info,
                party: f.state().player.group_mgrs,
            }),
            asset,
        )
    } finally {
        f.close()
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('metadata codec and SQL failures preserve full state/revision/original slot, then retry and same-slot save do not duplicate records', () => {
    for (const mode of ['codecSync', 'codecAck', 'sql']) {
        const f = fixture(),
            client = new PresetCache()
        try {
            const initial = request('original')
            client.consume(f.call('PresetWardrobeReq', initial), initial)
            const before = JSON.stringify(f.store.load(f.id)),
                sql = JSON.stringify(f.sql()),
                encode = protocol.encode
            if (mode === 'sql')
                f.store.db.exec(
                    "CREATE TRIGGER fail_preset BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'preset SQL boundary'); END",
                )
            else
                protocol.encode = function (type, value) {
                    if (type === (mode === 'codecSync' ? sync.rsp : save.rsp)) throw new Error('preset codec boundary')
                    return encode.call(this, type, value)
                }
            try {
                assert.throws(() => f.call('PresetWardrobeReq', request('retry')), /preset (codec|SQL) boundary/)
            } finally {
                protocol.encode = encode
                if (mode === 'sql') f.store.db.exec('DROP TRIGGER fail_preset')
            }
            assert.equal(JSON.stringify(f.store.load(f.id)), before)
            assert.equal(JSON.stringify(f.sql()), sql)
            const next = request('retry')
            client.consume(f.call('PresetWardrobeReq', next), next)
            client.consume(f.call('PresetWardrobeReq', next), next)
            assert.equal(f.state().wardrobePresets.length, 1)
            assert.equal(f.state().wardrobePresets[0].avatars[0].avatar_url, url('retry'))
            for (const bad of [
                { ...next, sex: 3 },
                { ...next, present: 0 },
                { ...next, present: 4 },
                { ...next, parts: [next.parts[0], next.parts[0]] },
            ]) {
                const raw = JSON.stringify(f.store.load(f.id))
                assert.throws(
                    () => f.call('PresetWardrobeReq', bad),
                    (e) => e.code === ErrorCode.InvalidArgument,
                )
                assert.equal(JSON.stringify(f.store.load(f.id)), raw)
            }
        } finally {
            f.close()
        }
    }
})

test('default normal wardrobe keeps the two current single-selection clothes required before PageCustomClothes.SaveData can send5023', () => {
    const f = fixture()
    try {
        const defaults = String(tables.get('game').find((r) => r.title === 'CLOTHING_DEFAULT_CONF').value)
            .split('|')
            .map((x) => x.split('#').map(Number))
        assert.deepEqual(
            defaults.map((x) => x[0]).sort((a, b) => a - b),
            [1, 5],
            'current PageCustomClothes ctor has selectionMode1 for1/5;2/3/4 are multi',
        )
        for (const [type, id] of defaults) {
            assert(tables.find('clothing_item', id))
            const values = f
                .state()
                .player.basic_info.clothes_info.parts.filter((p) => p.type === type)
                .map((p) => p.id)
            assert(values.length > 0, 'First on current single-selection dictionary cannot be empty')
            assert(values.includes(id))
        }
        assert(f.state().starterProfile, 'normal profile is explicit')
        assert.equal(f.state().player.heros_info.heros.length, 1)
        assert.equal(f.state().pets.length, 0)
    } finally {
        f.close()
    }
})
