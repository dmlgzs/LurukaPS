import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { petModelFixture } from './pet-model-fixture.js'
import { petModelPresentation, petSyncPresentation } from '../src/pet-model-presentation.js'
import { ErrorCode } from '../src/error-codes.js'

const retiredIds = [
    500189, 500190, 500191, 500192, 500193, 500194, 500195, 500196, 500197, 500198, 500199, 500200, 500227, 500229,
    500230, 500835,
]
function insertLegacy(f, { defer = false, beforeIdentityMigration = false } = {}) {
    let legacy
    f.store.transact(
        f.session.id,
        0,
        (state) => {
            // Explicit pre-Phase2 mixed save: canonical pets may already have
            // been granted, while the old imported instances were not migrated.
            // Never insert legacy identities into a completed migration fixture.
            if (beforeIdentityMigration) delete state.petGuidMigration
            const template = state.pets.find((pet) => pet.config_id === 500001),
                hero = state.player.heros_info.heros.find((row) => row.type === 1)
            legacy = retiredIds.map((id, index) => ({
                ...structuredClone(template),
                config_id: id,
                guid: ((2n << 56n) | (BigInt(id) << 32n) | BigInt(810000 + index)).toString(),
                hero_id: '0',
                box_id: 0,
            }))
            legacy[0].hero_id = hero.guid
            state.pets.push(...legacy)
            hero.pet_id = legacy[0].guid
            const manager = state.player.group_mgrs.find((row) => row.type === 1),
                group = manager.groups.find((row) => row.id === manager.cur_group)
            group.heros[0] = { hero_id: hero.guid, pet_id: legacy[0].guid }
        },
        { defer },
    )
    return legacy
}
// Consumer contract simulation, not execution of the client or renderer.
// These are the two independently evidenced Lua failure preconditions:
// missing petTpl invokes errorf, and removal requires an existing box index.
function checkLuaPreconditions(tables, payload, visible = new Set()) {
    for (const pet of payload.pet_infos?.pets ?? []) {
        assert(tables.find('pet', pet.config_id), 'Lua syncPetItem missing config -> errorf')
        visible.add(String(pet.guid))
    }
    for (const id of payload.pet_infos?.guid ?? []) {
        assert(visible.has(String(id)), 'Lua removePet missing box index -> nil-index')
        visible.delete(String(id))
    }
    return visible
}
function packetPayloads(f, packets) {
    const entry = f.protocol.byName.get('CSProtoPetInfoSync')
    return packets
        .filter((packet) => packet.id === entry.id)
        .map((packet) => f.protocol.decode(entry.rsp, packet.payload))
}

test('known16 wire projection is pure and stable, filters add/delete references without unsafe tombstones, and retains release/history', () => {
    const f = petModelFixture('current-pet-model-pure')
    try {
        const legacy = insertLegacy(f),
            state = f.state(),
            legal = state.pets.find((pet) => pet.config_id === 500001),
            before = structuredClone(state),
            payload = {
                record_pets: [500189, 500001],
                free_reward_num: 17,
                last_free_time: 9,
                lock_box_id: [2],
                pet_infos: {
                    pets: [legal, ...legacy],
                    add_guid: [legal.guid, ...legacy.map((pet) => pet.guid)],
                    guid: ['99999', legacy[0].guid],
                },
            },
            raw = structuredClone(payload)
        assert.throws(() => checkLuaPreconditions(f.tables, payload), /missing config/)
        const projected = petModelPresentation(f.tables, state, payload)
        assert.deepEqual(projected.pet_infos.pets, [legal])
        assert.deepEqual(projected.pet_infos.add_guid, [legal.guid])
        assert.deepEqual(projected.pet_infos.guid, ['99999'])
        assert.deepEqual(projected.record_pets, payload.record_pets)
        assert.equal(projected.free_reward_num, 17)
        assert.deepEqual(projected.lock_box_id, [2])
        checkLuaPreconditions(f.tables, projected, new Set(['99999']))
        assert.deepEqual(petModelPresentation(f.tables, state, projected), projected)
        assert.deepEqual(state, before)
        assert.deepEqual(payload, raw)
    } finally {
        f.store.close()
    }
})

test('normal models tolerate unrelated catalog additions/problems but referenced corruption and unproven missing identities remain strict', () => {
    const f = petModelFixture('current-pet-model-boundary')
    try {
        const state = f.state(),
            legal = state.pets.find((pet) => pet.config_id === 500001),
            payload = { pet_infos: { pets: [legal] } },
            added = Object.create(f.tables)
        added.get = (name) =>
            name === 'pet'
                ? [...f.tables.get(name), { ...f.tables.find('pet', 500001), id: 9000000 }]
                : f.tables.get(name)
        assert.strictEqual(petModelPresentation(added, state, payload), payload)
        const ownedUnits = new Set(state.pets.map((pet) => f.tables.find('pet', pet.config_id).unitId)),
            unused = f.tables.get('pet').find((pet) => !ownedUnits.has(pet.unitId))
        assert(unused)
        const unrelated = Object.create(f.tables)
        unrelated.get = (name) =>
            name === 'unit'
                ? f.tables.get(name).map((row) => (row.id === unused.unitId ? { ...row, model: '' } : row))
                : f.tables.get(name)
        assert.strictEqual(petModelPresentation(unrelated, state, payload), payload)
        assert.throws(
            () => petModelPresentation(unrelated, state, { pet_infos: { pets: [{ ...legal, config_id: unused.id }] } }),
            (error) => error.code === ErrorCode.GameConfig,
        )
        assert.throws(
            () => petModelPresentation(f.tables, state, { pet_infos: { pets: [{ ...legal, config_id: 9000000 }] } }),
            (error) => error.code === ErrorCode.PetConfNotExist,
        )
        const broken = Object.create(f.tables)
        broken.get = (name) => (name === 'unit' ? [] : f.tables.get(name))
        assert.throws(
            () => petModelPresentation(broken, state, payload),
            (error) => error.code === ErrorCode.GameConfig,
        )
        const withLegacy = { ...state, pets: [...state.pets, { ...legal, config_id: retiredIds[0], guid: '99998' }] }
        assert.throws(
            () => petModelPresentation(added, withLegacy, payload),
            (error) => error.code === ErrorCode.GameConfig,
            'historical omission still requires the exact complete current identity evidence',
        )
    } finally {
        f.store.close()
    }
})

test('real task profiles prime both cold and existing caches before removal, including partial deltas and newly added hidden pets', () => {
    const f = petModelFixture('current-pet-model-task')
    try {
        const rank = f.tables.get('pet_rank')[0],
            base = f.state().pets.find((pet) => pet.config_id === rank.petId),
            selected = { ...base, guid: '100', config_id: rank.petId },
            other = { ...base, guid: '101', config_id: rank.petId },
            newHidden = { ...base, guid: '103', config_id: rank.petId },
            old = { guid: '102', config_id: retiredIds[0] },
            state = {
                tasks: [{ task_id: 106010, nodes: [{ node_id: 183, node_values: [0], client_cond_after: [false] }] }],
                taskPetChoices: { 106010: rank.petGroup },
                pets: [selected, other, newHidden, old],
                playableChoiceReceipts: { '106010:0:60001': { pet_group: rank.petGroup, pet_guid: selected.guid } },
            },
            payload = { pet_infos: { pets: [other, selected, newHidden, old] } },
            before = structuredClone(state)
        const nativeEvents = [],
            requests = []
        const nativeConsume = (value, cache) => {
            for (const pet of value.pet_infos.pets) {
                cache.add(String(pet.guid))
                nativeEvents.push({ event: 0, cache: [...cache] })
            }
            for (const id of value.pet_infos.guid ?? []) cache.delete(String(id))
            nativeEvents.push({ event: 1, cache: [...cache] })
            // Current PetPageRecoverySession0602f20c listens only to final1,
            // not intermediate refreshSinglePet0. Every fixture row shares
            // the actual rank group; only the final unique GUID is requested.
            if (cache.size === 1) requests.push([...cache][0])
            return cache
        }
        const full = petSyncPresentation(f.tables, state, payload)
        assert.deepEqual(full.pet_infos.guid, [other.guid, newHidden.guid])
        for (const hidden of [other, newHidden])
            assert.deepEqual(
                full.pet_infos.pets.find((pet) => pet.guid === hidden.guid),
                hidden,
            )
        assert.deepEqual([...checkLuaPreconditions(f.tables, full)], [selected.guid])
        assert.deepEqual([...nativeConsume(full, new Set())], [selected.guid])
        assert.deepEqual(
            nativeEvents[0],
            { event: 0, cache: [other.guid] },
            'an intermediate row can resemble the wrong unique target',
        )
        assert.deepEqual(requests, [selected.guid], 'the final-event listener selects only the post-removal target')
        assert.deepEqual(petSyncPresentation(f.tables, state, full), full)
        const partial = petSyncPresentation(f.tables, state, {
            pet_infos: { pets: [selected], add_guid: [selected.guid, newHidden.guid] },
        })
        assert.deepEqual(partial.pet_infos.add_guid, [selected.guid])
        for (const hidden of [other, newHidden])
            assert.deepEqual(
                partial.pet_infos.pets.find((pet) => pet.guid === hidden.guid),
                hidden,
            )
        assert.deepEqual(
            [...checkLuaPreconditions(f.tables, partial, new Set([selected.guid, other.guid]))],
            [selected.guid],
        )
        assert.deepEqual([...nativeConsume(partial, new Set([selected.guid, other.guid]))], [selected.guid])
        assert.deepEqual(requests, [selected.guid, selected.guid])
        assert.deepEqual(state, before)
    } finally {
        f.store.close()
    }
})

test('actual Game full login, ordinary delta, idle tick and reconnect retain all16 saved assets while every emitted model lookup is valid', () => {
    const f = petModelFixture('current-pet-model-game')
    try {
        const legacy = insertLegacy(f, { beforeIdentityMigration: true }),
            visible = new Set(),
            initial = f.call('EnterGame', { open_id: f.name }, {})
        const mapping = f.state().petGuidMigration.aliases,
            retainedGuids = new Set(legacy.flatMap((pet) => [pet.guid, mapping[pet.guid]]))
        const check = (packets) => {
            for (const payload of packetPayloads(f, packets)) {
                checkLuaPreconditions(f.tables, payload, visible)
                assert(!(payload.pet_infos?.pets ?? []).some((pet) => retiredIds.includes(pet.config_id)))
                assert(!(payload.pet_infos?.guid ?? []).some((id) => retainedGuids.has(id)))
            }
        }
        assert(packetPayloads(f, initial).length)
        check(initial)
        for (const pet of legacy)
            assert.deepEqual(
                f.state().pets.find((row) => row.guid === mapping[pet.guid]),
                { ...pet, guid: mapping[pet.guid], hero_id: '0' },
            )
        const before = f.state().pets.filter((pet) => retiredIds.includes(pet.config_id)),
            legal = f.state().pets.find((pet) => pet.config_id === 500001),
            hero = f.state().player.heros_info.heros.find((row) => row.type === 1)
        const delta = f.call('WearPet', { hero_guid: hero.guid, pet_guid: legal.guid })
        assert(packetPayloads(f, delta).length)
        check(delta)
        check(f.game.tick(f.session.id, f.session))
        check(f.call('EnterGame', { open_id: f.name }, {}))
        assert.deepEqual(
            f.state().pets.filter((pet) => retiredIds.includes(pet.config_id)),
            before,
        )
    } finally {
        f.store.close()
    }
})

test('actual Game projection encoding failure preserves saved pets/bindings and pending draft, then retry succeeds without model loss', () => {
    const f = petModelFixture('current-pet-model-codec'),
        encode = f.protocol.encode
    try {
        const legacy = insertLegacy(f, { defer: true, beforeIdentityMigration: true }),
            before = f.state(),
            pending = f.store.pending.get(f.session.id),
            disk = f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
            type = f.protocol.byName.get('CSProtoPetInfoSync').rsp
        f.protocol.encode = function (name, value) {
            if (name === type) throw Error('current-pet-model-wire-codec')
            return encode.call(this, name, value)
        }
        assert.throws(() => f.call('EnterGame', { open_id: f.name }, {}), /current-pet-model-wire-codec/)
        assert.deepEqual(f.state(), before)
        assert.strictEqual(f.store.pending.get(f.session.id), pending)
        assert.deepEqual(
            f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
            disk,
        )
        f.protocol.encode = encode
        const packets = f.call('EnterGame', { open_id: f.name }, {})
        for (const payload of packetPayloads(f, packets)) checkLuaPreconditions(f.tables, payload)
        assert.equal(f.state().pets.length, before.pets.length)
        const after = f.state()
        for (const pet of legacy) {
            const guid = after.petGuidMigration.aliases[pet.guid]
            assert(guid, 'cold migration records the real retained instance identity')
            assert.deepEqual(
                after.pets.find((row) => row.guid === guid),
                { ...pet, guid, hero_id: '0' },
            )
        }
    } finally {
        f.protocol.encode = encode
        f.store.close()
    }
})

test('current Lua source retains the diagnosed missing-config and unknown-removal failure branches', () => {
    const root = path.resolve(configuration().tables, '../Lua/src/src')
    const action = fs.readFileSync(path.join(root, 'ui/store/pet/petAction.lua'), 'utf8'),
        printer = fs.readFileSync(path.join(root, 'core/printf.lua'), 'utf8'),
        store = fs.readFileSync(path.join(root, 'ui/store/pet/petStore.lua'), 'utf8')
    assert.match(action, /if not pet_tpl then\s+errorf\(/)
    assert.match(printer, /function errorf\([\s\S]*?\berror\(message/)
    assert.match(store, /local index = self\.data\.petBoxIndex\[v\]\.index/)
    const page = fs.readFileSync(path.join(root, 'ui/pages/pet/pageGetPet.lua'), 'utf8')
    assert.doesNotMatch(page, /L_PetStore:(?:listenCallFunc|addListener)/)
    assert.match(page, /function page:close\([\s\S]*?self\._closeCallback\(\)/)
    assert.match(action, /self:call\(self\.event\.petLevelUp/)
    assert.match(action, /self:call\(self\.event\.refreshPet, entity\)/)
    assert.match(
        action,
        /self:syncPetItem\(info\.pets, info\.add_guid\)[\s\S]*?self:removePet\(info\.guid\)[\s\S]*?self:call\(self\.event\.refreshPetDatas\)/,
    )
})
