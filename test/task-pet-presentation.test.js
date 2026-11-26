import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { TaskGraphs, makeNode } from '../src/tasks.js'
import { grantRewards } from '../src/rewards.js'
import { WorldObjectCatalog } from '../src/world-objects.js'
import { hiddenTaskPetGuids } from '../src/task-pet-presentation.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
test('choice task temporarily presents a unique chosen pet and restores all pets on real page-close confirmation', () => {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables),
        session = {}
    let seq = 1
    const call = (who, name, request) => {
        const e = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(who, { id: e.id, seq: seq++, payload: protocol.encode(e.req, request) })
            .map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    }
    try {
        call(session, 'EnterGame', { open_id: 'task-pet-view' })
        let guid, hidden, allPets, expectedHidden
        store.transact(session.id, 0, (s) => {
            Object.assign(s.world, tables.position(tables.find('world_borthpos', 10050)))
            const previouslyOwned = structuredClone(s.pets)
            const [reward] = grantRewards(
                tables,
                s,
                new WorldObjectCatalog(tables).drops(16006, () => 0),
            )
            guid = reward.guid
            const configId = s.pets.find((pet) => pet.guid === guid).config_id,
                group = tables.get('pet_rank').find((row) => row.petId === configId).petGroup
            const species = new Set(
                tables
                    .get('pet_rank')
                    .filter((row) => row.petGroup === group)
                    .map((row) => row.petId),
            )
            expectedHidden = previouslyOwned.filter((pet) => species.has(pet.config_id)).map((pet) => pet.guid)
            s.taskEpochs[106010] = 1
            s.taskPetChoices = { 106010: group }
            s.playableChoiceReceipts = {
                '106010:1:60001': { step: 3, drop_id: 16006, pet_guid: guid, pet_group: group },
            }
            const graph = new TaskGraphs(tables).get(106010)
            s.tasks = [
                {
                    task_id: 106010,
                    nodes: [{ ...makeNode(graph, 183, s), client_before: true }],
                    finish_nodes: [3, 74, 78, 149, 82, 151, 148],
                    reward_nodes: [78, 82, 151],
                    client_trace: true,
                },
            ]
            s.taskRecords = tables
                .get('task')
                .filter((r) => r.type === 1 && r.id !== 106010)
                .map((r) => ({ task_id: r.id, count: 1, time: 1 }))
            hidden = hiddenTaskPetGuids(tables, s)
            allPets = structuredClone(s.pets)
        })
        assert.ok(expectedHidden.length > 0, 'the real fixture owns other current stages of the granted species')
        assert.deepEqual(
            [...hidden].sort(),
            [...expectedHidden].sort(),
            'hide exactly the previously owned current species members',
        )
        const reconnect = {}
        const packets = call(reconnect, 'EnterGame', { open_id: 'task-pet-view' })
        const pets = packets.find((p) => p.id === 6517).data.pet_infos
        assert.ok(pets.pets.some((p) => p.guid === guid))
        const speciesGuids = new Set([guid, ...expectedHidden])
        const consume = (cache, bag) => {
            for (const pet of bag.pets ?? []) {
                assert(tables.find('pet', pet.config_id), 'current Lua pet config lookup')
                cache.add(pet.guid)
            }
            for (const id of bag.guid ?? []) {
                assert(cache.has(id), 'Lua box index exists before same-packet removal')
                cache.delete(id)
            }
            return cache
        }
        const clientCache = consume(new Set(), pets),
            reconnectCache = consume(new Set(allPets.map((pet) => pet.guid)), pets)
        assert.deepEqual(
            [...clientCache].filter((id) => speciesGuids.has(id)),
            [guid],
        )
        assert.deepEqual([...clientCache].sort(), [...reconnectCache].sort())
        assert.ok(hidden.every((id) => pets.guid.includes(id) && pets.pets.some((p) => p.guid === id)))
        assert.equal(
            store.load(session.id).state.tasks[0].nodes[0].node_values[0],
            0,
            'row refresh events do not complete the page condition',
        )
        assert.deepEqual(store.load(session.id).state.pets, allPets, 'stored inventory must not be removed or rebuilt')
        // Only the real configured page-close report restores the presentation.
        const event = call(reconnect, 'ClientBehaviourRecord', { key: 2508, args: [106010, 1] })
        const restored = event.find((p) => p.id === 6517).data.pet_infos.pets
        assert.ok(hidden.every((id) => restored.some((p) => p.guid === id)))
        consume(clientCache, event.find((p) => p.id === 6517).data.pet_infos)
        assert.deepEqual([...clientCache].sort(), allPets.map((pet) => pet.guid).sort())
        assert.deepEqual(store.load(session.id).state.pets, allPets)
        assert.deepEqual(hiddenTaskPetGuids(tables, store.load(session.id).state), [])
        assert.equal(store.load(session.id).state.tasks[0].nodes[0].node_id, 183, 'no fabricated story advancement')
    } finally {
        store.close()
    }
})
