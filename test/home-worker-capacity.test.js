import test from 'node:test'
import assert from 'node:assert/strict'
import { Tables } from '../src/player.js'
import { configuration } from '../src/config.js'
import { ranchWorkerLimit } from '../src/ranch.js'
import { ErrorCode } from '../src/error-codes.js'
import { Store } from '../src/store.js'
import { Protocol } from '../src/protocol.js'
import { Game } from '../src/game.js'
import { createPets } from '../src/pets.js'

const tables = new Tables(configuration().tables)
const title = 'HOME_KIBO_WORK_MANAGE_POSITION'
function source(change = (rows) => rows, levelChange = (row) => row) {
    return {
        get(name) {
            assert.notEqual(name, 'home_freeworkposition')
            const rows = tables.get(name)
            return name === 'game' ? change(rows) : rows
        },
        find(name, id) {
            assert.notEqual(name, 'home_freeworkposition')
            const row = tables.find(name, id)
            return name === 'home_level' ? levelChange(row) : row
        },
    }
}

test('all 100 current home levels use their distinct worker and pasture limits plus the current explicit constant', () => {
    const extra = Number(tables.get('game').find((row) => row.title === title).value)
    for (const row of tables.get('home_level')) {
        const state = { home: { level: row.id } },
            before = structuredClone(state)
        assert.equal(ranchWorkerLimit(source(), state, 'worker_max'), row.worker_max + extra)
        assert.equal(ranchWorkerLimit(source(), state), row.pasture_woker_max + extra)
        assert.deepEqual(state, before)
    }
    assert.equal(ranchWorkerLimit(tables, { home: { level: 1 } }, 'worker_max'), 5)
    assert.equal(ranchWorkerLimit(tables, { home: { level: 1 } }), 12)
})

test('a nonzero current work-position constant applies to both actual client capacity functions', () => {
    const changed = source((rows) => rows.map((row) => (row.title === title ? { ...row, value: '3' } : row)))
    const state = { home: { level: 1 }, taskRecords: [{ task_id: 1, count: 999 }] }
    assert.equal(ranchWorkerLimit(changed, state, 'worker_max'), 8)
    assert.equal(ranchWorkerLimit(changed, state), 15)
})

test('a missing, duplicate or malformed current capacity source fails instead of silently adding zero', () => {
    const state = { home: { level: 1 } }
    for (const change of [
        (rows) => rows.filter((row) => row.title !== title),
        (rows) => [...rows, rows.find((row) => row.title === title)],
        ...[undefined, '', '-1', 'NaN', '1.5', '4294967295'].map(
            (value) => (rows) => rows.map((row) => (row.title === title ? { ...row, value } : row)),
        ),
    ])
        assert.throws(
            () => ranchWorkerLimit(source(change), state),
            (error) => error.code === ErrorCode.GameConfig,
        )
    for (const row of [undefined, { worker_max: -1 }, { worker_max: NaN }, { worker_max: '5' }])
        assert.throws(
            () =>
                ranchWorkerLimit(
                    source(undefined, () => row),
                    state,
                    'worker_max',
                ),
            (error) => error.code === ErrorCode.GameConfig,
        )
})

test('the current hub protocol enforces its exact table capacity and preserves existing workers on rejection', () => {
    const store = new Store(':memory:'),
        protocol = new Protocol(configuration().base),
        game = new Game(protocol, store, tables),
        session = {}
    let sequence = 1
    const call = (name, data) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: entry.id, seq: sequence++, payload: protocol.encode(entry.req, data) })
    }
    try {
        call('EnterGame', { open_id: 'current-home-worker-capacity' })
        let ids
        store.transact(session.id, 0, (state) => {
            state.home.level = 1
            state.home.stationPets = []
            ids = createPets(tables, state, 500001, 6).map((pet) => pet.guid)
        })
        for (const pet_guid of ids.slice(0, 5)) call('PetStationInHomeHub', { pet_guid, type: 0 })
        const before = store.load(session.id).state
        assert.throws(
            () => call('PetStationInHomeHub', { pet_guid: ids[5], type: 0 }),
            (error) => error.code === ErrorCode.HomeHubFull,
        )
        assert.deepEqual(store.load(session.id).state, before)
        call('PetStationInHomeHub', { pet_guid: ids[0], type: 1 })
        call('PetStationInHomeHub', { pet_guid: ids[5], type: 0 })
        assert.equal(store.load(session.id).state.home.stationPets.length, 5)
    } finally {
        store.close()
    }
})
