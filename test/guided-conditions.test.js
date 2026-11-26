import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { TaskGraphs, makeNode, nodeConditions, conditionValue, conditionSatisfied } from '../src/tasks.js'
import { guidedConditionValue } from '../src/guided-conditions.js'

const cfg = configuration(),
    protocol = new Protocol(cfg.base),
    tables = new Tables(cfg.tables),
    graph = new TaskGraphs(tables).get(106010)

test('guided building condition uses placed building-group count and gates task advancement', () => {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables),
        session = {}
    let seq = 1
    const call = (name, r = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, r) })
    }
    try {
        call('EnterGame', { open_id: 'guided-home' })
        store.transact(session.id, 0, (s) => {
            s.world.map_id = 100
            s.taskRecords = [
                { task_id: 106001, count: 1, time: 1 },
                { task_id: 106002, count: 1, time: 2 },
                { task_id: 106009, count: 1, time: 3 },
            ]
            s.taskEpochs[106010] = 1
            s.tasks = [
                {
                    task_id: 106010,
                    nodes: [{ ...makeNode(graph, 158, s), client_before: true }],
                    finish_nodes: [3],
                    reward_nodes: [],
                    client_trace: true,
                },
            ]
        })
        const q = { task_id: 106010, node_id: 158 }
        const before = store.load(session.id)
        assert.throws(() => call('TaskClientCondAfter', { ...q, indexes: [0] }), /not complete/)
        assert.deepEqual(store.load(session.id), before)
        store.transact(session.id, 0, (s) => {
            s.home.inventory.push({ build_id: 110011, total_num: 1, used_num: 1, unlock: true })
        })
        call('TaskClientCondAfter', { ...q, indexes: [0] })
        call('TaskClientAfter', q)
        assert.equal(store.load(session.id).state.tasks[0].nodes[0].node_id, 189)
    } finally {
        store.close()
    }
})

test('guided thresholds follow task_condition.param; dry farmland needs its separate plow count', () => {
    const petCards = nodeConditions(graph.nodes.get(154))[0]
    assert.equal(conditionSatisfied(petCards, 4), false)
    assert.equal(conditionSatisfied(petCards, 5), true)
    const farmland = nodeConditions(graph.nodes.get(165))[0]
    assert.equal(farmland.__type_TaskConditionBaseData.__type_TaskCondGuidedAchievementsData.achievId, 1060110)
    const state = { home: { inventory: [{ build_id: 20161, used_num: 4 }] } }
    assert.equal(conditionValue(farmland, state), 0)
})

test('HavePet condition 12040 respects group, optional exact ID, and advances owned-pet quest nodes', () => {
    const limited = { pets: [{ config_id: 500156 }, { config_id: 500213 }] }
    assert.equal(guidedConditionValue(1060103, limited), 1)
    assert.equal(guidedConditionValue(1060104, limited), 1)
    assert.equal(
        tables.find('task_condition', 71301),
        undefined,
        'removed CBT3 condition has no current table fallback',
    )
    assert.equal(guidedConditionValue(71301, limited), 0)
    // Exercise the retained optional exact-species predicate explicitly;
    // this synthetic rule is not a restored current table row.
    const exactGroup = tables.get('pet_rank').find((row) => row.petId === 500158)?.petGroup
    assert(Number.isInteger(exactGroup) && exactGroup > 0)
    const exact = { condition: ['12040', exactGroup, 500158, 1].join('|'), param: 1 }
    assert.equal(guidedConditionValue(1060103, limited, undefined, exact), 0)
    limited.pets.push({ config_id: 500158 })
    assert.equal(guidedConditionValue(71301, limited), 0)
    assert.equal(guidedConditionValue(1060103, limited, undefined, exact), 1)
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables),
        session = {}
    let seq = 1
    const call = (name, r = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, r) })
    }
    try {
        call('EnterGame', { open_id: 'guided-owned-pet' })
        store.transact(session.id, 0, (s) => {
            s.world.map_id = 100
            s.taskRecords = [
                { task_id: 106001, count: 1, time: 1 },
                { task_id: 106002, count: 1, time: 2 },
                { task_id: 106009, count: 1, time: 3 },
            ]
            s.taskEpochs[106010] = 1
            s.tasks = [
                {
                    task_id: 106010,
                    nodes: [{ ...makeNode(graph, 184, s), client_before: true }],
                    finish_nodes: [3, 74, 78, 149, 82, 151, 148, 181, 168, 154],
                    reward_nodes: [],
                    client_trace: true,
                },
            ]
        })
        assert(store.load(session.id).state.tasks[0].nodes[0].node_values[0] >= 1)
        call('TaskClientCondAfter', { task_id: 106010, node_id: 184, indexes: [0] })
        call('TaskClientAfter', { task_id: 106010, node_id: 184 })
        let node = store.load(session.id).state.tasks[0].nodes[0]
        assert.equal(node.node_id, 185)
        assert(node.node_values[0] >= 1)
        call('TaskClientBefore', { task_id: 106010, node_id: 185 })
        call('TaskClientCondAfter', { task_id: 106010, node_id: 185, indexes: [0] })
        call('TaskClientAfter', { task_id: 106010, node_id: 185 })
        node = store.load(session.id).state.tasks[0].nodes[0]
        assert.deepEqual(graph.nodes.get(185).nextNodeIdList, [153])
        assert.equal(node.node_id, 153)
    } finally {
        store.close()
    }
})
