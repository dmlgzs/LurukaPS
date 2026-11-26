import test from 'node:test'
import assert from 'node:assert/strict'
import { tables, protocol, fixture, party } from './helpers/obt-appearance-fixture.js'
import { ObtAppearanceConsumer } from './helpers/obt-appearance-consumer.js'

const skins = tables
    .get('hero_clothing')
    .filter((row) => row.hero > 0 && row.clothingid !== row.hero && tables.find('hero', row.hero)?.isUsable === 1)
const palette = (sex, clothesid, present, offset = 0) => {
    const clothing = tables.get('clothing_item').find((row) => row.id === clothesid)
    const formulaId = Number((sex === 1 ? clothing.maleColor : clothing.femaleColor).split('|')[0])
    const formula = tables.get('color_formula').find((row) => row.Id === formulaId)
    const colors = [1, 2, 3, 4, 5]
        .filter((i) => formula[`color${i}`])
        .map((_, index) => ({ index, color_id: 0x113355ff + index * 0x10000 + offset }))
    return { sex, clothesid, present, parts: [{ type: 1, id: clothesid, colors }] }
}
test('9805 incremental facial and portrait updates match the current cache and remain identical after reconnect', () => {
    const f = fixture('face')
    try {
        const hair = tables.get('color_formula').find((row) => row.sex === 2 && row.part === 6)
        f.call('PinchFaceDataUp', {
            sex: 2,
            height: 90,
            complexion: 0xa1b2c3ff,
            parts: [{ type: 6, id: hair.wardrobeId, colors: [{ index: 0, color_id: 0xff112233 }] }],
            avatars: [
                { avatar_type: 'head1', avatar_url: 'first-head' },
                { avatar_type: 'head2', avatar_url: 'first-half' },
            ],
        })
        let onSave
        f.client.onAck(9805, (client) => {
            onSave = client.recreate().face
        })
        f.call('PinchFaceDataUp', {
            complexion: 0x010203ff,
            parts: [],
            avatars: [{ avatar_type: 'head2', avatar_url: 'new-half' }],
        })
        assert.equal(onSave.complexion, 0x010203ff)
        assert.equal(onSave.parts.find((part) => part.type === 6).id, hair.wardrobeId)
        assert.equal(new Map(onSave.avatars).get('head1'), 'first-head')
        assert.equal(new Map(onSave.avatars).get('head2'), 'new-half')
        f.call('PinchFaceDataUp', { height: 0, complexion: 0, parts: [{ type: 6, id: 0, colors: [] }] })
        assert.equal(f.state().player.basic_info.wardrobe.height, 90)
        assert.equal(f.state().player.basic_info.wardrobe.complexion, 0x010203ff)
        assert.equal(f.state().player.basic_info.wardrobe.parts.find((part) => part.type === 6).id, hair.wardrobeId)
        const live = f.client.recreate().face
        assert.deepEqual(f.login().recreate().face, live)
    } finally {
        f.store.close()
    }
})

test('9816 palettes refresh9815 before the callback, isolate sex/clothing/slot, overwrite and survive reconnect without wearing them', () => {
    const f = fixture('palettes')
    try {
        const equipped = structuredClone(f.state().player.basic_info)
        const requests = [palette(2, 10001, 1), palette(1, 10001, 1), palette(2, 10002, 1)]
        for (const request of requests) {
            let seen
            f.client.onAck(9816, (client) => {
                seen = client.palettes.get(`${request.sex}:${request.clothesid}:${request.present}`)
            })
            const packets = f.call('PresetClothesInfoReq', request)
            assert(
                packets.findIndex((packet) => packet.id === 9815) < packets.findIndex((packet) => packet.id === 9816),
            )
            assert.deepEqual(
                seen,
                request.parts[0].colors.map((color) => color.color_id),
            )
        }
        const overwrite = palette(2, 10001, 1, 0x100)
        f.call('PresetClothesInfoReq', overwrite)
        assert.equal(f.state().clothesPresets.length, 3)
        assert.equal(f.client.palettes.size, 3)
        assert.deepEqual(f.state().player.basic_info, equipped)
        let worn
        f.client.onAck(5023, (client) => {
            worn = client.recreate()
        })
        f.call('PlayerClothesInfoChange', { ...overwrite, wear: true })
        assert.deepEqual(worn.clothes.parts.find((part) => part.type === 1).colors, overwrite.parts[0].colors)
        f.call('PresetWardrobeReq', { sex: 2, present: 1, parts: [], complexion: 0x112233ff })
        assert.equal(f.client.facePresets.size, 1)
        assert.equal(f.client.palettes.size, 3)
        const beforeBad = f.state()
        for (const bad of [
            { ...overwrite, present: 4 },
            { ...overwrite, parts: [] },
            { ...overwrite, parts: [{ ...overwrite.parts[0], colors: [] }] },
            { ...overwrite, clothesid: 50001 },
        ])
            assert.throws(() => f.call('PresetClothesInfoReq', bad))
        assert.deepEqual(f.state(), beforeBad)
        const reconnect = f.login()
        assert.deepEqual(reconnect.palettes, f.client.palettes)
        assert.deepEqual(reconnect.facePresets, f.client.facePresets)
        assert.deepEqual(reconnect.clothes, f.client.clothes)
    } finally {
        f.store.close()
    }
})

test('current5023 callback recreates from the new decorations and keeps facial data in its separate channel', () => {
    const f = fixture('clothes')
    try {
        const face = f.client.facialSnapshot()
        let created
        f.client.onAck(5023, (client) => {
            created = client.recreate()
        })
        f.call('PlayerClothesInfoChange', {
            sex: 2,
            present: 1,
            clothesid: 10002,
            wear: true,
            parts: [
                { type: 1, id: 10002 },
                { type: 2, id: 40001 },
            ],
        })
        assert.equal(created.clothes.parts.find((part) => part.type === 1).id, 10002)
        assert(created.clothes.parts.some((part) => part.type === 2 && part.id === 40001))
        assert(created.clothes.parts.some((part) => part.type === 5 && part.id === 50001))
        assert.deepEqual(created.face, face)
        f.call('PlayerClothesInfoChange', { sex: 2, parts: [{ type: 1, id: 10001 }] })
        assert(!f.client.clothes.parts.some((part) => part.type === 2))
        assert.deepEqual(f.login().clothes, f.client.clothes)
    } finally {
        f.store.close()
    }
})

test('all current nondefault hero skins recreate the active hero with fresh skinned ultimate levels and can cast without a formation swap', () => {
    assert.equal(skins.length, 3)
    const f = fixture('skins')
    try {
        assert.equal(f.client.unlockedClothes.size, tables.get('clothing_item').length)
        for (const skin of skins) assert(f.client.skinOwnership.get(skin.hero).has(skin.clothingid))
        const ownershipId = protocol.byName.get('SCProtoHeroSkinMessageSync').id
        const invalidOwnership = new ObtAppearanceConsumer(tables, protocol)
        invalidOwnership.consumePackets(f.initial.filter((packet) => packet.id !== ownershipId))
        const wrong = protocol.decode(
            protocol.byId.get(ownershipId).rsp,
            f.initial.find((packet) => packet.id === ownershipId).payload,
        )
        for (const row of wrong.hero_skin_info)
            row.hero_id =
                f.state().player.heros_info.heros.find((hero) => String(hero.conf_id) === row.hero_id)?.guid ??
                row.hero_id
        invalidOwnership.consume({
            id: ownershipId,
            payload: protocol.encode(protocol.byId.get(ownershipId).rsp, wrong),
        })
        for (const skin of skins) assert(!invalidOwnership.skinOwnership.get(skin.hero).has(skin.clothingid))
        for (const skin of skins) {
            f.edit((state) => {
                state.player.heros_info.heros.find((hero) => hero.conf_id === skin.hero).system_skill_levels[2] = 7
            })
            const setup = party(f, [skin.hero])
            const hero = setup.heroes[0]
            let recreated
            f.client.onAck(11903, (client) => {
                recreated = client.recreate(hero.guid)
            })
            const before = f.state()
            const frames = f.call('HeroUpdateSkin', { hero_guid: hero.guid, skin_id: skin.clothingid })
            const battle = tables.find('hero_battle_info', skin.battleInfo)
            const ultimate = Number(
                battle.skillList
                    .split('|')
                    .find((token) => token.startsWith('4#'))
                    .split('#')[1],
            )
            assert.equal(recreated.clothingId, skin.clothingid)
            assert.equal(recreated.unitId, skin.unitId)
            assert.equal(recreated.skills.get(ultimate).skill_lv, 7)
            assert.deepEqual(f.state().player.group_mgrs, before.player.group_mgrs)
            f.edit((state) => {
                state.player.heros_info.battle_infos.find((info) => info.hero_id === hero.guid).sp = 100
            })
            assert.doesNotThrow(() => f.call('SkillStart', { unit_id: hero.guid, skill: { skill_id: ultimate } }))
            const stale = new ObtAppearanceConsumer(tables, protocol)
            stale.consumePackets([...f.initial, ...setup.packets])
            let old
            stale.onAck(11903, (client) => {
                old = client.recreate(hero.guid)
            })
            stale.consume(frames.find((packet) => packet.id === 11903))
            assert.notEqual(old.clothingId, skin.clothingid)
            f.call('HeroUpdateSkin', { hero_guid: hero.guid, skin_id: 0 })
            assert.equal(f.client.recreate(hero.guid).clothingId, skin.hero)
        }
    } finally {
        f.store.close()
    }
})
