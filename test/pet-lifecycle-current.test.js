import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { createEggs } from '../src/eggs.js'
import { ErrorCode } from '../src/error-codes.js'
import { enemyDefinition } from '../src/enemy-state.js'

const config = configuration(),
    tables = new Tables(config.tables),
    protocol = new Protocol(config.base)
function fixture() {
    let now = 1800000000,
        sequence = 1,
        guid
    const store = new Store(':memory:'),
        session = {},
        game = new Game(protocol, store, tables, { clock: () => now, rng: () => 0 })
    const call = (name, data) => {
        const entry = protocol.byName.get('CSProto' + name)
        assert(entry, 'current client protocol exists: ' + name)
        return game.dispatch(session, { id: entry.id, seq: sequence++, payload: protocol.encode(entry.req, data) })
    }
    call('EnterGame', { open_id: 'current-hatch-lifecycle' })
    store.transact(session.id, 0, (state) => {
        const groups = new Set(
            tables
                .get('home_building_group')
                .filter((row) => row.type === 12)
                .map((row) => row.groupId),
        )
        const build = tables
            .get('home_building')
            .find((row) => groups.has(row.groupId) && tables.find('home_building_production', row.id))
        guid = Math.max(...state.home.builds.map((row) => row.guid)) + 1
        state.home.builds.push({
            guid,
            build_id: build.id,
            build_type: 12,
            status: 1,
            locate: { block_id: 101, anchor: 6750238, direction: 0 },
        })
        state.petEggs = []
        createEggs(tables, state, 20004001, 2, () => 0)
    })
    const state = () => store.load(session.id).state
    return {
        store,
        session,
        game,
        call,
        guid,
        state,
        edit: (fn) => store.transact(session.id, 0, fn),
        advanceTo: (t) => (now = t),
    }
}

test('current 6506 / 6112 / 6111 hatch lifecycle retains cancelled outcomes and grants a single newborn with current data', () => {
    const f = fixture()
    try {
        f.call('HatchPetEgg', { build_guid: f.guid, egg_guid: 1 })
        f.call('HatchPetEgg', { build_guid: f.guid, egg_guid: 2 })
        const first = f.state().home.productionJobs[f.guid][0],
            outcome = f.state().eggOutcomes[1],
            seed = f.state().eggGenerationSeeds[1]
        assert.equal(f.state().petEggs[1].hatch_state, 1)
        f.call('ProductCancel', { guid: f.guid, product_guids: [first.guid] })
        assert.equal(f.state().petEggs[0].hatch_build_guid, 0)
        assert.equal(f.state().petEggs[1].hatch_state, 2)
        f.call('HatchPetEgg', { build_guid: f.guid, egg_guid: 1 })
        assert.equal(f.state().eggOutcomes[1], outcome)
        assert.deepEqual(f.state().eggGenerationSeeds[1], seed)
        const job = f.state().home.productionJobs[f.guid].find((row) => row.eggGuid === 1)
        f.advanceTo(job.start + job.seconds)
        const before = f.state().pets.length
        const packets = f.call('ProductFinish', { guid: f.guid, product_guids: [job.guid] })
        const result = protocol.decode(protocol.byId.get(6111).rsp, packets.find((row) => row.id === 6111).payload)
        const newborn = result.reward.rewards.find((row) => row.itemtype === 5)
        assert(newborn)
        const pet = f.state().pets.find((row) => row.guid === newborn.guid)
        assert.equal(pet.config_id, outcome)
        assert.equal(
            pet.satiety_val,
            Number(tables.get('game').find((row) => row.title === 'PET_SATIETY_BEGINNING_VALUE').value),
        )
        assert.equal(f.state().pets.length, before + 1)
        assert(!f.state().petEggs.some((row) => row.guid === 1))
        assert(packets.findIndex((row) => row.id === 6517) < packets.findIndex((row) => row.id === 6111))
        f.call('ProductFinish', { guid: f.guid, product_guids: [job.guid] })
        assert.equal(f.state().pets.length, before + 1)
        assert.equal(f.state().home.productionJobs[f.guid].filter((row) => row.eggGuid === 1).length, 0)
    } finally {
        f.store.close()
    }
})

test('saved egg locks remain enforced without erasing them or inventing a retired client request', () => {
    const f = fixture()
    try {
        assert(!protocol.byName.has('CSProtoPetEggLock'))
        f.edit((state) => (state.petEggs[0].lock_state = true))
        const before = f.state()
        assert.throws(
            () => f.call('HatchPetEgg', { build_guid: f.guid, egg_guid: 1 }),
            (error) => error.code === ErrorCode.EggIsLock,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})

test('an absent or already queued egg uses current dedicated business errors', () => {
    const f = fixture()
    try {
        assert.throws(
            () => f.call('HatchPetEgg', { build_guid: f.guid, egg_guid: 999999 }),
            (error) => error.code === ErrorCode.EggNotExist,
        )
        f.call('HatchPetEgg', { build_guid: f.guid, egg_guid: 1 })
        const before = f.state()
        assert.throws(
            () => f.call('HatchPetEgg', { build_guid: f.guid, egg_guid: 1 }),
            (error) => error.code === ErrorCode.EggInHatch,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})

test('current catchable enemy configuration supports preview, reserved card, owned pet and duplicate-result replay', () => {
    const f = fixture()
    const uuid = ((7n << 56n) | 912345n).toString()
    let petId, cardItem
    try {
        f.edit((state) => {
            state.tasks = []
            cardItem = tables.get('common_item').find((row) => row.type === 410 && row.subId > 0).id
            state.player.sbag_infos.items.push({ guid: '99912345', itemid: cardItem, itemtype: 3, itemnum: 1 })
            for (const pack of tables.get('enemy_pack')) {
                if (pack.uncatchableType === 1 || pack.specialCreateType === 1) continue
                const enemy = tables.find('enemy', pack.enemyId || pack.id)
                if (!enemy?.petId || !tables.find('pet', enemy.petId) || !tables.find('template_value', enemy.petId))
                    continue
                state.playableEnemies = {
                    [state.world.map_id + ':912345']: { entities: [{ uuid, config_id: pack.id, container: 912345 }] },
                }
                if (enemyDefinition(tables, state, uuid)) {
                    petId = enemy.petId
                    break
                }
            }
            assert(petId, 'current exported catchable source exists for the independent active-source fixture')
        })
        const query = f.call('GetCatchPetInfo', { tar_id: [uuid], day_weather: 1, reason: 1, pet_len_id: 0 })
        const notice = protocol.byName.get('CSProtoSyncCatchPetInfo')
        const preview = protocol.decode(notice.rsp, query.find((packet) => packet.id === notice.id).payload).pets[0]
        assert.equal(preview.uuid, uuid)
        const reserved = f.call('CatchPetCard', {
            item_id: cardItem,
            is_create: true,
            client_param: '12345',
        })
        const reserveProtocol = protocol.byName.get('CSProtoCatchPetCard')
        const card = protocol.decode(
            reserveProtocol.rsp,
            reserved.find((packet) => packet.id === reserveProtocol.id).payload,
        )
        const before = f.state().pets.length
        const request = { tar_id: uuid, item_id: cardItem, catch_key: card.catch_key, day_weather: 1 }
        const packets = f.call('CatchPet', request)
        const catchProtocol = protocol.byName.get('CSProtoCatchPet')
        const response = protocol.decode(
            catchProtocol.rsp,
            packets.find((packet) => packet.id === catchProtocol.id).payload,
        )
        assert.equal(response.success, true)
        assert.equal(f.state().pets.length, before + 1)
        const pet = f.state().pets.find((row) => row.guid === response.guid)
        assert.equal(pet.config_id, petId)
        assert.deepEqual(pet.comprehension, preview.comprehension)
        f.call('CatchPet', request)
        assert.equal(f.state().pets.length, before + 1)
    } finally {
        f.store.close()
    }
})

test('a completed egg stays queued and keeps its sealed outcome when the current pet storage is full', () => {
    const f = fixture()
    try {
        f.call('HatchPetEgg', { build_guid: f.guid, egg_guid: 1 })
        const job = f.state().home.productionJobs[f.guid][0]
        f.advanceTo(job.start + job.seconds)
        f.edit((state) => {
            const rows = tables.get('game'),
                max =
                    Number(rows.find((row) => row.title === 'PET_BOX_NUM').value) *
                    Number(rows.find((row) => row.title === 'PET_BOX_LIMIT').value)
            while (state.pets.length < max)
                state.pets.push({ ...state.pets[0], guid: String(990000 + state.pets.length), box_id: 0 })
        })
        const before = f.state()
        assert.throws(
            () => f.call('ProductFinish', { guid: f.guid, product_guids: [job.guid] }),
            (error) => error.code === ErrorCode.BagPetFullForHatch,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})
