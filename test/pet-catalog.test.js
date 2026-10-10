import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Tables, seedPlayer } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { createPets, petData } from '../src/pets.js'
import { grantRewards } from '../src/rewards.js'
import { repairPetCatalog } from '../src/pet-catalog.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
test('permanent acquisition history merges species, survives release, and excludes previews, eggs and trial pets', () => {
    const state = seedPlayer(tables, 1, 'catalog')
    state.pets = []
    state.recordPets = [500001]
    petData(tables, 500002, '0', 0)
    state.trialGroup = { pets: [petData(tables, 500002, '1', 0)] }
    state.petEggs = [{ config_id: 500002 }]
    repairPetCatalog(tables, state)
    assert.deepEqual(state.recordPets, [500001])
    grantRewards(tables, state, [{ itemtype: 5, itemid: 500002, itemnum: 2 }])
    assert.deepEqual(state.recordPets, [500001, 500002])
    createPets(tables, state, 500002, 1)
    assert.deepEqual(state.recordPets, [500001, 500002])
    state.pets = []
    repairPetCatalog(tables, state)
    assert.deepEqual(state.recordPets, [500001, 500002])
    state.petCaptureResults = { old: { pet_id: 500003 } }
    repairPetCatalog(tables, state)
    assert.deepEqual(state.recordPets, [500001, 500002, 500003])
})
test('old accounts receive recorded pet IDs on login; GM grants sync new IDs before reply and history persists across SQLite restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-catalog-')),
        file = path.join(dir, 'test.sqlite')
    let store = new Store(file),
        game = new Game(protocol, store, tables),
        session = {},
        seq = 1
    const call = (name, request) => {
        const e = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, request) })
            .map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    }
    try {
        const login = call('EnterGame', { open_id: 'catalog-test' })
        assert.ok(store.load(session.id).state.pets.length > 0)
        assert.deepEqual(login.find((p) => p.id === 6517).data.record_pets, [])
        store.transact(session.id, 0, (s) => {
            s.pets = []
            delete s.recordPets
            s.petCaptureResults = { old: { pet_id: 500001 } }
        })
        session = {}
        const migrated = call('EnterGame', { open_id: 'catalog-test', reconnect: true })
        assert.deepEqual(migrated.find((p) => p.id === 6517).data.record_pets, [500001])
        const grant = call('GMCommand', { command: Buffer.from('give 5 500002 1').toString('base64') })
        assert.deepEqual(grant.find((p) => p.id === 6517).data.record_pets, [500001, 500002])
        assert.ok(
            grant.findIndex((p) => p.id === 6517) <
                grant.findIndex((p) => protocol.byId.get(p.id).name === 'CSProtoGMCommand'),
        )
        store.transact(session.id, 0, (s) => {
            s.pets = []
        })
        store.close()
        store = new Store(file)
        game = new Game(protocol, store, tables)
        session = {}
        const relog = call('EnterGame', { open_id: 'catalog-test' })
        assert.deepEqual(relog.find((p) => p.id === 6517).data.record_pets, [500001, 500002])
    } finally {
        store.close()
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('legacy starter unlocks are removed once; later acquisition of the same species survives release and relog', () => {
    const state = seedPlayer(tables, 1, 'legacy-starters')
    delete state.petCatalogVersion
    const starter = state.pets[0]
    const id = starter.config_id
    state.recordPets = state.pets.map((p) => p.config_id)
    repairPetCatalog(tables, state)
    assert.deepEqual(state.recordPets, [])
    assert.equal(state.pets[0].guid, String(id))
    createPets(tables, state, id, 1)
    assert.deepEqual(state.recordPets, [id])
    state.pets = state.pets.filter((p) => String(p.guid) === String(p.config_id))
    repairPetCatalog(tables, state)
    assert.deepEqual(state.recordPets, [id])
})
test('legacy real obtained pets and successful capture receipts remain unlocked alongside starter gifts', () => {
    const state = seedPlayer(tables, 1, 'legacy-earned'),
        id = state.pets[0].config_id
    createPets(tables, state, id, 1)
    delete state.petCatalogVersion
    state.recordPets = state.pets.map((p) => p.config_id)
    state.petCaptureResults = { past: { pet_id: state.pets[1].config_id } }
    repairPetCatalog(tables, state)
    assert.deepEqual(new Set(state.recordPets), new Set([id, state.pets[1].config_id]))
})
