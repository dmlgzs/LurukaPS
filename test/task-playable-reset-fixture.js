import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables, seedPlayer } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { TaskGraphs, makeNode } from '../src/tasks.js'

// Qualified independent107016/5 entry profile,not earned chapter progression.
// Completion below is a reported successful playable outcome for testing
// persistence/reset contracts;it does not simulate tracking,AI or physics.
export function taskPlayableResetFixture(name) {
    const config = configuration(),
        tables = new Tables(config.tables),
        protocol = new Protocol(config.base)
    const store = new Store(':memory:'),
        session = {},
        trace = []
    const options = {
        starterProfile: 'normal',
        clock: () => 1800000000,
        rng: (minOrMax, maximum) => {
            const min = maximum === undefined ? 0 : minOrMax,
                max = maximum === undefined ? minOrMax : maximum
            return min + Math.floor((max - min) / 2)
        },
    }
    let game = new Game(protocol, store, tables, options),
        seq = 1
    const call = (name, data = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        assert(entry, name)
        try {
            const packets = game.dispatch(session, {
                id: entry.id,
                seq: seq++,
                payload: entry.req ? protocol.encode(entry.req, data) : Buffer.alloc(0),
            })
            for (const packet of packets) protocol.decode(protocol.byId.get(packet.id).rsp, packet.payload)
            trace.push({ name, data, packets: packets.map((packet) => packet.id) })
            return packets
        } catch (error) {
            trace.push({ name, data, error: error.message, code: error.code })
            throw error
        }
    }
    store.login(name, (id, openId) => {
        const state = seedPlayer(tables, id, openId, { mode: 'normal' }),
            prior = new Set(),
            levels = []
        const prerequisites = (taskId) => {
            const row = tables.find('task', taskId)
            assert(row)
            for (const token of String(row.unlockcondition).split('|')) {
                const [kind, target] = token.split('#').map(Number)
                if (kind === 2004) levels.push(target)
                if (kind === 2007 && !prior.has(target)) {
                    prior.add(target)
                    prerequisites(target)
                }
            }
        }
        prerequisites(107016)
        assert(!prior.has(107016) && !prior.has(500024))
        state.taskRecords = [...prior].map((task_id) => ({ task_id, count: 1, time: 1 }))
        state.player.basic_info.lv = Math.max(...levels)
        const graph = new TaskGraphs(tables).get(107016),
            finished = new Set()
        const visit = (nodeId) => {
            if (nodeId === graph.start) return
            for (const previous of graph.nodes.get(nodeId).prevNodeIdList ?? []) {
                if (finished.has(previous)) continue
                finished.add(previous)
                visit(previous)
            }
        }
        visit(5)
        const node = graph.nodes.get(5),
            data = node.__type_TaskConditionNodeData.conditionList[0].__type_TaskConditionBaseData
        assert.equal(data.__type_TaskCondDungeonData.dungeonId, 10200)
        Object.assign(state.world, tables.position(tables.find('world_borthpos', data.mapData.birthId)))
        ;(state.taskEpochs ??= {})[107016] = 1
        state.tasks = [
            {
                task_id: 107016,
                nodes: [{ ...makeNode(graph, 5, state), client_before: true }],
                finish_nodes: [...finished],
                reward_nodes: [],
                client_trace: true,
            },
        ]
        return state
    })
    call('EnterGame', { open_id: name })
    const state = () => store.load(session.id).state
    const enter = () => {
        call('CampaignCreate', { group_id: 248, difficulty: 1 })
        assert.equal(state().world.map_id, 6250)
        assert.deepEqual(state().storyCampaign.task_ids, [500024])
        call('MapLoadFinish')
        call('StartDungeonClientOk')
    }
    const watch = (id) => {
        // Exact current3217420 task500024 source profiles;this fixture is
        // intentionally not a playable/Unity producer or a normal account E2E.
        assert.equal(id, 101213)
        assert.equal(tables.find('story', id).storyType, 0)
        call('SetStoryId', { story_id: id, story_type: 0, tag: 0, param: id === 101213 ? 1 : 0, is_skip: false })
    }
    const finishPlayable = () => {
        watch(101213)
        call('TaskClientBefore', { task_id: 500024, node_id: 2 })
        call('PlayableStart', { u32: 62024 })
        call('PlayableStep', { playId: 62024, is_step: true, finish_step: 50 })
        assert.equal(state().tasks.find((task) => task.task_id === 500024).nodes[0].node_values[0], 0)
        call('PlayableFinish', { playId: 62024, index: 0, score: 0 })
        assert.equal(state().tasks.find((task) => task.task_id === 500024).nodes[0].node_values[0], 1)
    }
    return {
        tables,
        protocol,
        store,
        session,
        call,
        trace,
        state,
        enter,
        finishPlayable,
        coldLogin() {
            game = new Game(new Protocol(config.base), store, new Tables(config.tables), options)
            for (const key of Object.keys(session)) delete session[key]
            return call('EnterGame', { open_id: name })
        },
        close: () => store.close(),
    }
}
