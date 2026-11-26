import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { WorldObjectCatalog } from '../src/world-objects.js'
import { enemyDefinition } from '../src/enemy-state.js'
import {
    createPetFromSpecimen,
    customizedPetData,
    customizedPetRewardDefinition,
    petData,
    petGrade,
} from '../src/pets.js'
import { ErrorCode } from '../src/error-codes.js'

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
        if (this.modify?.[name]) return this.get(name).find((row) => row.id === Number(id))
        return super.find(name, id)
    }
}
function fixture(name, map, object, modify) {
    const tables = new ModifiedTables(modify),
        protocol = new Protocol(config.base),
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
    call('EnterGame', { open_id: 'custom-catch-' + name })
    const row = new WorldObjectCatalog(tables).find('worldmap_' + map, object)
    assert(row)
    const cardItem = tables.get('common_item').find((row) => row.type === 410 && row.subId > 0).id
    store.transact(session.id, 0, (state) => {
        state.tasks = []
        state.player.sbag_infos.items.push({ guid: '999987', itemid: cardItem, itemnum: 2, itemtype: 3 })
    })
    const point = tables.get('world_borthpos').find((point) => point.cityId === map)
    call('EnterWorldMap', { map_id: map, point_id: point.id })
    const uuid = ((3n << 56n) | BigInt(object)).toString(),
        decode = (name, packets) => {
            const entry = protocol.byName.get(name)
            return protocol.decode(entry.rsp, packets.find((packet) => packet.id === entry.id).payload)
        },
        query = () =>
            decode(
                'CSProtoSyncCatchPetInfo',
                call('GetCatchPetInfo', { tar_id: [uuid], day_weather: 1, reason: 1, pet_len_id: 7 }),
            ),
        reserve = () =>
            decode(
                'CSProtoCatchPetCard',
                call('CatchPetCard', { item_id: cardItem, is_create: true, client_param: '70001' }),
            ),
        catchOne = (key) => call('CatchPet', { tar_id: uuid, item_id: cardItem, catch_key: key, day_weather: 1 })
    return {
        tables,
        protocol,
        store,
        session,
        game,
        uuid,
        cardItem,
        row,
        call,
        decode,
        query,
        reserve,
        catchOne,
        state: () => store.load(session.id).state,
        snapshot: () => store.load(session.id),
        login: () => call('EnterGame', { open_id: 'custom-catch-' + name, reconnect: true }, {}),
    }
}
const customized = [
    { map: 102, object: 600008, enemy: 310369, custom: 5002971, base: 500297, pack: 310369 },
    { map: 100, object: 4500137, enemy: 311145, custom: 5001341, base: 500134, pack: 40311145 },
]
function assertSpecimen(pet, preview) {
    assert.equal(pet.grade, preview.grade)
    assert.deepEqual(pet.comprehension, preview.comprehension)
    assert.deepEqual(pet.gene_infos, preview.gene_infos)
}
function wireOwned(f, packets, guid) {
    const all = packets.filter((packet) => packet.id === f.protocol.byName.get('CSProtoPetInfoSync').id)
    return all
        .flatMap(
            (packet) => f.protocol.decode(f.protocol.byId.get(packet.id).rsp, packet.payload).pet_infos?.pets ?? [],
        )
        .find((pet) => pet.guid === guid)
}
function normalWorldObject(tables) {
    const world = new WorldObjectCatalog(tables)
    return world.get('worldmap_100').find((row) => {
        if (row.isstory || row.initStatus || tables.find('world_spawner', row.spawnerId)?.objectType !== 50)
            return false
        const group = tables.find('world_enemy_group', row.expandId),
            pack = tables.find('enemy_pack', Number(String(group?.enemyList ?? '').split('|')[0])),
            enemy = pack && tables.find('enemy', pack.enemyId || pack.id)
        return pack?.uncatchableType === 0 && enemy?.petCategory === 5 && tables.find('pet', enemy.petId)
    })
}

test('current map enemies310369/311145 resolve exact customized IDs and retain one published specimen through preview, card, catch and relog', () => {
    for (const source of customized) {
        const f = fixture('source-' + source.enemy, source.map, source.object)
        try {
            assert.equal(enemyDefinition(f.tables, f.state(), f.uuid).config_id, source.enemy)
            const before = f.state(),
                preview = f.query().pets[0],
                definition = customizedPetRewardDefinition(f.tables, source.custom),
                current = f.state()
            assert.equal(preview.uuid, f.uuid)
            assert.equal(preview.pet_len_id, 7)
            assert.equal(current.pets.length, before.pets.length)
            assert.equal(current.nextPetSequence, before.nextPetSequence)
            assert.deepEqual(current.recordPets, before.recordPets)
            assert.deepEqual(f.query().pets[0], preview)
            const card = f.reserve(),
                packets = f.catchOne(card.catch_key),
                result = f.decode('CSProtoCatchPet', packets),
                pet = f.state().pets.find((pet) => pet.guid === result.guid)
            assert.equal(result.success, true)
            assert.equal(result.rewards.rewards[0].itemtype, 5)
            assert.equal(result.rewards.rewards[0].itemid, source.base)
            assert.equal(pet.config_id, source.base)
            assert.equal(pet.customized_id, source.custom)
            assertSpecimen(pet, preview)
            const ownedWire = wireOwned(f, packets, pet.guid)
            assertSpecimen(ownedWire, preview)
            assert.equal(pet.grade, petGrade(f.tables, pet))
            assert.deepEqual(
                pet.gene_infos.map((gene) => gene.gene_id),
                definition.fixedGenes,
            )
            assert.deepEqual(
                pet.comprehension.map((row) => [row.attr_id, row.level]),
                definition.comprehensionRows.map((row) => [row.attr_id, row.level]),
            )
            assert.deepEqual(pet.labor_infos, definition.labor)
            assert.equal(pet.speed, definition.config.mountSpeed)
            assert.deepEqual(pet.talent_id, [definition.config.homeTalent])
            assert.equal(pet.can_not_release, definition.config.isRelease === 0)
            assert.deepEqual(ownedWire.labor_infos, definition.labor)
            assert.deepEqual(ownedWire.talent_id, [definition.config.homeTalent])
            assert.equal(ownedWire.speed, definition.config.mountSpeed)
            assert.equal(!!ownedWire.can_not_release, definition.config.isRelease === 0)
            assert.equal(f.state().petCatchCards[card.catch_key].state, 'used')
            assert.equal(f.state().combat.entities[f.uuid].captured, true)
            const count = f.state().pets.length
            const replay = f.decode('CSProtoCatchPet', f.catchOne(card.catch_key))
            assert.equal(replay.guid, pet.guid)
            assert.deepEqual(replay.rewards.rewards, [])
            assert.equal(f.state().pets.length, count)
            assertSpecimen(wireOwned(f, f.login(), pet.guid), preview)
        } finally {
            f.store.close()
        }
    }
})

test('normal current map catch also allocates the already published grade, genes and aptitudes without rerolling', () => {
    const tables = new Tables(config.tables),
        selected = normalWorldObject(tables)
    assert(selected)
    const f = fixture('normal', 100, selected.id)
    try {
        const preview = f.query().pets[0],
            card = f.reserve(),
            packets = f.catchOne(card.catch_key),
            result = f.decode('CSProtoCatchPet', packets),
            pet = f.state().pets.find((pet) => pet.guid === result.guid)
        assertSpecimen(pet, preview)
        assert.equal(pet.grade, petGrade(f.tables, pet))
        assertSpecimen(wireOwned(f, packets, pet.guid), preview)
    } finally {
        f.store.close()
    }
})

test('existing normal preview records keep their published attributes when upgraded to a complete specimen', () => {
    const tables = new Tables(config.tables),
        selected = normalWorldObject(tables),
        f = fixture('legacy-preview', 100, selected.id)
    try {
        const preview = f.query().pets[0],
            saved = f.state().petCatchPreviews[f.uuid]
        f.store.transact(f.session.id, 0, (state) => {
            state.petCatchPreviews[f.uuid] = {
                config_id: saved.config_id,
                grade: saved.grade,
                gene_infos: structuredClone(saved.gene_infos),
                comprehension: structuredClone(saved.comprehension),
            }
        })
        assert.deepEqual(f.query().pets[0], preview)
        assert(f.state().petCatchPreviews[f.uuid].profile)
        const card = f.reserve(),
            packets = f.catchOne(card.catch_key),
            result = f.decode('CSProtoCatchPet', packets)
        assertSpecimen(wireOwned(f, packets, result.guid), preview)
    } finally {
        f.store.close()
    }
})

test('uncatchable, mismatched category and missing customized configuration never consume a reserved card or create a pet', () => {
    for (const [name, modify, previewEmpty] of [
        [
            'uncatchable',
            { enemy_pack: (rows) => rows.map((row) => (row.id === 40311145 ? { ...row, uncatchableType: 1 } : row)) },
            true,
        ],
        [
            'category',
            { enemy: (rows) => rows.map((row) => (row.id === 311145 ? { ...row, petCategory: 5 } : row)) },
            false,
        ],
        ['missing', { pet_customized: (rows) => rows.filter((row) => row.id !== 5001341) }, false],
    ]) {
        const f = fixture(name, 100, 4500137, modify)
        try {
            const card = f.reserve(),
                before = f.snapshot()
            if (previewEmpty) assert.deepEqual(f.query().pets, [])
            else assert.throws(f.query, (error) => error.code === ErrorCode.GameConfig)
            const afterQuery = f.snapshot()
            assert.throws(() => f.catchOne(card.catch_key))
            assert.deepEqual(f.snapshot(), afterQuery)
            assert.equal(f.state().pets.length, before.state.pets.length)
            assert.equal(f.state().petCatchCards[card.catch_key].state, 'reserved')
        } finally {
            f.store.close()
        }
    }
})

test('preview and capture codec failures roll back specimen, GUID/catalog publication, card usage and target retirement atomically', () => {
    const f = fixture('codec', 100, 4500137),
        encode = f.protocol.encode.bind(f.protocol)
    try {
        const before = f.snapshot()
        f.protocol.encode = (name, value) => {
            if (name === f.protocol.byName.get('CSProtoSyncCatchPetInfo').rsp) throw Error('preview codec')
            return encode(name, value)
        }
        assert.throws(f.query, /preview codec/)
        assert.deepEqual(f.snapshot(), before)
        f.protocol.encode = encode
        const preview = f.query().pets[0],
            card = f.reserve(),
            reserved = f.snapshot()
        f.protocol.encode = (name, value) => {
            if (name === f.protocol.byName.get('CSProtoCatchPet').rsp) throw Error('capture codec')
            return encode(name, value)
        }
        assert.throws(() => f.catchOne(card.catch_key), /capture codec/)
        assert.deepEqual(f.snapshot(), reserved)
        f.protocol.encode = encode
        const packets = f.catchOne(card.catch_key),
            result = f.decode('CSProtoCatchPet', packets)
        assertSpecimen(
            f.state().pets.find((pet) => pet.guid === result.guid),
            preview,
        )
    } finally {
        f.protocol.encode = encode
        f.store.close()
    }
})

test('pure customized profiles and specimen allocation share creation rules without another builder roll', () => {
    const tables = new Tables(config.tables),
        profile = customizedPetData(tables, 5001341),
        normal = petData(tables, 500297, '0', 0),
        state = { pets: [], petBoxes: [], nextPetSequence: 1 },
        find = tables.find.bind(tables)
    tables.find = (name, id) => {
        assert.notEqual(name, 'pet_builder_rule', 'Allocation must not build another random specimen')
        return find(name, id)
    }
    const created = createPetFromSpecimen(tables, state, profile)
    assert.notEqual(created.guid, profile.guid)
    assert(created.box_id > 0)
    assert.equal(state.nextPetSequence, 2)
    assert.equal(state.pets.length, 1)
    assert.deepEqual(created.gene_infos, profile.gene_infos)
    assert.deepEqual(created.comprehension, profile.comprehension)
    assert.equal(createPetFromSpecimen(tables, state, normal).grade, normal.grade)
    assert.equal(state.pets.length, 2)
})
