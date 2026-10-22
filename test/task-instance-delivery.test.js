import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { TaskGraphs, makeNode } from '../src/tasks.js'
import { ErrorCode } from '../src/error-codes.js'
import { taskResourcePlan } from '../src/task-resource-consumption.js'
import { submitTaskItems, deliveryComplete } from '../src/task-delivery.js'
const conf = configuration(),
    tables = new Tables(conf.tables),
    protocol = new Protocol(conf.base)
const fixed = (type, id, count = 1) => ({
    conditionId: 2501,
    __type_TaskConditionBaseData: {
        __type_TaskCondSubItemData: { itemBigType: type, itemDatas: [{ itemId: id, count }] },
    },
})
const entry = (type, id, guid, count = 1) => ({
    item_type: type,
    item_id: id,
    item_guid: String(guid),
    item_count: count,
})
function setup() {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables),
        session = {}
    let seq = 1
    const call = (name, r) => {
        let e = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: e.id, seq: seq++, pushSeq: 0, payload: protocol.encode(e.req, r) })
    }
    call('EnterGame', { open_id: 'instance-delivery' })
    let graph = new TaskGraphs(tables).get(100002)
    store.transact(session.id, 0, (s) => {
        s.world.map_id = 924
        s.taskEpochs = { 100002: 1 }
        s.tasks = [
            {
                task_id: 100002,
                start_time: 1,
                finish_nodes: [],
                reward_nodes: [],
                nodes: [{ ...makeNode(graph, 21, s), client_before: true }],
            },
        ]
        const pet = s.pets.find((p) => p.config_id === 500026)
        assert.ok(pet)
        Object.assign(pet, {
            is_lock: false,
            hero_id: '0',
            roulette_pos: 0,
            work_status: 0,
            work_build: 0,
            capacity_id: 0,
            station_lock: 0,
            can_not_release: false,
        })
        s.pets = [pet]
    })
    return { store, session, call, state: () => store.load(session.id).state }
}
function base() {
    return {
        world: { map_id: 924, mount: '0' },
        player: {
            basic_info: { gold: 0, diamond: 0 },
            attr_infos: { attrs: [] },
            sbag_infos: { items: [] },
            heros_info: { heros: [] },
            group_mgrs: [],
        },
        pets: [],
        petEggs: [],
        ornaments: [],
    }
}
test('9854 actual task100002 node21 consumes the explicitly selected pet and sends deletion; exact retry is harmless', () => {
    const c = setup()
    try {
        const guid = c.state().pets[0].guid,
            r = { task_id: 100002, node_id: 21, node_index: 0, items: [entry(5, 500026, guid)] }
        const packets = c.call('TaskSubmitItem', r)
        const id = protocol.byName.get('CSProtoPetInfoSync').id,
            index = packets.findIndex((p) => p.id === id)
        assert.ok(index >= 0)
        const sync = protocol.decode('SCPetInfoSync', packets[index].payload)
        assert.deepEqual(sync.pet_infos.guid, [guid])
        assert.equal(c.state().pets.length, 0)
        assert.equal(c.state().tasks[0].nodes[0].node_values[0], 1)
        assert.equal(c.state().releaseLedgers, undefined)
        const receipt = c.state().taskInstanceDeliveries
        c.call('TaskSubmitItem', r)
        assert.deepEqual(c.state().taskInstanceDeliveries, receipt)
        assert.equal(c.state().pets.length, 0)
    } finally {
        c.store.close()
    }
})
test('9854 never resolves an omitted instance selection to an arbitrary pet', () => {
    const c = setup()
    try {
        const before = c.state()
        assert.throws(
            () => c.call('TaskSubmitItem', { task_id: 100002, node_id: 21, node_index: 0, items: [] }),
            (e) => e.code === ErrorCode.TaskSubmitItemChoseError,
        )
        assert.deepEqual(c.state(), before)
    } finally {
        c.store.close()
    }
})
test('locked, equipped, formation, mounted, working and trial pets are rejected without mutation', () => {
    for (const mutate of [
        (s) => (s.pets[0].is_lock = true),
        (s) => (s.pets[0].hero_id = '12'),
        (s) => (s.player.group_mgrs = [{ groups: [{ heros: [{ pet_id: '100' }] }] }]),
        (s) => (s.world.mount = '100'),
        (s) => (s.pets[0].capacity_id = 4),
        (s) => (s.pets[0].work_status = 1),
        (s) => (s.pets[0].can_not_release = true),
        (s) => (s.trialGroup = { pets: [{ guid: '100' }] }),
    ]) {
        const s = base()
        s.pets = [{ guid: '100', config_id: 500026 }]
        mutate(s)
        const before = structuredClone(s)
        assert.throws(() => taskResourcePlan({ state: s, tables }, [entry(5, 500026, 100)]))
        assert.deepEqual(s, before)
    }
})
test('current egg instance submission consumes exactly the chosen egg, clears outcome caches and bumps deletion revision', () => {
    const id = tables.get('pet_egg')[0].id,
        s = base()
    s.petEggs = [
        { guid: 23, configid: id },
        { guid: 24, configid: id },
    ]
    s.eggOutcomes = { 23: { chosen: 1 }, 24: { chosen: 2 } }
    s.eggHatchConstraints = { 23: { color: 1 }, 24: { color: 2 } }
    const ctx = { taskId: 100002, nodeId: 21, index: 1 },
        condition = fixed(14, id)
    submitTaskItems({ state: s, tables, now: 1, push: () => {} }, condition, ctx, [entry(14, id, 23)])
    assert.deepEqual(
        s.petEggs.map((e) => e.guid),
        [24],
    )
    assert.equal(s.eggOutcomes[23], undefined)
    assert.equal(s.eggHatchConstraints[23], undefined)
    assert.ok(s.eggOutcomes[24])
    assert.equal(s.eggRevision, 1)
    assert.equal(deliveryComplete(s, condition, ctx), true)
    assert.equal(s.releaseLedgers, undefined)
})
test('egg lock, incubation and missing current configuration cannot be bypassed by task delivery', () => {
    const id = tables.get('pet_egg')[0].id
    for (const mutate of [
        (s) => (s.petEggs[0].lock_state = true),
        (s) => (s.petEggs[0].hatch_state = 1),
        (s) => (s.home = { productionJobs: { 1: [{ eggGuid: 23 }] } }),
        (s) => (s.home = { builds: [{ hatch: { hatch_infos: [{ egg_guid: 23 }] } }] }),
        (s) => (s.petEggs[0].configid = 550001),
    ]) {
        const s = base()
        s.petEggs = [{ guid: 23, configid: id }]
        mutate(s)
        const before = structuredClone(s)
        assert.throws(() => taskResourcePlan({ state: s, tables }, [entry(14, s.petEggs[0].configid, 23)]))
        assert.deepEqual(s, before)
    }
})
test('ornament delivery deletes one chosen instance, protects lock/equipment, and never grants smelt returns', () => {
    const id = 1110111
    for (const mutate of [
        null,
        (s) => (s.ornaments[0].lock = true),
        (s) => (s.ornaments[0].wear_hero = '10'),
        (s) => (s.player.heros_info.heros = [{ oguid: [12] }]),
        (s) => (s.ornaments[0].trail = true),
    ]) {
        const s = base()
        s.ornaments = [
            { id, guid: 12, lock: false },
            { id, guid: 13, lock: false },
        ]
        if (mutate) {
            mutate(s)
            assert.throws(() => taskResourcePlan({ state: s, tables }, [entry(15, id, 12)]))
            assert.equal(s.ornaments.length, 2)
        } else {
            submitTaskItems(
                { state: s, tables, now: 1, push: () => {} },
                fixed(15, id),
                { taskId: 202020, nodeId: 6, index: 0 },
                [entry(15, id, 12)],
            )
            assert.deepEqual(
                s.ornaments.map((o) => o.guid),
                [13],
            )
            assert.equal(s.ornamentRevision, 1)
            assert.equal(s.player.basic_info.gold, 0)
            assert.equal(s.ornamentSmeltNum, undefined)
        }
    }
})
test('building delivery removes only spare uninstantiated stock and retains placed/saved building state', () => {
    const s = base()
    s.home = {
        inventory: [{ build_id: 30251, total_num: 4, used_num: 1, unlock: true }],
        builds: [{ guid: 1, build_id: 30251 }],
        storedBuilds: [{ guid: 2, build_id: 30251 }],
        shortcuts: [],
    }
    const ctx = { taskId: 202019, nodeId: 15, index: 0 },
        condition = fixed(13, 30251, 2)
    submitTaskItems({ state: s, tables, now: 1, push: () => {} }, condition, ctx, [entry(13, 30251, 0, 2)])
    assert.equal(s.home.inventory[0].total_num, 2)
    assert.equal(s.home.inventory[0].used_num, 1)
    assert.equal(s.home.builds[0].guid, 1)
    assert.equal(s.home.storedBuilds[0].guid, 2)
    assert.equal(deliveryComplete(s, condition, ctx), true)
    assert.throws(
        () => taskResourcePlan({ state: s, tables }, [entry(13, 30251, 0)]),
        (e) => e.code === ErrorCode.ItemNotEnough,
    )
})
test('duplicate instances, mismatched identity and multi-instance count reject before any mutation', () => {
    const s = base()
    s.pets = [
        { guid: '100', config_id: 500026 },
        { guid: '101', config_id: 500026 },
    ]
    for (const items of [
        [entry(5, 500026, 100), entry(5, 500026, 100)],
        [entry(5, 500098, 100)],
        [entry(5, 500026, 100, 2)],
        [entry(5, 500026, 0)],
    ]) {
        const before = structuredClone(s)
        assert.throws(() => taskResourcePlan({ state: s, tables }, items))
        assert.deepEqual(s, before)
    }
})
test('failed task submission encoding rolls back consumed pet, completion receipt and deletion state', () => {
    const c = setup()
    try {
        const guid = c.state().pets[0].guid,
            before = c.state(),
            old = protocol.encode
        protocol.encode = function (name, payload) {
            if (name === protocol.byName.get('CSProtoPetInfoSync').rsp) throw Error('simulated deletion encode failure')
            return old.call(this, name, payload)
        }
        try {
            assert.throws(
                () =>
                    c.call('TaskSubmitItem', {
                        task_id: 100002,
                        node_id: 21,
                        node_index: 0,
                        items: [entry(5, 500026, guid)],
                    }),
                /simulated/,
            )
        } finally {
            protocol.encode = old
        }
        assert.deepEqual(c.state(), before)
    } finally {
        c.store.close()
    }
})
