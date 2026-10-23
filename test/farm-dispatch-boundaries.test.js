import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ErrorCode } from '../src/error-codes.js'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { TaskGraphs, makeNode } from '../src/tasks.js'
import { guidedConditionValue } from '../src/guided-conditions.js'
import { ensureHomeFarmHouses } from '../src/home.js'
import { ranchWorkerLimit } from '../src/ranch.js'
const cfg = configuration(),
    protocol = new Protocol(cfg.base),
    tables = new Tables(cfg.tables)
function fixture(filename = ':memory:') {
    const store = new Store(filename),
        game = new Game(protocol, store, tables, { clock: () => 1800000000 }),
        session = {}
    let seq = 1
    const call = (name, r = {}, who = session) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(who, { id: e.id, seq: seq++, payload: protocol.encode(e.req, r) })
    }
    call('EnterGame', { open_id: 'farm-workers' })
    let water, plant, otherPlant, bad
    store.transact(session.id, 0, (state) => {
        state.world.map_id = 701
        state.player.basic_info.lv = 16
        state.taskEpochs[106015] = 1
        state.taskRecords = tables
            .get('task')
            .filter((row) => row.type === 1 && row.id !== 106015)
            .map((row) => ({ task_id: row.id, count: 1, time: 1 }))
        state.tasks = [
            {
                task_id: 106015,
                nodes: [{ ...makeNode(new TaskGraphs(tables).get(106015), 68, state), client_before: true }],
                finish_nodes: [1, 71, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 43, 73, 23, 62],
                reward_nodes: [],
                client_trace: true,
            },
        ]
        state.home.builds.push({
            guid: 20,
            build_id: 20171,
            build_type: 16,
            status: 1,
            locate: { block_id: 101, anchor: 6357009, direction: 3 },
        })
        state.home.inventory.push({ build_id: 20171, total_num: 1, used_num: 1, unlock: true })
        ensureHomeFarmHouses(tables, state)
        water = state.pets.find((p) => p.config_id === 500002)
        plant = state.pets.find((p) => p.config_id === 500023)
        otherPlant = state.pets.find((p) => p.guid !== plant.guid && p.labor_infos?.some((l) => l.labor_id === 5))
        bad = state.pets.find((p) => !p.labor_infos?.some((l) => l.labor_id === 5 || l.labor_id === 6))
        state.home.stationPets = [water.guid, plant.guid, otherPlant.guid]
        for (const p of [water, plant, otherPlant])
            Object.assign(p, { work_status: 7, work_build: 0, capacity_id: 0, hero_id: '0' })
    })
    return {
        tables,
        store,
        session,
        call,
        water: water.guid,
        plant: plant.guid,
        otherPlant: otherPlant.guid,
        bad: bad.guid,
        state: () => store.load(session.id).state,
        hut: () => store.load(session.id).state.home.builds.find((b) => b.guid === 20),
    }
}

const req = (pet) => ({ pet_guid: pet, work_type: 1001, build_guid: 20 })
test('6156 uses actual home-level worker capacity beyond the old five-pet ceiling', () => {
    const f = fixture()
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.home.level = 3
            s.home.stationPets = s.pets
                .filter((p) => p.guid !== f.plant)
                .slice(0, 5)
                .map((p) => p.guid)
            Object.assign(
                s.pets.find((p) => p.guid === f.plant),
                { work_status: 0, work_build: 0, capacity_id: 0 },
            )
        })
        assert.equal(f.state().home.stationPets.length, 5)
        const packets = f.call('ChoseAutoWorkPet', req(f.plant))
        assert.equal(f.hut().auto_info.plant_pet, f.plant)
        assert.equal(f.state().home.stationPets.length, 6)
        assert(packets.find((p) => p.id === 6102))
        const ack = packets.find((p) => p.id === 6156)
        assert(ack)
        assert.deepEqual(protocol.decode('cs.ProtoNullRsp', ack.payload), {})
        const stable = f.state()
        assert.deepEqual(
            f.call('ChoseAutoWorkPet', req(f.plant)).map((p) => p.id),
            [6156],
        )
        assert.deepEqual(f.state().home, stable.home)
        assert.deepEqual(f.state().pets, stable.pets)
    } finally {
        f.store.close()
    }
})
test('6156 full home hub rejects a new pet but outHub replacement releases one slot', () => {
    const f = fixture()
    try {
        f.call('ChoseAutoWorkPet', req(f.plant))
        f.store.transact(f.session.id, 0, (s) => {
            s.home.level = 1
            s.home.stationPets = [
                f.plant,
                ...s.pets
                    .filter((p) => p.guid !== f.plant && p.guid !== f.otherPlant)
                    .slice(0, 4)
                    .map((p) => p.guid),
            ]
            Object.assign(
                s.pets.find((p) => p.guid === f.otherPlant),
                { work_status: 0, work_build: 0, capacity_id: 0 },
            )
        })
        const before = f.state()
        assert.throws(
            () => f.call('ChoseAutoWorkPet', req(f.otherPlant)),
            (e) => e.code === ErrorCode.HomeHubFull,
        )
        assert.deepEqual(f.state(), before)
        f.call('ChoseAutoWorkPet', { ...req(f.otherPlant), out_hub: true })
        assert.equal(f.hut().auto_info.plant_pet, f.otherPlant)
        assert.equal(f.state().home.stationPets.length, 5)
        assert(!f.state().home.stationPets.includes(f.plant))
        assert.equal(f.state().pets.find((p) => p.guid === f.plant).work_status, 0)
    } finally {
        f.store.close()
    }
})
test('6156 exposes accurate errors and does not reinterpret unused legacy operateType', () => {
    const f = fixture()
    try {
        for (const [r, code] of [
            [{ ...req(f.plant), build_guid: 0 }, ErrorCode.HomeBuildGuidInvild],
            [{ ...req(f.plant), pet_guid: '18446744073709551615' }, ErrorCode.PetNotExist],
            [{ ...req(f.water) }, ErrorCode.PetLaborNotMatch],
            [{ ...req(f.plant), work_type: 999 }, ErrorCode.InvalidArgument],
            [{ ...req(f.plant), operate_type: 1 }, ErrorCode.InvalidProtoID],
        ]) {
            const before = f.state()
            assert.throws(
                () => f.call('ChoseAutoWorkPet', r),
                (e) => e.code === code,
            )
            assert.deepEqual(f.state(), before)
        }
        f.store.transact(f.session.id, 0, (s) => {
            s.world.map_id = 100
        })
        assert.throws(
            () => f.call('ChoseAutoWorkPet', req(f.plant)),
            (e) => e.code === ErrorCode.PlayerNotInHome,
        )
    } finally {
        f.store.close()
    }
})
test('6156 pet, home and acknowledgement encoding failures roll back dispatch and retry safely', () => {
    for (const failId of [6517, 6102, 6156]) {
        const f = fixture(),
            original = protocol.encode.bind(protocol)
        try {
            const before = f.state()
            const type = protocol.byId.get(failId).rsp
            protocol.encode = (name, value) => {
                if (name === type) throw Error('injected dispatch codec')
                return original(name, value)
            }
            assert.throws(() => f.call('ChoseAutoWorkPet', req(f.plant)), /injected dispatch codec/)
            assert.deepEqual(f.state(), before)
            protocol.encode = original
            f.call('ChoseAutoWorkPet', req(f.plant))
            assert.equal(f.hut().auto_info.plant_pet, f.plant)
        } finally {
            protocol.encode = original
            f.store.close()
        }
    }
})
test('6156 dispatch, transfer and withdrawal remain consistent after SQLite close and relogin', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'luruka-farm-dispatch-')),
        filename = path.join(dir, 'test.sqlite')
    let f
    try {
        f = fixture(filename)
        f.store.transact(f.session.id, 0, (s) => {
            s.home.level = 3
        })
        f.call('ChoseAutoWorkPet', req(f.plant))
        const id = f.session.id,
            guid = f.plant
        f.store.close()
        f = null
        const store = new Store(filename),
            game = new Game(protocol, store, tables),
            session = {}
        try {
            const e = protocol.byName.get('CSProtoEnterGame')
            game.dispatch(session, { id: e.id, seq: 900, payload: protocol.encode(e.req, { open_id: 'farm-workers' }) })
            assert.equal(session.id, id)
            const s = store.load(id).state
            assert.equal(s.home.builds.find((b) => b.guid === 20).auto_info.plant_pet, guid)
            assert.equal(s.pets.find((p) => p.guid === guid).capacity_id, 1001)
            assert(s.home.stationPets.includes(guid))
        } finally {
            store.close()
        }
    } finally {
        if (f) f.store.close()
        assert.equal(path.dirname(dir), path.resolve(tmpdir()))
        assert(path.basename(dir).startsWith('luruka-farm-dispatch-'))
        rmSync(dir, { recursive: true, force: true })
    }
})
test('6156 capacity helper follows all100 actual home levels and sums only unlocked free positions', () => {
    const f = fixture()
    try {
        const s = f.state(),
            rows = tables.get('home_level'),
            positions = tables.get('home_freeworkposition')
        assert.equal(rows.length, 100)
        assert.deepEqual(
            positions.map((row) => [row.num, row.unlockCondition]),
            [[5, '2004#1']],
        )
        for (const row of rows) {
            s.home.level = row.id
            assert.equal(ranchWorkerLimit(tables, s, 'worker_max'), row.worker_max + 5)
        }
        // Synthetic extra rows exercise the native foreach-add semantics rather
        // than treating the single current freework row as a maximum forever.
        const proxy = {
            find: (name, id) => tables.find(name, id),
            get: (name) =>
                name === 'home_freeworkposition'
                    ? [...positions, { num: 2, unlockCondition: '2004#17' }]
                    : tables.get(name),
        }
        s.home.level = 3
        s.player.basic_info.lv = 16
        assert.equal(ranchWorkerLimit(proxy, s, 'worker_max'), 7)
        s.player.basic_info.lv = 17
        assert.equal(ranchWorkerLimit(proxy, s, 'worker_max'), 9)
    } finally {
        f.store.close()
    }
})

test('6156 field/ranch transfers clear previous work slots, keep a single station slot and preserve the actual role', () => {
    const f = fixture()
    try {
        const initialStations = f.state().home.stationPets.length
        f.call('ChoseAutoWorkPet', req(f.plant))
        assert.equal(f.hut().auto_info.plant_pet, f.plant)
        f.call('RanchSetPetOption', { block_id: 201, slot: 1, pet_guid: f.plant, work_type: 1 })
        assert.equal(f.hut().auto_info.plant_pet, '0')
        assert(f.state().home.ranches[201].product_pets.some((row) => row.pet_guid === f.plant))
        f.call('ChoseAutoWorkPet', { ...req(f.plant), work_type: 1003 })
        assert(!f.state().home.ranches[201].product_pets.some((row) => row.pet_guid === f.plant))
        assert.equal(f.hut().auto_info.harvest_pet, f.plant)
        const worker = f.state().pets.find((p) => p.guid === f.plant)
        assert.equal(worker.work_status, 5)
        assert.equal(worker.capacity_id, 1003)
        assert.equal(worker.work_build, 20)
        assert.equal(f.state().home.stationPets.length, initialStations)
        assert.equal(f.state().home.stationPets.filter((id) => id === f.plant).length, 1)
    } finally {
        f.store.close()
    }
})

test('6156 distinguishes missing configuration, invalid readiness, wrong building type and a busy pet without mutating state', () => {
    const f = fixture()
    try {
        const originalGet = tables.get.bind(tables),
            originalFind = tables.find.bind(tables)
        const before = f.state()
        tables.find = (name, id) => (name === 'home_building' && id === 20171 ? undefined : originalFind(name, id))
        try {
            assert.throws(
                () => f.call('ChoseAutoWorkPet', req(f.plant)),
                (e) => e.code === ErrorCode.BuildConfNotFound,
            )
        } finally {
            tables.find = originalFind
        }
        assert.deepEqual(f.state(), before)
        tables.get = (name) => (name === 'home_building_group' ? [] : originalGet(name))
        try {
            assert.throws(
                () => f.call('ChoseAutoWorkPet', req(f.plant)),
                (e) => e.code === ErrorCode.BuildGroupConfNotFound,
            )
        } finally {
            tables.get = originalGet
        }
        assert.deepEqual(f.state(), before)
        for (const mutation of ['unplaced', 'building', 'busy']) {
            f.store.transact(f.session.id, 0, (s) => {
                const hut = s.home.builds.find((row) => row.guid === 20)
                if (mutation === 'unplaced') delete hut.locate
                if (mutation === 'building') hut.status = 2
                if (mutation === 'busy') s.pets.find((row) => row.guid === f.plant).work_status = 3
            })
            const bad = f.state()
            assert.throws(
                () => f.call('ChoseAutoWorkPet', req(f.plant)),
                (e) => e.code === (mutation === 'busy' ? ErrorCode.PetIsWorking : ErrorCode.HomeBuildInvalidStatus),
            )
            assert.deepEqual(f.state(), bad)
            f.store.transact(f.session.id, 0, (s) => {
                for (const key of Object.keys(s)) delete s[key]
                Object.assign(s, structuredClone(before))
            })
        }
        const groupId = tables.find('home_building', 20171).groupId
        tables.get = (name) =>
            name === 'home_building_group'
                ? originalGet(name).map((row) => (row.groupId === groupId ? { ...row, type: 2 } : row))
                : originalGet(name)
        try {
            assert.throws(
                () => f.call('ChoseAutoWorkPet', req(f.plant)),
                (e) => e.code === ErrorCode.BuildTypeNotMatch,
            )
        } finally {
            tables.get = originalGet
        }
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})
