import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { TaskGraphs, acceptTask, makeNode } from '../src/tasks.js'

export function pointSource(tables, objectId = 200128, map = 100) {
    const row = tables.find(`worldmap_${map}`, objectId)
    const spawner = tables.find('world_spawner', row.spawnerId)
    const actionId = spawner.objectType === 21 ? 13 : 136
    const action = tables.get('world_interact').find((value) => value.interactAction === actionId)
    const coords = row.position.split('|').map(Number)
    const height = tables.find('world_item', spawner.resourceId)?.rewardHeight ?? 0
    const pos = Object.fromEntries(['x', 'y', 'z'].map((axis, index) => [axis, Math.round(coords[index] * 100)]))
    const rewardPos = { ...pos, y: Math.round((coords[1] + height) * 100) }
    return {
        row,
        spawner,
        pos,
        request: {
            objs: [
                {
                    obj: { obj_id: row.id, complete: true, state_data: {}, pos: rewardPos },
                    pos: rewardPos,
                    interact_id: action.id,
                    interact_type: 0,
                    tool_type: 0,
                    tool_cfg_id: 0,
                    element_id: 0,
                    drop_type: 0,
                },
            ],
        },
    }
}

export function pointCheckpoint(tables, objectId = 200128) {
    const source = pointSource(tables, objectId)
    return {
        world: { map_id: 100, pos: source.pos, points: [] },
        tasks: [{ task_id: 106010, finish_nodes: [185] }],
        taskRecords: [],
        player: { basic_info: { id: 718, lv: 15 } },
    }
}

export function naturalPointFixture(name) {
    const config = configuration()
    const protocol = new Protocol(config.base)
    const tables = new Tables(config.tables)
    const store = new Store(':memory:')
    const session = {}
    let sequence = 1
    const nowMs = 1800000000000
    const game = new Game(protocol, store, tables, { clock: () => nowMs / 1000, arenaClockMs: () => nowMs })
    const frame = (name, request = {}) => {
        const entry = protocol.byName.get(`CSProto${name}`)
        return {
            id: entry.id,
            seq: sequence++,
            payload: entry.req ? protocol.encode(entry.req, request) : Buffer.alloc(0),
        }
    }
    const call = (name, request, target = session) => game.dispatch(target, frame(name, request))
    const login = (target = session) => call('EnterGame', { open_id: `natural-point-leaf-${name}` }, target)
    const state = () => store.load(session.id).state
    const edit = (fn) => store.transact(session.id, 0, fn)
    login()
    // Explicit LEAF checkpoint: legitimate saved185 completion and currently
    // active153, not an end-to-end startup/capture reproduction. No10050,
    // node153 result or current natural-interaction receipt is seeded.
    edit((draft) => {
        const source = pointSource(tables)
        Object.assign(draft.world, { map_id: 100, pos: source.pos, points: [10001] })
        draft.tasks = []
        const graph = new TaskGraphs(tables).get(106010)
        const task = acceptTask(graph, draft, nowMs / 1000)
        task.nodes = [makeNode(graph, 153, draft)]
        task.finish_nodes = [185]
        draft.worldObjects ??= {}
        delete draft.worldObjects['100:200128']
        delete draft.worldObjects['100:201037']
    })
    const decode = (packets, id) =>
        protocol.decode(protocol.byId.get(id).rsp, packets.find((packet) => packet.id === id).payload)
    const move = (source) =>
        edit((draft) => {
            draft.world.pos = source.pos
        })
    return { protocol, tables, store, game, session, frame, call, login, state, edit, decode, move }
}
