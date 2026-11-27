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
import { appearanceCatalog, normalizeClothes } from '../src/appearance.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
const upload = JSON.parse(fs.readFileSync(new URL('./fixtures/pinch-face-request.json', import.meta.url), 'utf8'))
function fixture(file = ':memory:', { starterProfile = 'normal' } = {}) {
    const store = new Store(file),
        game = new Game(protocol, store, tables, { starterProfile }),
        session = {}
    let seq = 1
    const call = (name, request) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, request) })
    }
    const login = call('EnterGame', { open_id: 'appearance-editor' })
    return { store, session, call, login, state: () => store.load(session.id).state }
}

test('real 9805 appearance upload acknowledges, syncs all colors and preserves scene, party, height and task state', () => {
    const f = fixture()
    try {
        const before = f.state(),
            packets = f.call('PinchFaceDataUp', upload)
        assert.ok(packets.some((p) => p.id === 9805))
        const sync = packets.find((p) => p.id === protocol.byName.get('CSProtoSyncPlayerData').id)
        assert.ok(sync)
        const wardrobe = protocol.decode(protocol.byId.get(sync.id).rsp, sync.payload).basic_info.wardrobe
        assert.equal(wardrobe.complexion, 8001)
        assert.deepEqual(wardrobe.parts, upload.parts)
        assert.deepEqual(wardrobe.avatars, upload.avatars)
        assert.equal(wardrobe.height, before.player.basic_info.wardrobe.height)
        const after = f.state()
        assert.deepEqual(after.world, before.world)
        assert.deepEqual(after.tasks, before.tasks)
        assert.deepEqual(after.player.group_mgrs, before.player.group_mgrs)
        assert.equal(after.characterCustomized, before.characterCustomized)
        f.call('PinchFaceDataUp', upload)
        f.call('PresetWardrobeReq', { ...upload, present: 1 })
        assert.deepEqual(f.state().player.basic_info.wardrobe, after.player.basic_info.wardrobe)
    } finally {
        f.store.close()
    }
})

test('invalid appearance sex or duplicate channels fail atomically', () => {
    const f = fixture()
    try {
        for (const request of [
            { ...upload, sex: 3 },
            { ...upload, parts: [upload.parts[0], upload.parts[0]] },
            {
                ...upload,
                parts: [
                    {
                        ...upload.parts[0],
                        colors: [
                            { index: 0, color_id: 1 },
                            { index: 0, color_id: 2 },
                        ],
                    },
                ],
            },
        ]) {
            const before = f.state()
            assert.throws(() => f.call('PinchFaceDataUp', request))
            assert.deepEqual(f.state(), before)
        }
    } finally {
        f.store.close()
    }
})

test('appearance persists through SQLite restart and is included in login data', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-appearance-')),
        file = path.join(dir, 'state.sqlite')
    // This persistence case starts with owned cosmetics; the next cold login
    // uses the normal default and must retain the existing account's assets.
    let f = fixture(file, { starterProfile: 'sandbox' })
    try {
        f.call('PinchFaceDataUp', upload)
        f.call('PresetWardrobeReq', { ...upload, present: 1 })
        const hero = f.state().player.heros_info.heros.find((hero) => hero.conf_id === 101010)
        f.call('HeroUpdateSkin', { hero_guid: hero.guid, skin_id: 1010101 })
        f.call('PlayerClothesInfoChange', { parts: [{ type: 1, id: 10002 }] })
        f.store.close()
        f = fixture(file)
        assert.equal(f.state().player.basic_info.wardrobe.complexion, upload.complexion)
        assert.deepEqual(f.state().player.basic_info.wardrobe.parts, upload.parts)
        const login = f.login
        const data = protocol.decode('SCEnterGame', login.find((p) => p.id === 5001).payload).data
        const presetEntry = protocol.byName.get('SCProtoPresetWardrobeSync')
        assert.equal(
            protocol.decode(presetEntry.rsp, login.find((p) => p.id === presetEntry.id).payload).info_list[0].present,
            1,
        )
        assert.equal(data.heros_info.heros.find((hero) => hero.conf_id === 101010).hero_skin, 1010101)
        assert.equal(data.basic_info.clothes_info.parts[0].id, 10002)
        assert.deepEqual(data.basic_info.wardrobe.avatars, upload.avatars)
        assert.deepEqual(data.basic_info.wardrobe.parts, upload.parts)
    } finally {
        f.store.close()
        assert.equal(path.dirname(dir), os.tmpdir())
        assert.ok(path.basename(dir).startsWith('lurukaps-appearance-'))
        fs.rmSync(dir, { recursive: true })
    }
})

test('explicit sandbox login sends separate owned clothes and hero skins and retains legacy ownership', () => {
    const f = fixture(undefined, { starterProfile: 'sandbox' })
    try {
        const packet = (name) => {
            const entry = protocol.byName.get(name)
            return protocol.decode(entry.rsp, f.login.find((p) => p.id === entry.id).payload)
        }
        assert.deepEqual(packet('SCProtoClothesInfoSync').unlock_clothes, [...appearanceCatalog(tables).clothes.keys()])
        const info = packet('SCProtoHeroSkinMessageSync').hero_skin_info
        assert.deepEqual(info.find((row) => row.hero_id === '101010').skin_id, [101010, 1010101])
        for (const row of info) {
            assert.ok(f.state().player.heros_info.heros.some((hero) => String(hero.conf_id) === row.hero_id))
            assert.ok(row.skin_id.every((id) => appearanceCatalog(tables).skins.get(id).hero === Number(row.hero_id)))
        }
        // An old account's missing ownership data is populated on its next login.
        f.store.transact(f.session.id, 0, (state) => {
            delete state.unlockedClothes
            delete state.unlockedHeroSkins
        })
        const who = {},
            entry = protocol.byName.get('CSProtoEnterGame')
        const game = new Game(protocol, f.store, tables)
        const migrated = game.dispatch(who, {
            id: entry.id,
            seq: 1,
            payload: protocol.encode(entry.req, { open_id: 'appearance-editor', reconnect: true }),
        })
        assert.ok(migrated.some((p) => p.id === 9790))
        assert.ok(f.state().unlockedHeroSkins[101010].includes(1010101))
    } finally {
        f.store.close()
    }
})

test('preset upload saves three independent slots per sex, replaces a slot and never equips it', () => {
    const f = fixture()
    try {
        const entry = protocol.byName.get('SCProtoPresetWardrobeSync')
        assert.deepEqual(protocol.decode(entry.rsp, f.login.find((p) => p.id === entry.id).payload).info_list, [])
        const before = f.state()
        for (const sex of [1, 2])
            for (const present of [1, 2, 3]) {
                const packets = f.call('PresetWardrobeReq', { ...upload, sex, present })
                assert.ok(packets.some((p) => p.id === 9814))
                assert.ok(packets.some((p) => p.id === 9813))
            }
        assert.equal(f.state().wardrobePresets.length, 6)
        f.call('PresetWardrobeReq', { ...upload, present: 2, complexion: 8002 })
        assert.equal(f.state().wardrobePresets.length, 6)
        assert.equal(f.state().wardrobePresets.find((row) => row.sex === 2 && row.present === 2).complexion, 8002)
        assert.deepEqual(f.state().player.basic_info, before.player.basic_info)
        assert.deepEqual(f.state().player.group_mgrs, before.player.group_mgrs)
        assert.deepEqual(f.state().tasks, before.tasks)
        for (const present of [0, 4]) {
            const saved = f.state()
            assert.throws(() => f.call('PresetWardrobeReq', { ...upload, present }))
            assert.deepEqual(f.state(), saved)
        }
    } finally {
        f.store.close()
    }
})

test('equips configured skins and clothes, resets hero default and rejects wrong hero/slot atomically', () => {
    const f = fixture(undefined, { starterProfile: 'sandbox' })
    try {
        const hero = f.state().player.heros_info.heros.find((hero) => hero.conf_id === 101010)
        const before = f.state()
        const packets = f.call('HeroUpdateSkin', { hero_guid: hero.guid, skin_id: 1010101 })
        assert.ok(packets.some((p) => p.id === 11903))
        assert.equal(f.state().player.heros_info.heros.find((h) => h.guid === hero.guid).hero_skin, 1010101)
        assert.deepEqual(f.state().world, before.world)
        assert.deepEqual(f.state().player.group_mgrs, before.player.group_mgrs)
        f.call('HeroUpdateSkin', { hero_guid: hero.guid, skin_id: 0 })
        assert.equal(f.state().player.heros_info.heros.find((h) => h.guid === hero.guid).hero_skin, 101010)
        f.call('PlayerClothesInfoChange', {
            parts: [
                { type: 1, id: 10002 },
                { type: 5, id: 50001 },
            ],
        })
        for (const [name, req] of [
            ['HeroUpdateSkin', { hero_guid: hero.guid, skin_id: 199001 }],
            ['HeroUpdateSkin', { hero_guid: '999', skin_id: 1010101 }],
            ['PlayerClothesInfoChange', { parts: [{ type: 5, id: 10002 }] }],
            ['PlayerClothesInfoChange', { parts: [{ type: 1, id: 999999 }] }],
        ]) {
            const saved = f.state()
            assert.throws(() => f.call(name, req))
            assert.deepEqual(f.state(), saved)
        }
        f.call('PlayerClothesInfoChange', { parts: [] })
        assert.deepEqual(f.state().player.basic_info.clothes_info.parts, appearanceCatalog(tables).defaults)
    } finally {
        f.store.close()
    }
})

test('legacy empty main clothes are repaired from table defaults without losing selected costume colors', () => {
    const f = fixture(undefined, { starterProfile: 'sandbox' })
    try {
        assert.deepEqual(f.state().player.basic_info.clothes_info.parts, appearanceCatalog(tables).defaults)
        const entry = protocol.byName.get('CSProtoEnterGame')
        f.store.transact(f.session.id, 0, (state) => {
            state.player.basic_info.clothes_info = {}
        })
        const game = new Game(protocol, f.store, tables),
            who = {}
        const packets = game.dispatch(who, {
            id: entry.id,
            seq: 1,
            payload: protocol.encode(entry.req, { open_id: 'appearance-editor', reconnect: true }),
        })
        const login = protocol.decode(entry.rsp, packets.find((packet) => packet.id === entry.id).payload)
        assert.deepEqual(
            login.data.basic_info.clothes_info.parts.map(({ type, id }) => ({ type, id })),
            appearanceCatalog(tables).defaults,
        )
        const costume = { type: 1, id: 10002, colors: [{ index: 0, color_id: 0x112233 }], stocks: 50 }
        f.call('PlayerClothesInfoChange', { parts: [costume] })
        assert.deepEqual(f.state().player.basic_info.clothes_info.parts[0], { ...costume, color_formular_ids: [] })
        assert.equal(f.state().player.basic_info.clothes_info.parts.find((part) => part.type === 5).id, 50001)
        assert.deepEqual(
            normalizeClothes(tables, { parts: [{ type: 1, id: 0 }] }).parts,
            appearanceCatalog(tables).defaults,
        )
    } finally {
        f.store.close()
    }
})
