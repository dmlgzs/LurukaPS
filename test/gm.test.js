import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { TaskGraphs, makeNode } from '../src/tasks.js'
const config = configuration(),
    protocol = new Protocol(config.base),
    tables = new Tables(config.tables)
const text = (s) => Buffer.from(s).toString('base64')
const command = (name, args = []) => ({ command: text(name), args: args.map((x) => text(String(x))) })
function fixture(options) {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables, options),
        session = {}
    const call = (name, r) => {
        const e = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: e.id, seq: 1, payload: protocol.encode(e.req, r) })
            .map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    }
    call('EnterGame', { open_id: 'gm-test' })
    return { store, session, call, state: () => store.load(session.id).state }
}
test('GM command grammar grants through normal rewards and returns readable results', () => {
    const f = fixture()
    try {
        const result = f.call('GMCommand', command('item', [300000, 5]))
        assert.equal(f.state().player.sbag_infos.items.find((i) => i.itemid === 300000).itemnum, 5)
        assert.equal(result.at(-1).id, 19903)
        assert.match(Buffer.from(result.at(-1).data.result, 'base64').toString(), /Granted 3:300000 x5/)
        f.call('GMCommands', { cmds: [command('gold 100'), command('diamond', [10])] })
        assert.equal(f.state().player.basic_info.gold, 100)
        assert.equal(f.state().player.basic_info.diamond, 10)
        assert.match(
            Buffer.from(f.call('GMCommand', command('help')).at(-1).data.result, 'base64').toString(),
            /teleport|tp/,
        )
    } finally {
        f.store.close()
    }
})
test('GM batches roll back all earlier effects for unknown or invalid commands', () => {
    const f = fixture()
    try {
        const before = f.store.load(f.session.id)
        for (const invalid of [
            command('exec', ['whoami']),
            command('item', [300000, -1]),
            command('item', [999999999, 1]),
            command('level', [999]),
        ]) {
            assert.throws(() => f.call('GMCommands', { cmds: [command('gold', [10]), invalid] }))
            assert.deepEqual(f.store.load(f.session.id), before)
        }
    } finally {
        f.store.close()
    }
})
test('GM heal/level/teleport update owned state and normal synchronization', () => {
    const f = fixture()
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.player.heros_info.battle_infos[0].hp = 0
            s.player.heros_info.battle_infos[0].sp = 0
            s.player.heros_info.battle_infos[0].alive_state = 1
        })
        const heal = f.call('GMCommand', command('heal'))
        assert(f.state().player.heros_info.battle_infos[0].hp > 0)
        assert(heal.some((p) => p.id === 10009))
        f.call('GMCommand', command('level', [10]))
        assert.equal(f.state().player.basic_info.lv, 10)
        assert.equal(f.state().player.basic_info.exp, 0)
        const point = tables.get('world_borthpos').find((p) => p.cityId !== f.state().world.map_id)
        const tp = f.call('GMCommand', command('tp', [point.id]))
        assert.equal(f.state().world.map_id, point.cityId)
        assert.equal(f.state().worldHistory.length, 1)
        assert(tp.some((p) => p.id === 9103))
    } finally {
        f.store.close()
    }
})
test('GM taskgoal completes only the first incomplete objective of the current task flow', () => {
    const f = fixture()
    try {
        const graph = new TaskGraphs(tables).get(106002)
        f.store.transact(f.session.id, 0, (s) => {
            s.world.map_id = 102
            s.taskRecords = [{ task_id: 106001, count: 1, time: 1 }]
            s.taskEpochs[106002] = 1
            s.tasks = [
                {
                    task_id: 106002,
                    nodes: [{ ...makeNode(graph, 56, s), client_before: true }],
                    finish_nodes: [1],
                    reward_nodes: [],
                    client_trace: true,
                },
            ]
        })
        const packets = f.call('GMCommand', command('taskgoal')),
            state = f.state(),
            node = state.tasks[0].nodes[0]
        assert.deepEqual(node.node_values, [2, 0])
        assert.equal(state.taskGoalOverrides['106002:1:56:0'], 2)
        assert.equal(node.node_id, 56)
        assert(packets.some((p) => p.id === 9853))
        assert.match(Buffer.from(packets.at(-1).data.result, 'base64').toString(), /Completed task goal 106002\/56\/0/)
        f.call('TaskClientCondAfter', { task_id: 106002, node_id: 56, indexes: [0] })
        assert.equal(f.state().tasks[0].nodes[0].client_cond_after[0], true)
        assert.throws(() => f.call('GMCommand', command('taskgoal')), /no incomplete objective/)
    } finally {
        f.store.close()
    }
})
test('GM unlockmaps exposes all configured world areas without completing server tasks', () => {
    const f = fixture()
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.world.points = []
            delete s.world.unlockAllMaps
            s.taskRecords = []
        })
        const packets = f.call('GMCommand', command('unlockmaps')),
            state = f.state(),
            pointSync = packets.find((p) => p.id === 9105),
            taskSync = packets.find((p) => p.id === 9853),
            records = taskSync.data.task_records
        assert.equal(state.world.unlockAllMaps, true)
        assert.equal(state.world.points.length, tables.get('world_borthpos').length)
        assert.deepEqual(pointSync.data.u32s, state.world.points)
        assert(records.some((r) => r.task_id === 106009 && r.count === 1))
        assert(records.some((r) => r.task_id === 400201 && r.count === 1))
        assert.deepEqual(state.taskRecords, [])
        assert.match(Buffer.from(packets.at(-1).data.result, 'base64').toString(), /Unlocked all world maps/)
    } finally {
        f.store.close()
    }
})
test('GM can be disabled without modifying player data', () => {
    const f = fixture({ gmEnabled: false })
    try {
        const before = f.store.load(f.session.id)
        assert.throws(() => f.call('GMCommand', command('gold', [10])), /disabled/)
        assert.deepEqual(f.store.load(f.session.id), before)
    } finally {
        f.store.close()
    }
})

test('GM acceptall and world-chat slash command use real task tables and publish new task IDs', () => {
    const f = fixture()
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.player.basic_info.lv = 50
            s.world.map_id = 100
        })
        const before = f.state(),
            mainIds = before.tasks.filter((t) => tables.find('task', t.task_id)?.type === 1).map((t) => t.task_id)
        const packets = f.call('AddChat', { target: { chat_type: 2, tid: '0' }, msg: text('/acceptall'), type: 0 })
        const sync = packets.find((p) => p.id === 9853 && p.data.new_task_ids?.length)
        assert.ok(sync)
        for (const id of sync.data.new_task_ids) {
            assert.notEqual(tables.find('task', id).type, 1)
            assert.doesNotMatch(tables.find('task', id).name, /\[(dev|test)\]/i)
            assert.ok(!before.tasks.some((t) => t.task_id === id))
            assert.ok(!(before.taskRecords ?? []).some((t) => t.task_id === id && t.count > 0))
            assert.ok(f.state().tasks.some((t) => t.task_id === id))
        }
        assert.deepEqual(
            f
                .state()
                .tasks.filter((t) => tables.find('task', t.task_id)?.type === 1)
                .map((t) => t.task_id),
            mainIds,
        )
        const again = f.call('GMCommand', command('acceptall'))
        const result = again.find((p) => p.id === 19903)
        assert.match(Buffer.from(result.data.result, 'base64').toString(), /Accepted 0/)
        assert.throws(() => f.call('GMCommand', command('acceptall 1')), /Usage/)
        assert.throws(() => f.call('GMCommand', command('acceptall dev extra')), /Usage/)
        const withDev = f.call('GMCommand', command('acceptall', ['dev']))
        const devSync = withDev.find((p) => p.id === 9853 && p.data.new_task_ids?.length)
        assert.ok(devSync.data.new_task_ids.includes(100020))
        for (const id of devSync.data.new_task_ids) {
            assert.notEqual(tables.find('task', id).type, 1)
            assert.ok(!sync.data.new_task_ids.includes(id))
        }
        const devAgain = f.call('GMCommand', command('acceptall dev')).find((p) => p.id === 19903)
        assert.match(Buffer.from(devAgain.data.result, 'base64').toString(), /Accepted 0/)
    } finally {
        f.store.close()
    }
})

test('cleardevtasks removes only active dev tasks, syncs deletion and preserves completion/reward receipts', () => {
    const f = fixture()
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.tasks.push({ task_id: 100020, nodes: [], finish_nodes: [], reward_nodes: [], client_trace: true })
            s.pendingTaskStorySync = { task_id: 100020, stories: [], extra: {} }
            s.pendingTaskScene = { task_id: 100020, map_id: 101 }
            s.pendingCharacterTask = { task_id: 100020, node_id: 1, epoch: 1 }
            s.taskRecords = [{ task_id: 100021, count: 1, time: 1 }]
            s.taskFinishReceipts = { '100021:1': [] }
        })
        const before = f.state()
        const packets = f.call('AddChat', { target: { chat_type: 2, tid: '0' }, msg: text('/cleardevtasks'), type: 0 })
        const sync = packets.find((p) => p.id === 9853 && p.data.del_tasks?.includes(100020))
        assert.ok(sync)
        assert.deepEqual(sync.data.del_tasks, [100020])
        assert.deepEqual(sync.data.del_trace_list, [100020])
        const state = f.state()
        assert.deepEqual(
            state.tasks.map((t) => t.task_id),
            before.tasks.filter((t) => t.task_id !== 100020).map((t) => t.task_id),
        )
        assert.equal(state.pendingTaskStorySync, undefined)
        assert.equal(state.pendingTaskScene, undefined)
        assert.equal(state.pendingCharacterTask, undefined)
        assert.deepEqual(state.taskRecords, before.taskRecords)
        assert.deepEqual(state.taskFinishReceipts, before.taskFinishReceipts)
        const result = f.call('GMCommand', command('cleardevtasks')).find((p) => p.id === 19903)
        assert.match(Buffer.from(result.data.result, 'base64').toString(), /Removed 0/)
        assert.throws(() => f.call('GMCommand', command('cleardevtasks all')), /Usage/)
    } finally {
        f.store.close()
    }
})

test('giveallgifts grants every table-backed ordinary and furniture hero gift 999 each through central inventory', () => {
    const f = fixture()
    try {
        const items = tables
            .get('common_item')
            .filter((i) =>
                i.type === 110
                    ? !!tables.find('hero_favorability_gift', i.id)
                    : i.type === 111
                      ? !!tables.find('home_dorm_furniture', i.id)
                      : false,
            )
        assert.equal(items.length, 22)
        const quantity = (s, id) =>
            s.player.sbag_infos.items.filter((i) => i.itemid === id).reduce((sum, i) => sum + i.itemnum, 0)
        const before = f.state()
        const result = f.call('GMCommand', command('giveallgifts'))
        for (const i of items) assert.equal(quantity(f.state(), i.id), quantity(before, i.id) + 999)
        assert.equal(quantity(f.state(), 300000), quantity(before, 300000))
        assert.match(
            Buffer.from(result.find((p) => p.id === 19903).data.result, 'base64').toString(),
            /22 hero gifts x999/,
        )
        const saved = f.state()
        assert.throws(() => f.call('GMCommand', command('giveallgifts', ['extra'])), /Usage/)
        assert.deepEqual(f.state(), saved)
        // The existing world-channel slash route uses the same implementation.
        f.call('AddChat', { target: { chat_type: 2, tid: '0' }, msg: text('/giveallgifts'), type: 0 })
        for (const i of items) assert.equal(quantity(f.state(), i.id), quantity(before, i.id) + 1998)
    } finally {
        f.store.close()
    }
})
