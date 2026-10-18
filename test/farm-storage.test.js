import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { grantRewards } from '../src/rewards.js'
import { ensureHomeFarmHouses } from '../src/home.js'
import { gridAnchor } from '../src/home-grid.js'
import { ErrorCode } from '../src/error-codes.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const config = configuration(),
    tables = new Tables(config.tables),
    protocol = new Protocol(config.base)
function fixture(file = ':memory:') {
    let now = 1800000000,
        seq = 1
    const store = new Store(file),
        game = new Game(protocol, store, tables, { clock: () => now, rng: (max) => max - 1 }),
        session = {}
    const call = (name, data = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, data) })
            .map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    }
    call('EnterGame', { open_id: 'farm-storage' })
    let workers
    store.transact(session.id, 0, (s) => {
        s.world.map_id = 701
        s.player.basic_info.lv = 30
        s.tasks = []
        s.taskRecords = tables
            .get('task')
            .filter((r) => r.type === 1)
            .map((r) => ({ task_id: r.id, count: 1, time: 1 }))
        s.home.builds.push({
            guid: 20,
            build_id: 20171,
            build_type: 16,
            status: 1,
            locate: { block_id: 101, anchor: gridAnchor(-50, -10), direction: 0 },
        })
        s.home.builds.push({
            guid: 100,
            build_id: 20161,
            build_type: 15,
            status: 1,
            locate: { block_id: 102, anchor: gridAnchor(-50, 10), direction: 0 },
            crop_info: { field_type: 1, water_num: 360, water_max: 360 },
        })
        ensureHomeFarmHouses(tables, s)
        const plant = s.pets.find((p) => p.config_id === 500023),
            water = s.pets.find((p) => p.config_id === 500002),
            harvest = s.pets.find((p) => p.guid !== plant.guid && p.labor_infos?.some((l) => l.labor_id === 5))
        workers = [plant, water, harvest].map((p) => p.guid)
        s.home.stationPets = workers
        for (const p of [plant, water, harvest])
            Object.assign(p, { work_status: 7, work_build: 0, capacity_id: 0, hero_id: '0' })
        grantRewards(tables, s, [
            { itemtype: 3, itemid: 310001, itemnum: 3 },
            { itemtype: 3, itemid: 310002, itemnum: 3 },
        ])
    })
    return {
        store,
        session,
        call,
        workers,
        advance: (n) => {
            now += n
        },
        state: () => store.load(session.id).state,
        hut: () => store.load(session.id).state.home.builds.find((b) => b.guid === 20),
    }
}
const bag = (s, id) => s.player.sbag_infos.items.filter((x) => x.itemid === id).reduce((n, x) => n + x.itemnum, 0)
const exp = (s) => BigInt(s.player.attr_infos.attrs.find((x) => x.attr_id === 1003)?.attr_val ?? 0)

test('crop settings and transplant preserve the sealed outcome instead of charging or rerolling it', () => {
    const f = fixture()
    try {
        f.call('FieldPlant', { plant_info: [{ build_guid: 100, seed_id: 310001 }] })
        f.call('FieldWater', { build_guid: 100 })
        const plan = f.state().home.cropOutcomes[100],
            seeds = bag(f.state(), 310001)
        f.call('HomeFieldOptionSet', { option_setting: 5 })
        assert.equal(f.state().home.cropOptions, 5)
        f.call('FieldReplant', {
            main_build: { guid: 100, locate: { block_id: 102, anchor: gridAnchor(-46, 10), direction: 0 } },
        })
        assert.equal(f.state().home.builds.find((b) => b.guid === 100).locate.anchor, gridAnchor(-46, 10))
        assert.deepEqual(f.state().home.cropOutcomes[100], plan)
        assert.equal(bag(f.state(), 310001), seeds)
    } finally {
        f.store.close()
    }
})

test('seed deposit, withdrawal and reorder preserve quantities and stable warehouse GUIDs', () => {
    const f = fixture()
    try {
        const before = bag(f.state(), 310001)
        f.call('QuickOperateSeedStore', {
            build_guid: 20,
            items: [
                { itemtype: 3, itemid: 310001, itemnum: 2 },
                { itemtype: 3, itemid: 310002, itemnum: 1 },
            ],
        })
        const [a, b] = f.hut().auto_info.seeds
        assert.notEqual(a.guid, b.guid)
        assert.equal(bag(f.state(), 310001), before - 2)
        f.call('ExchangeSeedLoc', { build_guid: 20, guid: a.guid, target_guid: b.guid })
        assert.equal(f.hut().auto_info.seeds[0].guid, b.guid)
        f.call('OperateSeedStorehouse', { build_guid: 20, operate_type: 2, seed: { ...a, itemnum: 1 } })
        assert.equal(bag(f.state(), 310001), before - 1)
        assert.equal(f.hut().auto_info.seeds.find((x) => x.guid === a.guid).itemnum, 1)
        const stable = f.state()
        assert.throws(
            () => f.call('OperateSeedStorehouse', { build_guid: 20, operate_type: 2, seed: { ...a, itemnum: 9 } }),
            (e) => e.code === ErrorCode.SeedNumNotEnough,
        )
        assert.deepEqual(f.state(), stable)
    } finally {
        f.store.close()
    }
})

test('assigned pets plant from storage, water and harvest into a pending bag, collected exactly once with home EXP', () => {
    const f = fixture()
    try {
        f.workers.forEach((guid, i) =>
            f.call('ChoseAutoWorkPet', { build_guid: 20, pet_guid: guid, work_type: 1001 + i }),
        )
        f.call('QuickOperateSeedStore', { build_guid: 20, items: [{ itemtype: 3, itemid: 310001, itemnum: 2 }] })
        const before = f.state()
        f.call('FieldPlant', { is_pet: true, plant_info: [{ build_guid: 100, seed_id: 310001 }] })
        assert.equal(bag(f.state(), 310001), bag(before, 310001))
        assert.equal(f.hut().auto_info.seeds[0].itemnum, 1)
        f.call('FieldWater', { is_pet: true, build_guid: 100 })
        const sealed = f.state().home.builds.find((b) => b.guid === 100).crop_info.drop_result
        assert.deepEqual(sealed.drop_ids, [1210011])
        f.call('WaterFinish', { is_pet: true, build_guid: 100 })
        const watered = f.state()
        f.call('WaterFinish', { is_pet: true, build_guid: 100 })
        assert.deepEqual(f.state(), watered)
        f.advance(900)
        f.call('FieldHarvest', { is_pet: true, build_guid: 100 })
        assert.equal(bag(f.state(), 400101), bag(before, 400101))
        assert.equal(exp(f.state()), exp(before))
        assert.ok(f.hut().auto_info.crops.some((x) => x.itemid === 400101 && x.itemnum === 4))
        const reply = f.call('GetAutoWorkCropReward', { u32: 20 }).find((p) => p.id === 6157).data
        assert.equal(reply.home_exp, 16)
        assert.equal(bag(f.state(), 400101) - bag(before, 400101), 4)
        assert.equal(exp(f.state()) - exp(before), 16n)
        assert.deepEqual(f.hut().auto_info.crops, [])
        assert.deepEqual(
            f.call('GetAutoWorkCropReward', { u32: 20 }).find((p) => p.id === 6157).data.reward.rewards,
            [],
        )
        assert.equal(bag(f.state(), 400101) - bag(before, 400101), 4)
    } finally {
        f.store.close()
    }
})

test('pet flags cannot bypass assignments or steal bag seeds and malformed quick deposits roll back', () => {
    const f = fixture()
    try {
        const stable = f.state()
        assert.throws(
            () => f.call('FieldPlant', { is_pet: true, plant_info: [{ build_guid: 100, seed_id: 310001 }] }),
            (e) => e.code === ErrorCode.BuildPetAutoWorkInvalid,
        )
        assert.deepEqual(f.state(), stable)
        assert.throws(
            () =>
                f.call('QuickOperateSeedStore', {
                    build_guid: 20,
                    items: [
                        { itemtype: 3, itemid: 310001, itemnum: 1 },
                        { itemtype: 3, itemid: 300000, itemnum: 1 },
                    ],
                }),
            (e) => e.code === ErrorCode.HomeSeedTypeError,
        )
        assert.deepEqual(f.state(), stable)
    } finally {
        f.store.close()
    }
})

test('SQLite restart retains seed identities, unclaimed crops and the exact sealed outcome', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'luruka-farm-persist-')),
        file = path.join(directory, 'save.sqlite')
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()))
    const f = fixture(file)
    let active = f.store
    try {
        f.call('QuickOperateSeedStore', { build_guid: 20, items: [{ itemtype: 3, itemid: 310001, itemnum: 1 }] })
        f.call('FieldPlant', { plant_info: [{ build_guid: 100, seed_id: 310001 }] })
        f.call('FieldWater', { build_guid: 100 })
        f.store.transact(f.session.id, 0, (s) => {
            s.home.builds.find((b) => b.guid === 20).auto_info.crops = [{ itemtype: 3, itemid: 400101, itemnum: 4 }]
        })
        const plan = f.state().home.cropOutcomes[100],
            seed = f.hut().auto_info.seeds[0]
        active.close()
        active = new Store(file)
        const game = new Game(protocol, active, tables, {
                clock: () => 1800000001,
                rng: () => {
                    throw Error('unexpected reroll')
                },
            }),
            session = {}
        const entry = protocol.byName.get('CSProtoEnterGame')
        game.dispatch(session, {
            id: entry.id,
            seq: 1,
            payload: protocol.encode(entry.req, { open_id: 'farm-storage' }),
        })
        const restored = active.load(session.id).state
        assert.deepEqual(restored.home.cropOutcomes[100], plan)
        assert.deepEqual(restored.home.builds.find((b) => b.guid === 20).auto_info.seeds[0], seed)
        assert.deepEqual(restored.home.builds.find((b) => b.guid === 20).auto_info.crops, [
            { itemtype: 3, itemid: 400101, itemnum: 4 },
        ])
    } finally {
        active.close()
        for (const suffix of ['', '-journal', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true })
        fs.rmdirSync(directory)
    }
})
