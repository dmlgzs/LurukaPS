import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { grantRewards } from '../src/rewards.js'
import { ensureHomeFarmHouses } from '../src/home.js'
import { gridAnchor } from '../src/home-grid.js'

export function farmHarvestFixture(name, file = ':memory:', options = {}) {
    const tables = new Tables(configuration().tables),
        protocol = new Protocol(configuration().base),
        store = new Store(file),
        session = {}
    let now = options.now ?? 1800000000,
        seq = 1
    const high = (min, max) => (max === undefined ? min - 1 : max - 1)
    const game = new Game(protocol, store, tables, { clock: () => now, rng: high })
    const call = (name, request = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, {
            id: entry.id,
            seq: seq++,
            payload: entry.req ? protocol.encode(entry.req, request) : Buffer.alloc(0),
        })
    }
    call('EnterGame', { open_id: name })
    const edit = (fn) => store.transact(session.id, 0, fn),
        state = () => store.load(session.id).state
    if (!options.resume) {
        edit((s) => {
            s.player.basic_info.lv = 30
            s.tasks = []
            s.taskRecords = tables
                .get('task')
                .filter((row) => row.type === 1)
                .map((row) => ({ task_id: row.id, count: 1, time: 1 }))
            delete s.pendingTaskScene
            delete s.pendingTaskStorySync
            const definitions = tables.get('home_fieldtype')
            for (const [index, definition] of definitions.entries()) {
                const building = tables.find('home_building', definition.homeBuildingId),
                    type = tables.get('home_building_group').find((row) => row.groupId === building.groupId).type
                s.home.builds.push({
                    guid: 100 + index,
                    build_id: building.id,
                    build_type: type,
                    status: 1,
                    locate: { block_id: 102, anchor: gridAnchor(-50 + index * 6, 10), direction: 0 },
                    crop_info: { field_type: definition.id, water_num: 360, water_max: 360 },
                })
            }
            const house = tables
                .get('home_building')
                .find((row) =>
                    tables
                        .get('home_building_group')
                        .some((group) => group.groupId === row.groupId && group.type === 16),
                )
            s.home.builds.push({
                guid: 20,
                build_id: house.id,
                build_type: 16,
                status: 1,
                locate: { block_id: 101, anchor: gridAnchor(-50, -10), direction: 0 },
            })
            ensureHomeFarmHouses(tables, s)
        })
        call('EnterHome', { creator_id: session.id })
        call('ActivityGet')
        call('ActivityGet')
    }
    const field = (guid = 100) => state().home.builds.find((row) => row.guid === guid)
    const grow = (seedId, guid = 100, { seedReturn = false } = {}) => {
        const item = tables.get('common_item').find((row) => row.type === 310 && row.subId === seedId)
        if (!item) throw Error('Fixture requires an actual seed item')
        edit((s) => grantRewards(tables, s, [{ itemtype: 3, itemid: item.id, itemnum: 1 }]))
        call('FieldPlant', { plant_info: [{ build_guid: guid, seed_id: item.id }] })
        game.rng = seedReturn ? (min, max) => (max === undefined && min === 10000 ? 1000 : high(min, max)) : high
        call('FieldWater', { build_guid: guid })
        call('WaterFinish', { build_guid: guid })
        const crop = field(guid).crop_info
        now = Math.max(now, crop.state_finish_time + crop.pre_cost_time)
        game.rng = high
        return structuredClone(state().home.cropOutcomes[guid])
    }
    const harvest = (guid = 100, isPet = false) => call('FieldHarvest', { build_guid: guid, is_pet: isPet })
    const assign = (house = 20) => {
        const capacity = tables.get('home_labor_capacity').find((row) => row.laborCapacityId === 1003)
        const pet = state().pets.find(
            (row) =>
                (!row.work_status || [5, 7].includes(row.work_status)) &&
                row.labor_infos?.some((labor) => labor.labor_id === capacity.laborType && labor.labor_grade > 0),
        )
        if (!pet) throw Error('Fixture requires an actual available farm harvest worker')
        call('ChoseAutoWorkPet', { build_guid: house, work_type: 1003, pet_guid: pet.guid })
        return pet.guid
    }
    return {
        tables,
        protocol,
        store,
        session,
        game,
        state,
        edit,
        call,
        field,
        grow,
        harvest,
        assign,
        now: () => now,
        close: () => store.close(),
    }
}
