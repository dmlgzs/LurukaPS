import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PetTrackingCatalog, recordTrackingDeath, trackPet } from '../src/pet-tracking.js'
import { ErrorCode } from '../src/error-codes.js'
import { enemyDefinition } from '../src/enemy-state.js'
import { fixture, tables, world, cfg } from './world-detectors-fixture.js'
import { Protocol } from '../src/protocol.js'
import { Game } from '../src/game.js'
import { Store } from '../src/store.js'
import { createPets } from '../src/pets.js'
import { addItems } from '../src/inventory.js'
import { WorldObjectCatalog } from '../src/world-objects.js'

const data = JSON.parse(fs.readFileSync(new URL('../configs/pet-tracking.json', import.meta.url)))
const packMap = new Map(data.packs.map((r) => [r[0], r]))
const petMap = new Map(data.pets)
const validPack = (id) => {
    const p = packMap.get(id)
    return p && petMap.get(p[1]) === 1 && p[2] !== 1 && p[3] !== 1
}
const group = data.groups.find((r) => !r[1] && r[2].filter(validPack).length >= 2)
const slot = group[2].findIndex(validPack),
    packId = group[2][slot],
    pet = packMap.get(packId)[1]
const id = (object = 101, index = slot) => String((3n << 56n) | (BigInt(index) << 32n) | BigInt(object))
function unitWorld(extra = {}) {
    const rows = [101, 102].map((id, i) => ({
        id,
        cityId: 100,
        spawnerId: 99010,
        expandId: group[0],
        position: `${i * 10}|0|0`,
        initStatus: 0,
        ...extra,
    }))
    const w = {
        get: (name) => (name === 'worldmap_100' ? rows : []),
        find: (name, id) =>
            name === 'world_spawner' ? { id, objectType: id === 99017 ? 51 : 50 } : rows.find((r) => r.id === id),
        object: (map, id) => {
            const [x, y, z] = rows
                .find((r) => r.id === id)
                .position.split('|')
                .map((v) => Number(v) * 100)
            return { pos: { x, y, z } }
        },
    }
    return { rows, catalog: new PetTrackingCatalog(tables, w) }
}
const state = () => ({
    world: { map_id: 100, pos: { x: 0, y: 0, z: 0 } },
    player: { basic_info: { lv: 1 } },
    worldObjects: {},
    taskRecords: [],
})
const snapshot = (uid = id(), hp = 100) => ({
    world_indexes: [slot],
    monsters: [
        {
            uid,
            enemy_pack: packId,
            obj_key: { obj_index: slot },
            hp,
            alive_state: 0,
            move: { pos: { x: 100, y: 20, z: 30 } },
        },
    ],
})
const death = (s, uid = id()) =>
    recordTrackingDeath(tables, s, { uuid: uid, pack_id: packId, object_id: 101, slot }, 100)

test('fresh table index covers all species habitats instead of first enemy/pack match', () => {
    const c = new PetTrackingCatalog(tables)
    assert.equal(data.pets.length, 259)
    assert.equal(data.packs.length, 1047)
    assert.equal(c.byPet.size, 176)
    assert.equal(
        [...c.byPet.values()].reduce((n, r) => n + r.length, 0),
        2968,
    )
    assert([...c.byPet.values()].some((r) => new Set(r.map((x) => x.map)).size > 1))
    assert([...c.byPet.values()].flat().every((c) => c.row.cityId === c.map))
})
test('visibility, task conditions, explicit empty slots and omitted snapshot slots are authoritative', () => {
    const { catalog } = unitWorld({ appearCond: '2007#106010' }),
        s = state()
    assert.equal(catalog.targets(s, pet, 100).length, 0)
    s.taskRecords = [{ task_id: 106010, count: 1 }]
    assert(catalog.targets(s, pet, 100).length > 0)
    s.worldObjects['100:101'] = { active: false }
    s.worldObjects['100:102'] = { complete: true }
    assert.equal(catalog.targets(s, pet, 100).length, 0)
    s.worldObjects['100:101'] = { expand_data: { battle_group: { world_indexes: [], monsters: snapshot().monsters } } }
    assert.equal(catalog.targets(s, pet, 100).length, 0)
    s.worldObjects['100:101'].expand_data.battle_group = { world_indexes: [slot], monsters: [] }
    assert.equal(catalog.targets(s, pet, 100).length, 0)
})
test('unsupported appearance/disappearance conditions are hidden with one structured warning per expression', () => {
    const warnings = [],
        warn = console.warn
    console.warn = (message) => warnings.push(message)
    try {
        for (const field of ['appearCond', 'disappearCond']) {
            const expression = field === 'appearCond' ? '987654321#42' : '987654322#42'
            const { catalog, rows } = unitWorld(),
                s = state()
            assert(catalog.targets(s, pet, 100).length > 0)
            for (const row of rows) row[field] = expression
            for (let i = 0; i < 3; i++) assert.equal(catalog.targets(s, pet, 100).length, 0)
        }
        assert.equal(warnings.length, 2)
        for (const message of warnings) {
            assert(message.startsWith('[pet-tracking] '))
            const row = JSON.parse(message.slice('[pet-tracking] '.length))
            assert.equal(row.event, 'unsupported-condition')
            assert.equal(row.code, ErrorCode.FunctionClosed)
            assert.equal(row.map_id, 100)
            assert.equal(row.obj_id, 101)
            assert(['appearCond', 'disappearCond'].includes(row.field))
        }
    } finally {
        console.warn = warn
    }
})
test('malformed appearance, disappearance and random conditions propagate GameConfig instead of no-target', () => {
    for (const field of ['appearCond', 'disappearCond']) {
        const { catalog } = unitWorld({ [field]: '2007' }),
            s = state()
        assert.throws(
            () => catalog.targets(s, pet, 100),
            (e) => e.code === ErrorCode.GameConfig,
        )
    }
    const { catalog } = unitWorld({ spawnerId: 99017, expandId: 1 }),
        s = state()
    catalog.random.get(1).common = '2007'
    assert.throws(
        () => catalog.targets(s, pet, 100),
        (e) => e.code === ErrorCode.GameConfig,
    )
    catalog.random.get(1).common = '987654323#42'
    const warnings = [],
        warn = console.warn
    console.warn = (message) => warnings.push(message)
    try {
        const r = catalog.random.get(1),
            selected = [...r.normal][0],
            slots = catalog.groups.get(selected).slots
        const index = slots.findIndex(validPack)
        s.worldObjects['100:101'] = {
            expand_data: {
                random_battle_group: {
                    record_group_id: selected,
                    world_indexes: [index],
                    monsters: [
                        {
                            uid: id(101, index),
                            enemy_pack: slots[index],
                            obj_key: { obj_index: index },
                            hp: 100,
                            alive_state: 0,
                        },
                    ],
                },
            },
        }
        const species = packMap.get(slots[index])[1]
        r.common = ''
        assert.equal(catalog.targets(s, species, 100).length, 1)
        r.common = '987654323#42'
        assert.equal(catalog.targets(s, species, 100).length, 0)
        assert.equal(catalog.targets(s, species, 100).length, 0)
        assert.equal(warnings.length, 1)
        assert.equal(JSON.parse(warnings[0].slice('[pet-tracking] '.length)).field, 'commonCondition')
    } finally {
        console.warn = warn
    }
})
test('dead, captured and runtime-dead targets never reappear from static habitat slots', () => {
    const { catalog } = unitWorld(),
        s = state()
    s.worldObjects['100:102'] = { active: false }
    s.worldObjects['100:101'] = { expand_data: { battle_group: snapshot() } }
    assert.equal(catalog.targets(s, pet, 100).length, 1)
    s.petCaptureResults = { [id()]: { guid: '123' } }
    assert.equal(catalog.targets(s, pet, 100).length, 0)
    s.petCaptureResults = {}
    s.combat = { map_id: 100, entities: { [id()]: { hp: 0, alive_state: 1 } } }
    assert.equal(catalog.targets(s, pet, 100).length, 0)
    s.combat = { map_id: 102, entities: {} }
    assert(death(s))
    assert.equal(catalog.targets(s, pet, 200).length, 0)
    assert.equal(catalog.targets(s, pet, 1e10).length, 0)
})
test('death receipts clone borrowed draft branches and duplicate final blows or capture do not overwrite them', () => {
    const parent = state()
    assert(death(parent))
    const old = parent.petTrackingDeaths,
        draft = { ...parent }
    assert.equal(death(draft), false)
    assert.equal(draft.petTrackingDeaths, old)
    const uid = id(102)
    assert(recordTrackingDeath(tables, draft, { uuid: uid, pack_id: packId, object_id: 102, slot }, 101))
    assert.notEqual(draft.petTrackingDeaths, old)
    assert.notEqual(draft.petTrackingDeaths[100], old[100])
    assert.equal(old[100][uid], undefined)
    const captured = { ...draft, petCaptureResults: { [id(103)]: { guid: '123' } } }
    assert.equal(
        recordTrackingDeath(tables, captured, { uuid: id(103), pack_id: packId, object_id: 103, slot }, 102),
        false,
    )
    assert.equal(captured.petTrackingDeaths, draft.petTrackingDeaths)
})
test('elapsed timers, rewritten ordinary time and rebuilt positive template HP never override a confirmed death', () => {
    const { catalog } = unitWorld(),
        s = state()
    s.worldObjects['100:102'] = { active: false }
    s.worldObjects['100:101'] = { time: 90, next_time: 101, expand_data: { battle_group: snapshot() } }
    death(s)
    assert.equal(catalog.targets(s, pet, 200).length, 0)
    s.worldObjects['100:101'].time = 150
    s.worldObjects['100:101'].expand_data.battle_group.monsters[0].hp = 0
    assert.equal(catalog.targets(s, pet, 200).length, 0)
    s.worldObjects['100:101'].expand_data.battle_group.monsters[0].hp = 100
    assert.equal(catalog.targets(s, pet, 200).length, 0)
    assert.equal(death(s), false)
    // A separately identified actual live object is unaffected by another death.
    s.worldObjects['100:102'] = { time: 150, expand_data: { battle_group: snapshot(id(102)) } }
    assert.equal(catalog.targets(s, pet, 200).length, 1)
    s.worldObjects['100:102'] = { active: false }
    s.petCaptureResults = { [id()]: { guid: 'old-pet' } }
    assert.equal(catalog.targets(s, pet, 200).length, 0)
})
test('path habitats require an actual position and do not pretend the first waypoint has spawned', () => {
    const { catalog } = unitWorld({ expandParams: 'specialRandomBornPos#100099' }),
        s = state()
    assert.equal(catalog.targets(s, pet, 100).length, 0)
    s.worldObjects['100:101'] = { expand_data: { battle_group: snapshot() } }
    const found = catalog.targets(s, pet, 100)
    assert.equal(found.length, 1)
    assert.deepEqual(found[0].pos, { x: 100, y: 20, z: 30 })
})
test('random habitats use the actual positive-weight selected group and never draw during query', () => {
    const base = unitWorld(),
        random = [...base.catalog.random].find(([, r]) =>
            [...r.normal].some((g) => base.catalog.groups.get(g)?.slots.some(validPack)),
        )
    assert(random)
    const [randomId, r] = random,
        selected = [...r.normal].find((g) => base.catalog.groups.get(g)?.slots.some(validPack)),
        g = base.catalog.groups.get(selected)
    const index = g.slots.findIndex(validPack),
        pk = g.slots[index],
        species = packMap.get(pk)[1]
    const { catalog } = unitWorld({ spawnerId: 99017, expandId: randomId }),
        s = state()
    assert.equal(catalog.targets(s, species, 100).length, 0)
    s.worldObjects['100:101'] = {
        expand_data: {
            random_battle_group: {
                record_group_id: selected,
                world_indexes: [index],
                monsters: [
                    { uid: id(101, index), enemy_pack: pk, obj_key: { obj_index: index }, hp: 100, alive_state: 0 },
                ],
            },
        },
    }
    assert.equal(catalog.targets(s, species, 100).length, 1)
    s.worldObjects['100:101'].expand_data.random_battle_group.record_group_id = 0xffffffff
    assert.equal(catalog.targets(s, species, 100).length, 0)
})

function trackingFixture(file = ':memory:') {
    const f = fixture(1800007, file)
    f.edit((s) => {
        s.world.map_id = 100
        s.world.pos = { x: 0, y: 0, z: 0 }
        s.tasks = []
        s.worldObjects = {}
        s.combat = undefined
    })
    const c = new PetTrackingCatalog(tables),
        s = f.state()
    const choice = [...c.byPet]
        .flatMap(([pet]) =>
            c
                .targets(s, pet, 1800000000)
                .filter((r) => r.map_id === 100)
                .map((r) => ({ pet, ...r })),
        )
        .find((r) => enemyDefinition(tables, s, id(r.obj_id, r.slot)))
    assert(choice)
    f.edit((s) => {
        s.world.pos = { ...choice.pos }
    })
    return { ...f, choice, track: (ts = 123) => f.call('TrackPetReq', { pet_id: choice.pet, ts }) }
}
test('18052 malformed actual map condition fails read-only without packet, state, pending-parent or SQLite changes', () => {
    const f = trackingFixture(),
        get = WorldObjectCatalog.prototype.get
    try {
        // A separate table identity creates an independent tracking model; only
        // the data-reader seam replaces one actual row with damaged input.
        f.game.tables = Object.create(tables)
        WorldObjectCatalog.prototype.get = function (name) {
            const rows = get.call(this, name)
            return name === 'worldmap_100'
                ? rows.map((row) => (row.id === f.choice.obj_id ? { ...row, appearCond: '2007' } : row))
                : rows
        }
        f.store.transact(
            f.session.id,
            0,
            (s) => {
                s.petTrackingDeaths = { 100: { old: { time: 1 } } }
            },
            { defer: true, fork: (s) => ({ ...s }) },
        )
        const parent = f.store.pending.get(f.session.id).state,
            before = structuredClone(parent)
        const revision = f.store.playerById.get(f.session.id).revision,
            logs = f.store.db.prepare('SELECT count(*) AS n FROM request_log').get().n
        assert.throws(
            () => f.track(),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.equal(f.store.pending.get(f.session.id).state, parent)
        assert.deepEqual(parent, before)
        assert.deepEqual(f.state(), before)
        assert.equal(f.store.playerById.get(f.session.id).revision, revision)
        assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM request_log').get().n, logs)
    } finally {
        WorldObjectCatalog.prototype.get = get
        f.close()
    }
})
test('ordinary selected random catch propagates corrupt condition and conservatively logs unsupported predicates once', () => {
    const f = trackingFixture()
    try {
        const row = world.get('worldmap_100').find((r) => world.find('world_spawner', r.spawnerId)?.objectType === 51)
        assert(row)
        const random = tables.find('world_enemy_group_random', row.expandId),
            pool = random.enemyGroupRandom
        const groupId = Number(pool.split('#')[1].split(',')[0]),
            slots = String(tables.find('world_enemy_group', groupId).enemyList).split('|').map(Number)
        const slot = slots.findIndex(validPack),
            target = id(row.id, slot)
        assert(slot >= 0)
        f.edit((s) => {
            s.worldObjects['100:' + row.id] = {
                obj_id: row.id,
                active: true,
                expand_data: {
                    random_battle_group: {
                        record_group_id: groupId,
                        world_indexes: [slot],
                        monsters: [
                            {
                                uid: target,
                                enemy_pack: slots[slot],
                                obj_key: { obj_index: slot },
                                hp: 100,
                                alive_state: 0,
                            },
                        ],
                    },
                },
            }
        })
        const source = Object.create(tables)
        let expression = ''
        source.find = (name, id) => {
            const r = tables.find(name, id)
            return name === 'world_enemy_group_random' && id === row.expandId
                ? { ...r, commonCondition: expression }
                : r
        }
        f.game.tables = source
        assert(enemyDefinition(source, f.state(), target))
        expression = '2007'
        const before = f.state(),
            revision = f.store.playerById.get(f.session.id).revision
        assert.throws(
            () => f.call('GetCatchPetInfo', { tar_id: [target], reason: 1, day_weather: 2 }),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
        assert.equal(f.store.playerById.get(f.session.id).revision, revision)
        expression = '987654324#42'
        const warnings = [],
            warn = console.warn
        console.warn = (message) => warnings.push(message)
        try {
            assert.equal(enemyDefinition(source, f.state(), target), null)
            assert.equal(enemyDefinition(source, f.state(), target), null)
            assert.equal(warnings.length, 1)
            const logged = JSON.parse(warnings[0].slice('[pet-tracking] '.length))
            assert.equal(logged.field, 'commonCondition')
            assert.equal(logged.random_id, row.expandId)
        } finally {
            console.warn = warn
        }
    } finally {
        f.close()
    }
})
test('18052 empty ACK and 18053 use matched uint32 ts and centimeter position; nearest current-map object wins', () => {
    const f = trackingFixture()
    try {
        const before = f.state(),
            revision = f.store.playerById.get(f.session.id).revision,
            out = f.track(0xffffffff)
        assert(out.some((p) => p.id === 18052))
        const response = out.find((p) => p.id === 18053).data
        assert.equal(response.ts, 0xffffffff)
        assert.equal(response.map_id, 100)
        assert.equal(response.obj_id, f.choice.obj_id)
        assert.deepEqual(response.pos, f.choice.pos)
        assert.deepEqual(f.state().worldObjects, before.worldObjects)
        assert.deepEqual(f.state().petCaptureResults, before.petCaptureResults)
        assert.equal(f.store.playerById.get(f.session.id).revision, revision)
        assert.deepEqual(f.state(), before)
    } finally {
        f.close()
    }
})
test('unknown species and malformed ts fail without mutating state; known noncatchable species receives explicit no-target push', () => {
    const f = trackingFixture()
    try {
        const before = f.state()
        assert.throws(
            () => f.call('TrackPetReq', { pet_id: 0xffffffff, ts: 1 }),
            (e) => e.code === ErrorCode.PetConfNotExist,
        )
        assert.throws(
            () => f.track(0),
            (e) => e.code === ErrorCode.ParamError,
        )
        assert.deepEqual(f.state(), before)
        const non = data.pets.find((r) => r[1] !== 1)
        assert(non)
        const out = f.call('TrackPetReq', { pet_id: non[0], ts: 555 }),
            response = out.find((p) => p.id === 18053).data
        assert.equal(response.ts, 555)
        assert.equal(response.map_id ?? 0, 0)
        assert.equal(response.obj_id ?? 0, 0)
    } finally {
        f.close()
    }
})
test('valid catchable species with no currently eligible habitat receives the consumer no-target branch without writes', () => {
    const f = trackingFixture()
    try {
        const c = new PetTrackingCatalog(tables)
        f.edit((s) => {
            for (const candidate of c.byPet.get(f.choice.pet))
                s.worldObjects[candidate.map + ':' + candidate.row.id] = { active: false }
        })
        const before = f.state(),
            revision = f.store.playerById.get(f.session.id).revision
        const response = f.track(888).find((p) => p.id === 18053).data
        assert.equal(response.ts, 888)
        assert.equal(response.map_id ?? 0, 0)
        assert.equal(response.obj_id ?? 0, 0)
        assert.deepEqual(f.state(), before)
        assert.equal(f.store.playerById.get(f.session.id).revision, revision)
    } finally {
        f.close()
    }
})
test('current-map targets are selected by distance; unavailable current-map habitats fall back across maps deterministically', () => {
    const f = trackingFixture()
    try {
        const c = new PetTrackingCatalog(tables),
            s = f.state(),
            all = c.targets(s, f.choice.pet, 1800000000),
            other = all
                .filter((t) => t.map_id !== 100)
                .sort((a, b) => a.map_id - b.map_id || a.obj_id - b.obj_id || a.slot - b.slot)
        assert(other.length)
        f.edit((s) => {
            for (const t of all.filter((t) => t.map_id === 100)) s.worldObjects['100:' + t.obj_id] = { active: false }
        })
        const result = f.track().find((p) => p.id === 18053).data
        assert.equal(result.map_id, other[0].map_id)
        assert.equal(result.obj_id, other[0].obj_id)
        assert.deepEqual(result.pos, other[0].pos)
    } finally {
        f.close()
    }
})
test('an actual selected random-group target is previewed and caught once through existing owned-pet delivery', () => {
    const f = trackingFixture()
    try {
        const c = new PetTrackingCatalog(tables),
            s = f.state()
        let chosen
        for (const row of world
            .get('worldmap_100')
            .filter(
                (r) =>
                    world.find('world_spawner', r.spawnerId)?.objectType === 51 &&
                    !r.appearCond &&
                    !r.disappearCond &&
                    !r.initStatus,
            )) {
            const random = c.random.get(row.expandId),
                ids = random?.common && random.completed.size ? random.completed : random?.normal
            for (const groupId of ids ?? []) {
                const slots = c.groups.get(groupId)?.slots ?? []
                for (let slot = 0; slot < slots.length; slot++) {
                    if (!validPack(slots[slot])) continue
                    const uid = id(row.id, slot),
                        record = {
                            obj_id: row.id,
                            active: true,
                            time: 1799999999,
                            pos: { x: 123, y: 456, z: 789 },
                            expand_data: {
                                random_battle_group: {
                                    record_group_id: groupId,
                                    world_indexes: [slot],
                                    monsters: [
                                        {
                                            uid,
                                            enemy_pack: slots[slot],
                                            obj_key: { obj_index: slot },
                                            hp: 100,
                                            alive_state: 0,
                                            move: { pos: { x: 123, y: 456, z: 789 } },
                                        },
                                    ],
                                },
                            },
                        }
                    const trial = { ...s, worldObjects: { ...s.worldObjects, ['100:' + row.id]: record } }
                    if (enemyDefinition(tables, trial, uid)) {
                        chosen = { row, uid, record, pet: packMap.get(slots[slot])[1] }
                        break
                    }
                }
                if (chosen) break
            }
            if (chosen) break
        }
        assert(chosen)
        f.edit((s) => {
            s.world.pos = { x: 123, y: 456, z: 789 }
            s.worldObjects['100:' + chosen.row.id] = chosen.record
            addItems(s, [{ itemid: 1000001, itemnum: 1 }])
        })
        const tracked = f.call('TrackPetReq', { pet_id: chosen.pet, ts: 777 }).find((p) => p.id === 18053).data
        assert.equal(tracked.obj_id, chosen.row.id)
        const preview = f
            .call('GetCatchPetInfo', { tar_id: [chosen.uid], day_weather: 2, reason: 1 })
            .find((p) => p.id === 11031).data
        assert.equal(preview.pets.length, 1)
        const card = f
            .call('CatchPetCard', { item_id: 1000001, is_create: true, client_param: '998' })
            .find((p) => p.id === 11223).data
        const request = { tar_id: chosen.uid, item_id: 1000001, catch_key: card.catch_key, day_weather: 2 }
        const first = f.call('CatchPet', request).find((p) => p.id === 10714).data,
            amount = f.state().pets.length
        assert.equal(first.success, true)
        const second = f.call('CatchPet', request).find((p) => p.id === 10714).data
        assert.equal(first.guid, second.guid)
        assert.equal(f.state().pets.length, amount)
        assert.equal(f.state().pets.find((p) => p.guid === first.guid).config_id, chosen.pet)
        assert.equal(f.state().petTrackingDeaths?.[100]?.[chosen.uid], undefined)
        assert(
            !c.targets(f.state(), chosen.pet, 1800000000).some((t) => t.obj_id === chosen.row.id && t.map_id === 100),
        )
    } finally {
        f.close()
    }
})
test('actual pet final blow records death in deferred combat without immediate SQLite or request-log writes; repeated hit is idempotent', () => {
    const f = trackingFixture()
    try {
        f.edit((s) => createPets(tables, s, 500002, 1))
        const target = id(f.choice.obj_id, f.choice.slot),
            s = f.state(),
            def = enemyDefinition(tables, s, target),
            source = s.pets.at(-1).guid
        const revision = f.store.playerById.get(f.session.id).revision,
            logs = f.store.db.prepare('SELECT count(*) AS n FROM request_log').get().n
        const hit = () =>
            f.call('BattleInfoReduce', {
                uint64_dic: [source, target],
                battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -def.max_hp } }],
            })
        hit()
        const receipt = f.state().petTrackingDeaths?.[100]?.[target]
        assert(receipt)
        const pending = f.store.pending.get(f.session.id).state.petTrackingDeaths
        hit()
        assert.deepEqual(f.state().petTrackingDeaths[100][target], receipt)
        assert.equal(f.store.pending.get(f.session.id).state.petTrackingDeaths, pending)
        assert.equal(f.store.playerById.get(f.session.id).revision, revision)
        assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM request_log').get().n, logs)
    } finally {
        f.close()
    }
})
test('18053 encoding failure rolls back request state; death encoding failure does not leak into a borrowed pending parent', () => {
    const f = trackingFixture()
    try {
        const before = f.state(),
            encode = f.p.encode.bind(f.p)
        f.p.encode = (type, value) => {
            if (type === 'cs.CSTrackPetRsp') throw Error('track codec failure')
            return encode(type, value)
        }
        assert.throws(() => f.track(), /track codec failure/)
        assert.deepEqual(f.state(), before)
        f.p.encode = encode
        // Seed a deferred parent before the death to exercise borrowed nested maps.
        f.store.transact(
            f.session.id,
            0,
            (s) => {
                s.petTrackingDeaths = { 100: { seed: { time: 1 } } }
            },
            { defer: true, fork: (s) => ({ ...s }) },
        )
        const parent = f.store.pending.get(f.session.id).state,
            old = structuredClone(parent)
        const target = id(f.choice.obj_id, f.choice.slot),
            def = enemyDefinition(tables, parent, target),
            source = parent.player.heros_info.heros[0].guid
        f.p.encode = (type, value) => {
            if (type.includes('BattleInfoReduce')) throw Error('death codec failure')
            return encode(type, value)
        }
        assert.throws(
            () =>
                f.call('BattleInfoReduce', {
                    uint64_dic: [source, target],
                    battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -def.max_hp } }],
                }),
            /death codec failure/,
        )
        assert.deepEqual(parent, old)
        assert.equal(parent.petTrackingDeaths[100][target], undefined)
        assert.equal(f.store.pending.get(f.session.id).state, parent)
        f.p.encode = encode
    } finally {
        f.close()
    }
})
test('death receipts survive eviction, map switches, deferred flush and SQLite reopen', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luruka-track-b08-')),
        file = path.join(dir, 'players.sqlite'),
        f = trackingFixture(file)
    let store
    try {
        const target = id(f.choice.obj_id, f.choice.slot)
        f.store.transact(
            f.session.id,
            0,
            (s) => {
                recordTrackingDeath(
                    tables,
                    s,
                    {
                        uuid: target,
                        pack_id: enemyDefinition(tables, s, target).pack_id,
                        object_id: f.choice.obj_id,
                        slot: f.choice.slot,
                    },
                    1800000000,
                )
                s.combat = { map_id: 102, entities: {} }
                s.world.map_id = 102
            },
            { defer: true, fork: (s) => ({ ...s, world: { ...s.world } }) },
        )
        const receipt = f.state().petTrackingDeaths
        f.close()
        store = new Store(file)
        assert.deepEqual(store.load(f.session.id).state.petTrackingDeaths, receipt)
        const s = store.load(f.session.id).state
        s.world.map_id = 100
        const c = new PetTrackingCatalog(tables)
        assert(
            !c
                .targets(s, f.choice.pet, 1e10)
                .some((r) => r.map_id === 100 && r.obj_id === f.choice.obj_id && r.slot === f.choice.slot),
        )
    } finally {
        if (store) store.close()
        else if (f.store.db.open) f.close()
        const resolved = path.resolve(dir)
        assert(
            resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) &&
                path.basename(resolved).startsWith('luruka-track-b08-'),
        )
        fs.rmSync(resolved, { recursive: true, force: true })
    }
})
