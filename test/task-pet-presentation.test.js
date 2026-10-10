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
        let guid, hidden, allPets
        store.transact(session.id, 0, (s) => {
            Object.assign(s.world, tables.position(tables.find('world_borthpos', 10050)))
            const [reward] = grantRewards(
                tables,
                s,
                new WorldObjectCatalog(tables).drops(16006, () => 0),
            )
            guid = reward.guid
            s.taskEpochs[106010] = 1
            s.taskPetChoices = { 106010: 56 }
            s.playableChoiceReceipts = { '106010:1:60001': { step: 3, drop_id: 16006, pet_guid: guid, pet_group: 56 } }
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
        assert.equal(hidden.length, 3)
        const reconnect = {}
        const packets = call(reconnect, 'EnterGame', { open_id: 'task-pet-view' })
        const pets = packets.find((p) => p.id === 6517).data.pet_infos
        assert.ok(pets.pets.some((p) => p.guid === guid))
        assert.ok(hidden.every((id) => pets.guid.includes(id) && !pets.pets.some((p) => p.guid === id)))
        assert.deepEqual(store.load(session.id).state.pets, allPets, 'stored inventory must not be removed or rebuilt')
        // Only the real configured page-close report restores the presentation.
        const event = call(reconnect, 'ClientBehaviourRecord', { key: 2508, args: [106010, 1] })
        const restored = event.find((p) => p.id === 6517).data.pet_infos.pets
        assert.ok(hidden.every((id) => restored.some((p) => p.guid === id)))
        assert.deepEqual(store.load(session.id).state.pets, allPets)
        assert.deepEqual(hiddenTaskPetGuids(tables, store.load(session.id).state), [])
        assert.equal(store.load(session.id).state.tasks[0].nodes[0].node_id, 183, 'no fabricated story advancement')
    } finally {
        store.close()
    }
})
