import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { TaskGraphs, acceptAvailableSideTasks, conditionValue, taskUnlocked } from '../src/tasks.js'
import { createPets } from '../src/pets.js'
import { taskAcceptStoryCompleted, taskAcceptOwnedPetGroup } from '../src/task-acceptance.js'

const config = configuration(),
    tables = new Tables(config.tables),
    protocol = new Protocol(config.base),
    graphs = new TaskGraphs(tables)
function fixture(name, taskId) {
    const store = new Store(':memory:'),
        session = {},
        game = new Game(protocol, store, tables, { clock: () => 1800000000 }),
        graph = graphs.get(taskId)
    let seq = 1
    const call = (name, data = {}, target = session) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(target, {
            id: entry.id,
            seq: seq++,
            payload: entry.req ? protocol.encode(entry.req, data) : Buffer.alloc(0),
        })
    }
    const account = 'task-accept-current-' + name
    call('EnterGame', { open_id: account })
    store.transact(session.id, 0, (state) => {
        state.tasks = []
        state.taskRecords = []
        state.player.basic_info.lv = 50
        for (const rule of graph.config.unlockcondition.split('|').filter(Boolean)) {
            const [kind, id] = rule.split('#').map(Number)
            if ([2007, 12045].includes(kind)) state.taskRecords.push({ task_id: id, count: 1 })
        }
        const base = graph.requirements[0].__type_TaskConditionBaseData,
            data = base.__type_TaskCondStoryOpenTaskData
        state.world.map_id = data.isNowCreate ? data.npcData.sceneId : data.sceneId || base.mapData.sceneId
        state.world.pos = { x: 0, y: 0, z: 0 }
    })
    return {
        store,
        session,
        game,
        graph,
        call,
        state: () => store.load(session.id).state,
        snapshot: () => store.load(session.id),
        edit: (fn) => store.transact(session.id, 0, fn),
        accept: () => call('TaskAccept', { u32: taskId }),
        login: () => call('EnterGame', { open_id: account, reconnect: true }, {}),
    }
}
function taskSync(packets) {
    return packets
        .filter((packet) => packet.id === protocol.byName.get('CSProtoTaskSync').id)
        .flatMap((packet) => protocol.decode(protocol.byId.get(packet.id).rsp, packet.payload).tasks ?? [])
}

test('actual202005 dynamic NPC bool accepts through9850, retains the current graph and survives reconnect without static-position rechecks', () => {
    const f = fixture('dynamic', 202005)
    try {
        const request = f.graph.requirements[0],
            state = f.state(),
            context = { tables, accepting: true }
        assert.equal(request.__type_TaskConditionBaseData.__type_TaskCondStoryOpenTaskData.isNowCreate, true)
        assert.equal(conditionValue(request, state, context), 1)
        const numeric = structuredClone(request)
        numeric.__type_TaskConditionBaseData.__type_TaskCondStoryOpenTaskData.isNowCreate = 1
        assert.equal(conditionValue(numeric, state, context), 1)
        numeric.__type_TaskConditionBaseData.__type_TaskCondStoryOpenTaskData.isNowCreate = 2
        assert.equal(conditionValue(numeric, state, context), 0)
        f.edit((state) => {
            state.world.map_id = 200
        })
        const wrong = f.snapshot()
        assert.throws(f.accept, /prerequisites not met/)
        assert.deepEqual(f.snapshot(), wrong)
        f.edit((state) => {
            state.world.map_id = 101
        })
        const packets = f.accept()
        assert(taskSync(packets).some((task) => task.task_id === 202005))
        const saved = f.state().tasks.find((task) => task.task_id === 202005)
        assert(saved.nodes.every((node) => f.graph.nodes.has(node.node_id)))
        assert(taskSync(f.login()).some((task) => task.task_id === 202005))
        const duplicate = f.snapshot()
        assert.throws(f.accept, /already active/)
        assert.deepEqual(f.snapshot(), duplicate)
    } finally {
        f.store.close()
    }
})

test('actual202007 pre-accept story uses6060 before9850, accepts a skip receipt and never trusts bare story IDs or the wrong scene', () => {
    const f = fixture('story', 202007),
        data = f.graph.requirements[0].__type_TaskConditionBaseData.__type_TaskCondStoryOpenTaskData
    try {
        assert.equal(data.isNowCreate, false)
        assert.equal(data.storyId, 305601)
        assert.throws(f.accept, /prerequisites not met/)
        f.edit((state) => {
            state.storyIds = [data.storyId]
        })
        assert.throws(f.accept, /prerequisites not met/)
        const story = tables.find('story', data.storyId)
        f.call('SetStoryId', { story_id: data.storyId, story_type: story.storyType, tag: 7, is_skip: true, param: 0 })
        assert(
            taskAcceptStoryCompleted(f.state(), data.storyId, 0),
            'Current required tag0 accepts any reported end tag',
        )
        assert(
            !taskAcceptStoryCompleted(f.state(), data.storyId, 8),
            'Positive-tag boundary is strict even though current openReq rows use0',
        )
        assert(taskAcceptStoryCompleted(f.state(), data.storyId, 7))
        assert(!taskAcceptStoryCompleted(f.state(), data.storyId + 1, 0))
        const required = f.graph.requirements[0],
            legacy = structuredClone(required)
        legacy.__type_TaskConditionBaseData.__type_TaskCondStoryOpenTaskData.isNowCreate = 0
        assert.equal(conditionValue(legacy, f.state(), { tables, accepting: true }), 1)
        f.edit((state) => {
            state.world.map_id = 200
        })
        assert.throws(f.accept, /prerequisites not met/)
        f.edit((state) => {
            state.world.map_id = 101
        })
        assert(taskSync(f.accept()).some((task) => task.task_id === 202007))
        assert.equal(
            Object.values(f.state().storyWatches).find((row) => row.story_id === data.storyId).full_watch,
            false,
        )
        assert(taskSync(f.login()).some((task) => task.task_id === 202007))
    } finally {
        f.store.close()
    }
})

test('actual216004 group2527 requires a current permanent owned pet, not trial actors or acquisition history', () => {
    const f = fixture('owned-pet', 216004),
        data = f.graph.requirements[0].__type_TaskConditionBaseData.__type_TaskCondStoryOpenTaskData
    try {
        const rule = f.graph.config.unlockcondition.split('|').find((rule) => rule.startsWith('2527#')),
            groupId = Number(rule.split('#')[1])
        const petConfig = tables
            .get('pet_rank')
            .find((row) => row.petGroup === groupId && tables.find('pet', row.petId))
        assert(petConfig)
        f.edit((state) => {
            state.pets = []
            state.recordPets = [petConfig.petId]
        })
        f.call('SetStoryId', {
            story_id: data.storyId,
            story_type: tables.find('story', data.storyId).storyType,
            tag: 0,
            is_skip: false,
        })
        assert.equal(taskAcceptOwnedPetGroup(tables, f.state(), groupId), false)
        assert.equal(taskUnlocked(f.graph, f.state()), false)
        assert.throws(f.accept, /prerequisites not met/)
        f.edit((state) => {
            createPets(tables, state, petConfig.petId, 1)
        })
        const state = f.state(),
            pet = state.pets[0]
        assert(taskAcceptOwnedPetGroup(tables, state, groupId))
        assert(taskUnlocked(f.graph, state, { tables, accepting: true }))
        assert(taskUnlocked(f.graph, state), 'Graph-generated table context also serves implicit callers')
        const noRanks = Object.create(tables)
        noRanks.get = (name) => (name === 'pet_rank' ? [] : tables.get(name))
        assert.equal(taskUnlocked(f.graph, state, { tables: noRanks }), false, 'Explicit tables take precedence')
        const candidates = Object.create(tables)
        candidates.get = (name) => (name === 'task' ? [f.graph.config] : tables.get(name))
        const candidateState = structuredClone(state)
        assert.deepEqual(
            acceptAvailableSideTasks(candidates, candidateState, 1800000000, graphs).added,
            [216004],
            'Actual side-task candidate acceptance agrees with the context-free predicate',
        )
        const trial = structuredClone(state)
        trial.trialGroup = { pets: [structuredClone(pet)] }
        assert.equal(taskAcceptOwnedPetGroup(tables, trial, groupId), false)
        trial.trialGroup = undefined
        trial.pets[0].trail = true
        assert.equal(taskAcceptOwnedPetGroup(tables, trial, groupId), false)
        trial.pets[0].trail = false
        trial.pets[0].owner_id = 99999
        assert.equal(taskAcceptOwnedPetGroup(tables, trial, groupId), false)
        const legacy = structuredClone(state)
        legacy.pets[0].guid = String(pet.config_id)
        assert(taskAcceptOwnedPetGroup(tables, legacy, groupId), 'Store-owned old UUIDs are not silently discarded')
        const unchangedGuid = pet.guid
        assert(taskSync(f.accept()).some((task) => task.task_id === 216004))
        assert.equal(f.state().pets[0].guid, unchangedGuid)
        assert(taskSync(f.login()).some((task) => task.task_id === 216004))
    } finally {
        f.store.close()
    }
})

test('failed actual acceptance encoding rolls back epoch/nodes and matching receipt remains usable after reconnect', () => {
    const f = fixture('rollback', 202007),
        encode = protocol.encode.bind(protocol),
        data = f.graph.requirements[0].__type_TaskConditionBaseData.__type_TaskCondStoryOpenTaskData
    try {
        f.call('SetStoryId', {
            story_id: data.storyId,
            story_type: tables.find('story', data.storyId).storyType,
            tag: 0,
            is_skip: false,
        })
        const before = f.snapshot()
        protocol.encode = (name, value) => {
            if (name === protocol.byName.get('CSProtoTaskSync').rsp) throw Error('acceptance codec')
            return encode(name, value)
        }
        assert.throws(f.accept, /acceptance codec/)
        assert.deepEqual(f.snapshot(), before)
        protocol.encode = encode
        f.login()
        assert(taskAcceptStoryCompleted(f.state(), data.storyId))
        // The login legitimately restores this fresh account to its main-task
        // map102. Returning to the actual side-quest NPC must retain the receipt.
        assert.equal(f.state().world.map_id, 102)
        assert.throws(f.accept, /prerequisites not met/)
        f.edit((state) => {
            state.world.map_id = 101
        })
        assert(taskSync(f.accept()).some((task) => task.task_id === 202007))
    } finally {
        protocol.encode = encode
        f.store.close()
    }
})
