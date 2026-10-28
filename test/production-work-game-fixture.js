import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { productionTables } from '../src/production-tables.js'
import { petModelEligibility } from '../src/pet-model-eligibility.js'
import reviewPolicy from '../configs/production-work-policy-review.json' with { type: 'json' }

export function productionWorkGameFixture(name, { satiety = 2, file = ':memory:', laborGrade = 1 } = {}) {
    const config = configuration(),
        tables = new Tables(config.tables),
        protocol = new Protocol(config.base),
        recipes = productionTables(tables),
        policy = structuredClone(reviewPolicy),
        homeMap = Number(tables.get('game').find((row) => row.title === 'HOME_ID').value)
    let now = 1800000000,
        seq = 1,
        session = {},
        store = new Store(file),
        game = new Game(protocol, store, tables, { clock: () => now, productionWorkPolicy: policy })
    const call = (name, request = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, request) })
    }
    const state = () => store.load(session.id).state
    call('EnterGame', { open_id: name })
    let worker
    store.transact(session.id, 0, (draft) => {
        draft.world.map_id = homeMap
        draft.tasks = []
        draft.taskRecords = tables.get('task').map((row) => ({ task_id: row.id, count: 1 }))
        draft.player.basic_info.lv = 30
        draft.home.level = 10
        draft.home.technology.levels[11005] = { level: 1, lastTime: 0 }
        const build = draft.home.builds.find((entry) => entry.guid === 1),
            station = tables.find('home_building_production', build.build_id),
            laborTypes = String(station.laborType).split('|').map(Number),
            sizes = String(station.petSize).split('|').map(Number)
        worker = draft.pets.find(
            (pet) =>
                (!pet.hero_id || pet.hero_id === '0') &&
                !pet.work_status &&
                petModelEligibility(tables, pet.config_id).eligible &&
                sizes.includes(tables.find('pet_home_talent', pet.config_id)?.sizeType) &&
                pet.labor_infos?.some((entry) => laborTypes.includes(entry.labor_id)),
        )
        assert(worker, 'Current seeded roster includes a legal unbound worker for the real workbench')
        Object.assign(worker, { satiety_val: satiety, talent_id: [] })
        worker.labor_infos = worker.labor_infos.map((entry) =>
            laborTypes.includes(entry.labor_id) ? { ...entry, labor_grade: laborGrade } : entry,
        )
        draft.home.builds.push({
            guid: 992951,
            build_id: 10011,
            build_type: 6,
            status: 1,
            locate: { block_id: 101, anchor: 7536681, direction: 0 },
            pet_canteen: { pets: [], foods: [], food_value: 0, food_extra_ids: [77], food_extra_values: [88] },
        })
        draft.player.sbag_infos.items = [
            { itemid: 300000, itemnum: 1000 },
            { itemid: 9002901, itemnum: 100 },
        ]
    })
    const workerGuid = worker.guid
    call('PetStationed', { pet_guid: workerGuid, build_guid: 1, build_type: 1 })
    return {
        tables,
        recipes,
        protocol,
        policy,
        workerGuid,
        file,
        homeMap,
        get store() {
            return store
        },
        get game() {
            return game
        },
        get session() {
            return session
        },
        state,
        call,
        edit: (fn) => store.transact(session.id, 0, fn),
        now: () => now,
        pet: () => state().pets.find((pet) => pet.guid === workerGuid),
        job: () => state().home.productionJobs?.[1]?.[0],
        canteen: () => state().home.builds.find((build) => build.guid === 992951).pet_canteen,
        bag: (id) =>
            state()
                .player.sbag_infos.items.filter((row) => row.itemid === id)
                .reduce((sum, row) => sum + row.itemnum, 0),
        start: (count = 5) => call('ProductStart', { build_guid: 1, product_id: 302001, count }),
        addFood: (count = 1) =>
            call('AddPetFood', {
                build_guid: 992951,
                operate_type: 1,
                items: [{ itemtype: 3, itemid: 9002901, itemnum: count }],
            }),
        advance: (seconds, tick = true) => {
            now += seconds
            return tick ? game.tick(session.id, session) : []
        },
        tick: () => game.tick(session.id, session),
        restart: () => {
            assert.notEqual(file, ':memory:', 'Restart verification requires an actual temporary SQLite file')
            store.close()
            store = new Store(file)
            session = {}
            seq = 1
            game = new Game(protocol, store, tables, { clock: () => now, productionWorkPolicy: policy })
            return call('EnterGame', { open_id: name })
        },
        close: () => store.close(),
    }
}
