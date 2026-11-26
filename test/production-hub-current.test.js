import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables, seedPlayer } from '../src/player.js'
import { ensureHome, ensureHomeFarmHouses } from '../src/home.js'
import { homeHubStationPets } from '../src/home-hub.js'
import { ranchWorkerLimit } from '../src/ranch.js'
import { registerProductionWorkers } from '../src/handlers/production-workers.js'
import { registerFarmWorkers } from '../src/handlers/farm-workers.js'
import { ErrorCode } from '../src/error-codes.js'
const tables = new Tables(configuration().tables)

function fixture(farm = false, full = false, ranchChosen = false) {
    const state = seedPlayer(tables, 1, 'current-hub-production'),
        home = ensureHome(tables, state),
        handlers = new Map()
    let building, station, workType
    if (farm) {
        building = tables
            .get('home_building')
            .find((row) =>
                tables.get('home_building_group').some((group) => group.groupId === row.groupId && group.type === 16),
            )
        workType = 1001
        station = {
            laborType: String(
                tables.get('home_labor_capacity').find((row) => row.laborCapacityId === workType).laborType,
            ),
        }
        registerFarmWorkers((name, handler) => handlers.set(name, handler), tables)
    } else {
        station = tables.get('home_building_production').find((row) => row.groupId === 9)
        building = tables.find('home_building', station.id)
        registerProductionWorkers((name, handler) => handlers.set(name, handler), tables)
    }
    const type = tables.get('home_building_group').find((row) => row.groupId === building.groupId).type
    const allowed = String(station.petSize ?? '')
        .split('|')
        .map(Number)
    const pet = state.pets.find(
        (row) => farm || allowed.includes(tables.find('pet_home_talent', row.config_id)?.sizeType),
    )
    assert(pet)
    pet.labor_infos = [{ labor_id: Number(String(station.laborType).split('|')[0]), labor_grade: 1 }]
    pet.work_status = ranchChosen ? 6 : 0
    pet.work_build = 0
    pet.hero_id = '0'
    home.builds = [
        {
            guid: 18,
            build_id: building.id,
            build_type: type,
            status: 1,
            locate: { block_id: 101, anchor: 6750237, direction: 0 },
            station_pet_guid: '0',
            product: [],
        },
    ]
    if (farm) ensureHomeFarmHouses(tables, state)
    state.world.map_id = Number(tables.get('game').find((row) => row.title === 'HOME_ID').value)
    const limit = ranchWorkerLimit(tables, state, 'worker_max')
    const hub = Array.from({ length: full ? limit : limit - 1 }, (_, i) => String(900000 + i))
    const ranchId = ranchChosen ? pet.guid : '800000'
    home.stationPets = [...hub, ranchId]
    home.ranches = { 101: { product_pets: [{ pet_guid: ranchId }], harvest_pet: '0' } }
    const c = { state, tables, now: 1800000000, pushBefore: () => {}, push: () => {} }
    const request = farm
        ? { build_guid: 18, pet_guid: pet.guid, work_type: workType }
        : { build_guid: 18, pet_guid: pet.guid, build_type: 1 }
    return { state, home, pet, limit, call: () => handlers.get(farm ? 'ChoseAutoWorkPet' : 'PetStationed')(c, request) }
}
for (const farm of [false, true]) {
    const label = farm ? 'farm' : 'production'
    test(`${label} ignores preserved ranch overlap when counting available hub slots`, () => {
        const f = fixture(farm)
        assert.equal(f.home.stationPets.length, f.limit)
        f.call()
        assert.equal(homeHubStationPets(f.state).length, f.limit)
        assert(f.home.stationPets.includes('800000'), 'historical unrelated ranch membership stays saved')
        assert.equal(f.home.ranches[101].product_pets[0].pet_guid, '800000')
        assert.equal(f.pet.work_build, 18)
    })
    test(`${label} cannot reuse its old ranch overlap to bypass an actually full hub`, () => {
        const f = fixture(farm, true, true),
            before = structuredClone(f.state)
        assert.throws(f.call, (error) => error.code === ErrorCode.HomeHubFull)
        // No dispatch mutation is performed before capacity checks.
        assert.deepEqual(f.state, before)
    })
}
