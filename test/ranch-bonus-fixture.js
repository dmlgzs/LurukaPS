import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { createPets } from '../src/pets.js'
import { technologyState } from '../src/technology.js'
import { ranchPetDrops } from '../src/ranch.js'
import { selectedRanchBonuses } from '../src/ranch-bonus.js'
import assert from 'node:assert/strict'

export function ranchBonusFile() {
    const parent = path.resolve(os.tmpdir()),
        directory = fs.mkdtempSync(path.join(parent, 'ranch-bonus-b362-'))
    return {
        file: path.join(directory, 'player.sqlite'),
        close() {
            const resolved = path.resolve(directory)
            if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('ranch-bonus-b362-'))
                throw Error('Unsafe test cleanup')
            fs.rmSync(resolved, { recursive: true, force: true })
        },
    }
}
export function ranchBonusFixture(name, options = {}) {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base)
    let store = new Store(options.file ?? ':memory:'),
        now = 1800000000,
        seq = 1,
        roll = () => 0
    let game = new Game(protocol, store, tables, { clock: () => now, rng: (max) => roll(max) }),
        session = {}
    const call = (name, data = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, {
            id: entry.id,
            seq: seq++,
            payload: entry.req ? protocol.encode(entry.req, data) : Buffer.alloc(0),
        })
    }
    call('EnterGame', { open_id: name })
    let pets
    store.transact(session.id, 0, (state) => {
        state.world.map_id = Number(tables.get('game').find((row) => row.title === 'HOME_ID').value)
        state.player.basic_info.lv = 30
        // Legal saved story/level preconditions, not real research or bonus facts.
        state.taskRecords = [
            ...(state.taskRecords ?? []).filter((row) => row.task_id !== 106010),
            { task_id: 106010, count: 1 },
        ]
        pets = createPets(tables, state, 500001, options.pets ?? 3).map((pet) => pet.guid)
        for (const pet of state.pets.filter((pet) => pets.includes(pet.guid)))
            Object.assign(pet, {
                work_status: 0,
                work_build: 0,
                capacity_id: 0,
                labor_infos: [],
                talent_id: [],
                satiety_val: 10000,
            })
        technologyState(tables, state)
    })
    const state = () => store.load(session.id).state
    return {
        tables,
        protocol,
        pets,
        call,
        state,
        get store() {
            return store
        },
        get game() {
            return game
        },
        get session() {
            return session
        },
        edit(fn) {
            return store.transact(session.id, 0, fn)
        },
        now: () => now,
        elapse(seconds) {
            now += seconds
        },
        setRoll(fn) {
            roll = fn
        },
        assign(pet = pets[0], slot = 1, role = 1, block = 201) {
            return call('RanchSetPetOption', { block_id: block, slot, pet_guid: pet, work_type: role })
        },
        harvestWorker(block = 201) {
            store.transact(session.id, 0, (s) => {
                s.pets.find((pet) => pet.guid === pets[2]).labor_infos = [{ labor_id: 9, labor_grade: 1 }]
            })
            return call('RanchSetPetOption', { block_id: block, slot: 0, pet_guid: pets[2], work_type: 2 })
        },
        technologies(ids) {
            store.transact(session.id, 0, (s) => {
                for (const id of ids) {
                    const row = tables.find('home_technology', id)
                    s.home.technology.levels[row.type] = { level: row.level, lastTime: 0, isOpened: true }
                }
            })
        },
        tick() {
            return game.tick(session.id)
        },
        relogin() {
            session = {}
            return call('EnterGame', { open_id: name })
        },
        reopen() {
            if (!options.file) throw Error('SQLite fixture file required')
            store.close()
            store = new Store(options.file)
            game = new Game(protocol, store, tables, { clock: () => now, rng: (max) => roll(max) })
            session = {}
            return call('EnterGame', { open_id: name })
        },
        close() {
            store.close()
        },
    }
}

export function ranchProduction(f) {
    const state = f.state(),
        ranch = state.home.ranches[201],
        slot = ranch.product_pets[0],
        pet = state.pets.find((row) => row.guid === slot?.pet_guid)
    assert(slot && pet, 'Expected actual6162 producer')
    const rows = ranchPetDrops(f.tables, pet),
        period = slot.drop_times[0]?.seconds,
        units = rows.reduce((n, row) => n + row.minValue, 0),
        capacity = f.tables.get('home_ranch').find((row) => row.level === ranch.lv).petProductLimit
    assert(Number.isSafeInteger(period) && period > 0 && slot.drop_times.every((clock) => clock.seconds === period))
    assert(
        rows.every((row) => row.rate === 10000 && row.minValue === row.maxValue),
        'Current deterministic source contract changed',
    )
    return { period, units, capacity, rows }
}

// Actual current producer facts only: fill the real floor, then release enough
// base slots for both families to cross together at its final slot. No inserted floor/bonus.
export function earnRanchPending(f) {
    f.technologies([2204801, 2011301])
    f.assign()
    const { period, rows, capacity } = ranchProduction(f),
        read = () => f.state().home.ranches[201]
    assert(rows.every((row) => row.minValue === 1))
    f.elapse(period * Math.ceil(capacity / rows.length))
    f.tick()
    assert.equal(read().drops.length, capacity)
    while (read().bonus.pendingBonus.length) {
        const base = read().drops.find((row) => !row.bonus_source)
        assert(base)
        f.call('RanchPlayerGetReward', { block_id: 201, reward_guids: [base.guid] })
    }
    const definitions = [...selectedRanchBonuses(f.tables, f.state()).values()]
    assert.equal(definitions.length, 2)
    const credits = read().bonus.families,
        boundary = definitions.reduce((n, row) => n * row.threshold, 1)
    let needed = 1
    for (; needed <= boundary; needed++)
        if (definitions.every((row) => (credits[row.kind].creditUnits + needed) % row.threshold === 0)) break
    assert(needed <= boundary)
    const interim = definitions.reduce(
            (n, row) => n + Math.floor((credits[row.kind].creditUnits + needed) / row.threshold) - 1,
            0,
        ),
        free = needed + interim,
        selected = read()
            .drops.filter((row) => !row.bonus_source)
            .slice(0, free)
    assert.equal(selected.length, free)
    f.call('RanchPlayerGetReward', { block_id: 201, reward_guids: selected.map((row) => row.guid) })
    f.elapse(period * Math.ceil(needed / rows.length))
    f.tick()
    assert.equal(read().drops.length, capacity)
    assert.equal(read().bonus.pendingBonus.length, 2)
    return structuredClone(read().bonus.pendingBonus)
}
