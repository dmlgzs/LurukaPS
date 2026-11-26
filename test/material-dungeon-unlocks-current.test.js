import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { TaskGraphs, makeNode } from '../src/tasks.js'
import { getEntrustCatalog } from '../src/entrust.js'
import { materialDungeonUnlocked } from '../src/material-dungeons.js'
import { ErrorCode } from '../src/error-codes.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    rule = tables.find('dungeon_material', 30101).unlock
const code = (expected) => (error) => error.code === expected
const state = (extra = {}) => ({ player: { basic_info: { lv: 15 } }, tasks: [], taskRecords: [], ...extra })

test('current12045 material gate uses an exact completed node, not a visible/acknowledged node or another task', () => {
    assert.equal(rule, '2004#15|12045#106015#24')
    assert(!materialDungeonUnlocked(rule, state()))
    for (const task of [
        { task_id: 106015, finish_nodes: [23, 25] },
        { task_id: 106014, finish_nodes: [24] },
        { task_id: 106015, nodes: [{ node_id: 24, client_before: true, client_cond_after: [true] }], finish_nodes: [] },
    ])
        assert(!materialDungeonUnlocked(rule, state({ tasks: [task] })))
    assert(materialDungeonUnlocked(rule, state({ tasks: [{ task_id: 106015, finish_nodes: [24] }] })))
    const low = state({ tasks: [{ task_id: 106015, finish_nodes: [24] }] })
    low.player.basic_info.lv = 14
    assert(!materialDungeonUnlocked(rule, low))
})

test('archived task completion unlocks only when no active attempt overrides its old completion history', () => {
    assert(materialDungeonUnlocked(rule, state({ taskRecords: [{ task_id: 106015, count: 1, time: 1 }] })))
    assert(!materialDungeonUnlocked(rule, state({ taskRecords: [{ task_id: 106015, count: 0, time: 1 }] })))
    assert(!materialDungeonUnlocked(rule, state({ taskRecords: [{ task_id: 106014, count: 1, time: 1 }] })))
    const repeated = state({
        tasks: [{ task_id: 106015, finish_nodes: [23] }],
        taskRecords: [{ task_id: 106015, count: 2, time: 1 }],
    })
    assert(
        !materialDungeonUnlocked(rule, repeated),
        'active attempt must not inherit a completed node from prior history',
    )
    repeated.tasks[0].finish_nodes.push(24)
    assert(materialDungeonUnlocked(rule, repeated))
})

test('all ten current task-node-gated material entries retain their own level gate and supported clear conditions', () => {
    const rows = tables.get('dungeon_material').filter((row) => row.unlock.includes('12045#'))
    assert.equal(rows.length, 10)
    for (const row of rows) {
        const [level] = row.unlock
            .split('|')
            .filter((x) => x.startsWith('2004#'))
            .map((x) => Number(x.split('#')[1]))
        const token = row.unlock.split('|').find((x) => x.startsWith('12045#')),
            [, taskId, nodeId] = token.split('#').map(Number)
        const s = state({ tasks: [{ task_id: taskId, finish_nodes: [nodeId] }] })
        s.player.basic_info.lv = level
        assert(materialDungeonUnlocked(row.unlock, s))
        s.player.basic_info.lv = level - 1
        assert(!materialDungeonUnlocked(row.unlock, s))
    }
    const s = state({ materialDungeonRecords: { 30101: { success_count: 1, material_star: 0 } } })
    assert(materialDungeonUnlocked('2004#15|13112#30101#1', s))
    assert(!materialDungeonUnlocked('13112#30101#2', s))
    s.materialDungeonRecords[30101].material_star = 3
    assert(materialDungeonUnlocked('13112#30101#2', s))
    assert(!materialDungeonUnlocked('13112#30101#3', s))
})

test('malformed task-node conditions and corrupted completion state fail explicitly; unknown conditions remain unsupported', () => {
    for (const text of ['12045#106015', '12045#106015#0', '12045#106015#-1', '12045#106015#24#1', '12045#106015#bad'])
        assert.throws(() => materialDungeonUnlocked(text, state()), code(ErrorCode.GameConfig))
    assert.throws(
        () => materialDungeonUnlocked(rule, state({ tasks: [{ task_id: 106015, finish_nodes: '24' }] })),
        code(ErrorCode.GameConfig),
    )
    assert.throws(
        () => materialDungeonUnlocked(rule, state({ taskRecords: [{ task_id: 106015, count: '1' }] })),
        code(ErrorCode.GameConfig),
    )
    assert.throws(() => materialDungeonUnlocked('999999#1#1', state()), code(ErrorCode.FunctionClosed))
})

test('real NPC step24 protocol completion opens current31960 without table overrides or fabricated clear/unlock records', () => {
    const protocol = new Protocol(cfg.base),
        store = new Store(':memory:'),
        session = {},
        game = new Game(protocol, store, tables, { clock: () => 1800000000 })
    let seq = 1
    const call = (name, data = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(session, {
                id: entry.id,
                seq: seq++,
                payload: entry.req ? protocol.encode(entry.req, data) : Buffer.alloc(0),
            })
            .map((packet) => ({
                id: packet.id,
                data: protocol.decode(protocol.byId.get(packet.id).rsp, packet.payload),
            }))
    }
    const saved = () => store.load(session.id).state,
        edit = (fn) => store.transact(session.id, 0, fn)
    const entryRequest = { dungeon_id: 31960, scene_type: 12 },
        graphs = new TaskGraphs(tables),
        graph = graphs.get(106015)
    try {
        call('EnterGame', { open_id: 'current-material-task-unlock' })
        edit((s) => {
            s.player.basic_info.lv = 15
            s.player.attr_infos.attrs.find((attr) => attr.attr_id === 3).attr_val = '500'
            s.taskEpochs ??= {}
            s.taskEpochs[106015] = 1
            s.tasks = [
                {
                    task_id: 106015,
                    nodes: [makeNode(graph, 24, s)],
                    finish_nodes: [22],
                    reward_nodes: [],
                    client_trace: true,
                    start_time: 1800000000,
                },
            ]
            s.taskRecords = (s.taskRecords ?? []).filter((row) => row.task_id !== 106015 && row.task_id !== 106014)
            s.taskRecords.push({ task_id: 106014, count: 1, time: 1799999999 })
            const npc = tables.find('worldmap_100', 400085),
                p = npc.position.split('|').map(Number)
            s.world.map_id = 100
            s.world.pos = { x: Math.round(p[0] * 100), y: Math.round(p[1] * 100), z: Math.round(p[2] * 100) }
        })
        let before = saved()
        assert.throws(() => call('MultiCampaignCreate', entryRequest), code(ErrorCode.EntrustUnlock))
        assert.deepEqual(saved(), before)
        call('TaskClientBefore', { task_id: 106015, node_id: 24 })
        assert.throws(
            () => call('TaskClientCondAfter', { task_id: 106015, node_id: 24, indexes: [0] }),
            /condition not complete/,
        )
        assert(!materialDungeonUnlocked(rule, saved()))
        call('ClientBehaviourRecord', { key: 1001, args: [400085, 106015, 24, 0, 1] })
        call('TaskClientCondAfter', { task_id: 106015, node_id: 24, indexes: [0] })
        assert(!materialDungeonUnlocked(rule, saved()), 'CondAfter is a condition receipt, not finish_nodes completion')
        call('TaskClientAfter', { task_id: 106015, node_id: 24 })
        assert(
            saved()
                .tasks.find((task) => task.task_id === 106015)
                .finish_nodes.includes(24),
        )
        assert(
            !saved().taskRecords.some((row) => row.task_id === 106015),
            'unlock came from the actual step, not an injected whole-task record',
        )
        assert(materialDungeonUnlocked(rule, saved()))
        before = saved()
        const config = getEntrustCatalog(tables).get(30101, 'material'),
            packets = call('MultiCampaignCreate', entryRequest),
            after = saved()
        assert(
            packets.some(
                (packet) =>
                    packet.id === protocol.byName.get('CSProtoCurMultiCampaignInfoSync').id &&
                    packet.data.dungeon_id === 31960,
            ),
            'current entry publishes its actual campaign notification; do not invent an ACK for a no-response request',
        )
        assert(
            packets.some(
                (packet) =>
                    packet.id === protocol.byName.get('CSProtoWorldMapSync').id &&
                    packet.data.map_id === config.scene.id,
            ),
        )
        assert.equal(after.world.map_id, config.scene.id)
        assert.equal(after.entrust.run.dungeon_id, 31960)
        assert.equal(after.entrust.run.entrust_id, 30101)
        assert.equal(after.entrust.run.status, 2)
        assert(!after.entrust.run.battle_complete)
        assert.equal(after.materialDungeonRecords?.[30101], undefined)
        assert.equal(
            after.player.attr_infos.attrs.find((attr) => attr.attr_id === 3).attr_val,
            before.player.attr_infos.attrs.find((attr) => attr.attr_id === 3).attr_val,
            'entry alone does not invent a paid chest/clear transaction',
        )
        assert.deepEqual(after.player.sbag_infos, before.player.sbag_infos)
        assert.equal(tables.find('dungeon_material', 30101).unlock, rule)
        call('MultiCampaignPlayerLoadFinish')
        assert.equal(saved().entrust.run.status, 2)
        call('MultiCampaignQuit')
        assert.equal(saved().world.map_id, before.world.map_id)
        assert.equal(saved().entrust.run, undefined)
        assert.equal(saved().materialDungeonRecords?.[30101], undefined)
    } finally {
        store.close()
    }
})
