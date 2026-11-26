import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { TaskGraphs, makeNode, nodeConditions } from '../src/tasks.js'
import { recordTaskBehaviour } from '../src/task-events.js'
import { ErrorCode } from '../src/error-codes.js'

class CurrentTables extends Tables {
    constructor(modify = {}) {
        super(configuration().tables)
        this.modify = modify
    }
    get(name) {
        const rows = super.get(name)
        return this.modify[name] ? this.modify[name](rows) : rows
    }
    find(name, id) {
        return this.modify[name] ? this.get(name).find((row) => row.id === Number(id)) : super.find(name, id)
    }
}
function fixture(pets, modify) {
    const tables = new CurrentTables(modify)
    const graph = new TaskGraphs(tables).get(106002)
    const state = {
        world: { map_id: 102 },
        player: { basic_info: { lv: 100 } },
        taskEpochs: { 106002: 1 },
        pets: pets.map((config_id, index) => ({ config_id, guid: String(index + 1) })),
        tasks: [],
        taskRecords: [],
    }
    state.tasks = [
        {
            task_id: 106002,
            nodes: [{ ...makeNode(graph, 56, state), client_before: true }],
            finish_nodes: [1],
            reward_nodes: [],
        },
    ]
    const data = nodeConditions(graph.nodes.get(56))[0].__type_TaskConditionBaseData.__type_TaskCondFractalPetCatchData
    const event = { key: 2526, args: [106002, data.enemyData.createNpcId, data.uniKey, 2] }
    const packets = []
    return {
        state,
        packets,
        report: () => recordTaskBehaviour({ state, tables, push: (...value) => packets.push(value) }, event),
    }
}

test('current stage2 maps template5002971 to owned base500297 without requiring a single same-species instance', () => {
    for (const pets of [[500297], [500297, 500297]]) {
        const f = fixture(pets)
        assert.equal(f.report(), true)
        assert.deepEqual(f.state.tasks[0].nodes[0].node_values, [2, 0])
        assert.equal(f.packets.length, 1)
        assert.deepEqual(
            f.state.pets.map((pet) => pet.config_id),
            pets,
        )
    }
})

test('ordinary enemy pet IDs retain direct lookup while the current task helper probes customized keys independently of category', () => {
    for (const petId of [500297, 5002971]) {
        const f = fixture([500297], {
            enemy: (rows) => rows.map((row) => (row.id === 310369 ? { ...row, petId, petCategory: 1 } : row)),
        })
        assert.equal(f.report(), true)
        assert.deepEqual(f.state.tasks[0].nodes[0].node_values, [2, 0])
    }
})

test('stage2 still requires an owned matching group and never accepts an unresolved customized template', () => {
    for (const pets of [[], [500134]]) {
        const f = fixture(pets),
            before = structuredClone(f.state)
        assert.throws(f.report, /Required task pet is not owned/)
        assert.deepEqual(f.state, before)
        assert.deepEqual(f.packets, [])
    }
    for (const rows of [[], [{ id: 5002971, petId: 0 }]]) {
        const f = fixture([500297], { pet_customized: () => rows }),
            before = structuredClone(f.state)
        assert.throws(f.report, (error) => error.code === ErrorCode.GameConfig)
        assert.deepEqual(f.state, before)
        assert.deepEqual(f.packets, [])
    }
})
