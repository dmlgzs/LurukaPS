import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'
import { customizedPetAppearanceDefinition, customizedPetAppearance } from '../src/customized-pet-appearance.js'
import { createCustomizedPets, createPetFromSpecimen, customizedPetData, repairPetProfiles } from '../src/pets.js'

const config = configuration()
class ModifiedTables extends Tables {
    constructor(modify = {}) {
        super(config.tables)
        this.modify = modify
    }
    get(name) {
        const rows = super.get(name)
        return this.modify?.[name] ? this.modify[name](rows) : rows
    }
    find(name, id) {
        return this.modify?.[name] ? this.get(name).find((row) => row.id === Number(id)) : super.find(name, id)
    }
}
const freshState = () => ({ player: { basic_info: { id: 1 } }, pets: [], petBoxes: [], nextPetSequence: 1 })

function fixture(name, tables = new ModifiedTables()) {
    const protocol = new Protocol(config.base),
        store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => 1800000000 }),
        session = {}
    let seq = 1
    const call = (name, data = {}, target = session) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(target, {
            id: entry.id,
            seq: seq++,
            payload: entry.req ? protocol.encode(entry.req, data) : Buffer.alloc(0),
        })
    }
    const decode = (name, packets) => {
        const entry = protocol.byName.get('CSProto' + name),
            packet = packets.find((packet) => packet.id === entry.id)
        assert(packet, name)
        return protocol.decode(entry.rsp, packet.payload)
    }
    call('EnterGame', { open_id: 'custom-appearance-' + name })
    return {
        tables,
        protocol,
        store,
        session,
        call,
        decode,
        state: () => store.load(session.id).state,
        login: () => call('EnterGame', { open_id: 'custom-appearance-' + name, reconnect: true }, {}),
    }
}

test('all17 current fixed star-color templates produce table starcolorId values in real pet profiles and wire', () => {
    const tables = new ModifiedTables(),
        protocol = new Protocol(config.base)
    const rows = tables.get('pet_customized').filter((row) => row.starColorParam)
    assert.equal(rows.length, 17)
    for (const row of rows) {
        const expected = Number(row.starColorParam.split('#')[0]),
            definition = customizedPetAppearanceDefinition(tables, row),
            profile = customizedPetData(tables, row.id),
            before = structuredClone(profile),
            appearance = customizedPetAppearance(tables, definition, profile),
            wire = protocol.decode('cs.PetbaseInfo', protocol.encode('cs.PetbaseInfo', profile))
        assert.equal(definition.colorful, expected)
        assert.equal(profile.colorful, expected)
        assert.equal(wire.colorful, expected)
        const expectedSpecial = row.dna.split('|').some((id) => tables.find('pet_dna', Number(id)).rarity === 6) ? 5 : 4
        assert.equal(profile.special, expectedSpecial)
        assert.equal(wire.special, expectedSpecial)
        assert.equal(wire.config_id, row.petId)
        assert.equal(wire.customized_id, row.id)
        assert(tables.get('pet_color').some((color) => color.starcolorId === expected && color.id !== expected))
        assert.equal(profile.color, 0)
        assert.equal(appearance.colorful, expected)
        assert.deepEqual(profile, before, 'Appearance projection must not mutate a sealed profile')
        assert.equal(profile.wear_skin_id, undefined)
        assert.equal(profile.catch_item, undefined)
        assert.equal(profile.soul_link_level, undefined)
    }
    const normal = customizedPetData(tables, 5002971)
    assert.equal(normal.colorful, undefined)
    assert.equal(normal.catch_item, undefined, 'Unproven starlinkCard mapping must not emit a card')
})

test('special uses installed literal ordinary genes and current enum, with no guess for talent, missing genes or conflicting color', () => {
    const tables = new ModifiedTables(),
        config = tables.find('pet_customized', 5001341),
        profile = customizedPetData(tables, config.id),
        rare6 = tables.get('pet_dna').find((gene) => gene.rarity === 6),
        definition = customizedPetAppearanceDefinition(tables, config)
    assert(rare6)
    assert.equal(customizedPetAppearance(tables, definition, profile).special, 4)
    // Synthetic combinations of actual current gene rows isolate the predicate;
    // they are not assertions about the contents of an official template.
    const flashDefinition = customizedPetAppearanceDefinition(tables, { ...config, dna: String(rare6.id) }),
        flash = { color: 0, gene_infos: [...new Set([rare6.id, config.talentDna])].map((gene_id) => ({ gene_id })) }
    assert.equal(customizedPetAppearance(tables, flashDefinition, flash).special, 5)
    const independentTalent = customizedPetAppearanceDefinition(tables, { ...config, talentDna: rare6.id })
    assert.equal(
        customizedPetAppearance(tables, independentTalent, {
            ...profile,
            gene_infos: [
                ...profile.gene_infos.filter((gene) => gene.gene_id !== config.talentDna),
                { gene_id: rare6.id },
            ],
        }).special,
        4,
    )
    for (const [source, pet] of [
        [definition, { ...profile, color: 1 }],
        [definition, { ...profile, gene_infos: [] }],
        [definition, { ...profile, gene_infos: [...profile.gene_infos, { gene_id: 0xffffffff }] }],
        [
            definition,
            {
                ...profile,
                gene_infos: [
                    ...profile.gene_infos,
                    {
                        gene_id: tables
                            .get('pet_dna')
                            .find((gene) => !profile.gene_infos.some((owned) => owned.gene_id === gene.id)).id,
                    },
                ],
            },
        ],
        [customizedPetAppearanceDefinition(tables, { ...config, dnaType: 0 }), profile],
    ]) {
        const before = structuredClone(pet),
            appearance = customizedPetAppearance(tables, source, pet)
        assert.equal(appearance.colorful, 1007)
        assert.equal(appearance.special, undefined)
        assert.deepEqual(pet, before)
    }
    const higher = new ModifiedTables({
        pet_dna: (rows) => rows.map((gene) => (gene.id === rare6.id ? { ...gene, rarity: 7 } : gene)),
    })
    assert.equal(
        customizedPetAppearance(higher, flashDefinition, flash).special,
        4,
        'Current predicate is equality6, not highest rarity',
    )
})

test('invalid or unsupported appearance rejects before any pet allocation, slots or acquisition counters change', () => {
    for (const [patch, code] of [
        [{ starColorParam: '1007#100#1' }, ErrorCode.GameConfig],
        [{ starColorParam: '1007#no' }, ErrorCode.GameConfig],
        [{ starColorParam: '1007#50|1008#50' }, ErrorCode.FunctionClosed],
        [{ starColorParam: '1007#99' }, ErrorCode.FunctionClosed],
        [{ starColorParam: '999999#100' }, ErrorCode.GameConfig],
        [{ petskin: 100001 }, ErrorCode.FunctionClosed],
        [{ lightParam: 1 }, ErrorCode.FunctionClosed],
        [{ lightParam: -1 }, ErrorCode.GameConfig],
        [{ colorParam: '1#100' }, ErrorCode.FunctionClosed],
        [{ colorParam: 'malformed' }, ErrorCode.GameConfig],
    ]) {
        const tables = new ModifiedTables({
                pet_customized: (rows) => rows.map((row) => (row.id === 5001341 ? { ...row, ...patch } : row)),
            }),
            state = freshState(),
            before = structuredClone(state)
        assert.throws(
            () => createCustomizedPets(tables, state, 5001341, 2),
            (error) => error.code === code,
        )
        assert.deepEqual(state, before)
    }
    for (const transform of [
        (rows) => rows.filter((row) => row.starcolorId !== 1007),
        (rows) => [...rows, { ...rows.find((row) => row.starcolorId === 1007), id: 999 }],
    ]) {
        const tables = new ModifiedTables({ pet_color: transform }),
            state = freshState()
        assert.throws(
            () => createCustomizedPets(tables, state, 5001341, 1),
            (error) => error.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(state, freshState())
    }
})

test('new reward allocation keeps fixed appearance through repetition, saved-state load, wire and login without resetting owned visuals', () => {
    const f = fixture('save-owned')
    try {
        let createdGuid, ownedGuid, skinGuid
        f.store.transact(f.session.id, 0, (state) => {
            const existing = state.pets.find((pet) => pet.config_id === 500134),
                skin = f.tables.get('pet_skin')[0],
                dressed = state.pets.find((pet) => pet.config_id === skin.kiboId)
            assert(existing && dressed)
            existing.color = 1
            existing.colorful = 1015
            existing.special = 4
            existing.customized_id = 5001341
            dressed.wear_skin_id = skin.id
            state.petSkins = [skin.id]
            ownedGuid = existing.guid
            skinGuid = dressed.guid
            const [first, second] = createCustomizedPets(f.tables, state, 5001341, 2)
            assert.equal(first.colorful, 1007)
            assert.equal(second.colorful, 1007)
            assert.notEqual(first.guid, second.guid)
            createdGuid = first.guid
        })
        const before = f.state(),
            expected = structuredClone(before.pets.find((pet) => pet.guid === createdGuid)),
            synced = f.decode('PetInfoSync', f.login()).pet_infos.pets
        assert.equal(synced.find((pet) => pet.guid === createdGuid).colorful, 1007)
        const after = f.state()
        assert.deepEqual(
            after.pets.find((pet) => pet.guid === createdGuid),
            expected,
        )
        assert.equal(after.pets.find((pet) => pet.guid === ownedGuid).colorful, 1015)
        assert.equal(after.pets.find((pet) => pet.guid === ownedGuid).color, 1)
        assert.equal(
            after.pets.find((pet) => pet.guid === skinGuid).wear_skin_id,
            before.pets.find((pet) => pet.guid === skinGuid).wear_skin_id,
        )
        assert.deepEqual(after.petSkins, before.petSkins)
        const repaired = structuredClone(after)
        repairPetProfiles(f.tables, repaired)
        repairPetProfiles(f.tables, repaired)
        assert.deepEqual(
            repaired.pets.find((pet) => pet.guid === ownedGuid),
            after.pets.find((pet) => pet.guid === ownedGuid),
        )
        assert.equal(
            repaired.pets.find((pet) => pet.guid === skinGuid).wear_skin_id,
            after.pets.find((pet) => pet.guid === skinGuid).wear_skin_id,
        )
    } finally {
        f.store.close()
    }
})

test('real current customized catch seals appearance once and retains it across preview repetition, allocation, replay and relog', () => {
    const tables = new ModifiedTables(),
        f = fixture('sealed-catch', tables)
    try {
        const point = tables.get('world_borthpos').find((point) => point.cityId === 100),
            uuid = ((3n << 56n) | 4500137n).toString(),
            cardItem = 1000001
        f.store.transact(f.session.id, 0, (state) => {
            state.tasks = []
            state.player.sbag_infos.items.push({ guid: '999987', itemid: cardItem, itemnum: 2, itemtype: 3 })
        })
        f.call('EnterWorldMap', { map_id: 100, point_id: point.id })
        const query = () => f.call('GetCatchPetInfo', { tar_id: [uuid], day_weather: 1, reason: 1 })
        query()
        const sealed = structuredClone(f.state().petCatchPreviews[uuid].profile)
        assert.equal(sealed.colorful, 1007)
        assert.equal(sealed.special, 4)
        // Synthetic source drift checks that an accepted preview is authoritative;
        // it does not claim this alternate color is the official template value.
        tables.modify.pet_customized = (rows) =>
            rows.map((row) => (row.id === 5001341 ? { ...row, starColorParam: '1010#100' } : row))
        query()
        assert.deepEqual(f.state().petCatchPreviews[uuid].profile, sealed)
        const card = f.decode(
                'CatchPetCard',
                f.call('CatchPetCard', { item_id: cardItem, is_create: true, client_param: '70123' }),
            ),
            request = { tar_id: uuid, item_id: cardItem, catch_key: card.catch_key, day_weather: 1 },
            packets = f.call('CatchPet', request),
            result = f.decode('CatchPet', packets),
            owned = f.state().pets.find((pet) => pet.guid === result.guid)
        assert.equal(result.success, true)
        assert.equal(owned.colorful, 1007)
        assert.equal(owned.special, sealed.special)
        assert.deepEqual(owned.gene_infos, sealed.gene_infos)
        const count = f.state().pets.length
        assert.equal(f.decode('CatchPet', f.call('CatchPet', request)).guid, owned.guid)
        assert.equal(f.state().pets.length, count)
        const loginWire = f.decode('PetInfoSync', f.login()).pet_infos.pets.find((pet) => pet.guid === owned.guid)
        assert.equal(loginWire.colorful, 1007)
        const plain = freshState(),
            find = tables.find.bind(tables)
        tables.find = (name, id) => {
            assert.notEqual(name, 'pet_builder_rule', 'Sealed allocation must not roll a fresh profile')
            return find(name, id)
        }
        assert.equal(createPetFromSpecimen(tables, plain, sealed).colorful, 1007)
    } finally {
        f.store.close()
    }
})
