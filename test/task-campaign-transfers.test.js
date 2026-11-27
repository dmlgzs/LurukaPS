import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { TaskGraphs, makeNode } from '../src/tasks.js'
import { storyCampaignConfig } from '../src/story-campaign.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base),
    graphs = new TaskGraphs(tables)

function fixture(name) {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => 1800000000 }),
        session = {}
    let seq = 1
    const call = (name, data = {}) => {
        const entry = protocol.byName.get(`CSProto${name}`)
        return game.dispatch(session, {
            id: entry.id,
            seq: seq++,
            payload: entry.req ? protocol.encode(entry.req, data) : Buffer.alloc(0),
        })
    }
    call('EnterGame', { open_id: name })
    return {
        store,
        call,
        state: () => store.load(session.id).state,
        edit: (fn) => store.transact(session.id, 0, fn),
        relogin: () => {
            const entry = protocol.byName.get('CSProtoEnterGame')
            return game.dispatch(
                {},
                { id: entry.id, seq: 1, payload: protocol.encode(entry.req, { open_id: name, reconnect: true }) },
            )
        },
    }
}

function seed(s, config, taskId, nodeId, pointId) {
    Object.assign(s.world, tables.position(tables.find('world_borthpos', pointId)))
    s.world.pos = { ...s.world.pos, x: s.world.pos.x + 183 }
    s.taskRecords = tables
        .get('task')
        .filter((row) => row.type === 1)
        .map((row) => ({ task_id: row.id, count: 1, time: 1 }))
    s.tasks = [
        { task_id: taskId, nodes: [makeNode(graphs.get(taskId), nodeId, s)], finish_nodes: [], reward_nodes: [] },
    ]
    s.storyCampaign = {
        dungeon_id: config.dungeon.id,
        group_id: config.dungeon.groupId,
        difficulty: config.dungeon.dungeonGroupOrder,
        instance_id: 77,
        task_ids: config.taskIds,
        scenes: config.scenes.map(({ scene }) => scene.id),
        map_id: s.world.map_id,
        completed_scenes: [],
        status: 2,
        start_time: 1800000000,
    }
    delete s.combat
}

test('task campaign scene catalog includes configured intermediate scenes beyond task checkpoints', () => {
    assert.deepEqual(
        storyCampaignConfig(tables, 205, 2).scenes.map(({ scene }) => scene.id),
        [6224, 6228, 6234],
    )
    assert.deepEqual(
        storyCampaignConfig(tables, 209, 1).scenes.map(({ scene }) => scene.id),
        [6206, 6210, 6211, 6212],
    )
})

test('TaskFinish never invents a same-scene or cross-scene checkpoint transfer in either multi-task campaign', () => {
    const f = fixture('campaign-checkpoint-audit')
    try {
        for (const [groupId, difficulty] of [
            [205, 2],
            [216, 1],
        ]) {
            const config = storyCampaignConfig(tables, groupId, difficulty)
            for (let i = 0; i < config.taskIds.length - 1; i++) {
                const id = config.taskIds[i]
                f.edit((s) => seed(s, config, id, graphs.get(id).end, config.taskPoints[i].id))
                const world = structuredClone(f.state().world)
                const packets = f.call('TaskFinish', { u32: id })
                assert.deepEqual(f.state().world, world, `task ${id} must not warp to the next checkpoint`)
                assert.ok(!packets.some((p) => p.id === 9103), `task ${id} must not reload a scene`)
                assert.equal(f.state().storyCampaign.map_id, world.map_id)
                assert.ok(f.state().tasks.some((t) => t.task_id === config.taskIds[i + 1]))
            }
        }
    } finally {
        f.store.close()
    }
})

for (const scenario of [
    {
        group: 205,
        difficulty: 2,
        task: 104010,
        oldScenes: [6224, 6228],
        from: 6228004,
        transfers: [
            [6, 6234001],
            [7, 6228005],
            [8, 6224009],
        ],
    },
    {
        group: 209,
        difficulty: 1,
        task: 323002,
        oldScenes: [6206],
        from: 620601,
        transfers: [
            [18, 6210001],
            [20, 6211001],
            [23, 6212001],
        ],
    },
]) {
    test(`task ${scenario.task} keeps its campaign during configured intermediate transfers and upgrades old scene lists`, () => {
        const f = fixture(`campaign-transfer-${scenario.task}`)
        try {
            const config = storyCampaignConfig(tables, scenario.group, scenario.difficulty)
            f.edit((s) => {
                seed(s, config, scenario.task, scenario.transfers[0][0], scenario.from)
                // Persisted runs created before this fix only know checkpoint maps.
                s.storyCampaign.scenes = scenario.oldScenes
            })
            const records = structuredClone(f.state().taskRecords)
            for (const [nodeId, pointId] of scenario.transfers) {
                f.edit((s) => {
                    s.tasks[0].nodes = [makeNode(graphs.get(scenario.task), nodeId, s)]
                })
                const point = tables.find('world_borthpos', pointId)
                const packets = f.call('EnterWorldMap', {
                    task_id: scenario.task,
                    node_id: nodeId,
                    point_id: pointId,
                    map_id: point.cityId,
                })
                assert.equal(
                    f.state().storyCampaign?.instance_id,
                    77,
                    'configured transfer must not be treated as quitting',
                )
                assert.equal(f.state().storyCampaign.map_id, point.cityId)
                assert.ok(f.state().storyCampaign.scenes.includes(point.cityId))
                assert.ok(f.state().tasks.some((t) => t.task_id === scenario.task))
                assert.deepEqual(f.state().taskRecords, records)
                assert.ok(
                    !packets
                        .filter((p) => p.id === 9853)
                        .some((p) => protocol.decode('SCTaskSync', p.payload).del_tasks.includes(scenario.task)),
                )
            }
            const world = structuredClone(f.state().world)
            assert.throws(
                () =>
                    f.call('EnterWorldMap', {
                        task_id: scenario.task,
                        node_id: scenario.transfers.at(-1)[0],
                        point_id: 10045,
                        map_id: 100,
                    }),
                /not configured/,
            )
            assert.deepEqual(f.state().world, world, 'unconfigured transfers remain rejected')
        } finally {
            f.store.close()
        }
    })
}

test('legacy internal return snapshots quit to the configured overworld entrance without deleting the parent', () => {
    const f = fixture('campaign-quit-legacy-return')
    try {
        const config = storyCampaignConfig(tables, 216, 1)
        f.edit((s) => {
            seed(s, config, 500011, 3, 623101)
            s.player.basic_info.lv = 20
            const parent = {
                task_id: 107016,
                nodes: [{ ...makeNode(graphs.get(107016), 26, s), client_before: true }],
                finish_nodes: [25],
                reward_nodes: [24],
                client_trace: true,
            }
            s.tasks.unshift(parent)
            s.taskRecords = s.taskRecords.filter((record) => record.task_id !== 107016)
            s.storyCampaign.entry_tasks = [structuredClone(parent)]
            s.storyCampaign.return_world = tables.position(tables.find('world_borthpos', 623201))
            s.worldHistory = [tables.position(tables.find('world_borthpos', 623106))]
        })
        const packets = f.call('CampaignQuit')
        assert.equal(f.state().world.map_id, 100)
        assert.equal(f.state().world.point_id, 10053)
        assert.equal(f.state().storyCampaign, undefined)
        assert.ok(!f.state().tasks.some((task) => config.taskIds.includes(task.task_id)))
        const parent = f.state().tasks.find((task) => task.task_id === 107016)
        assert.equal(parent.nodes[0].node_id, 26)
        assert.equal(parent.nodes[0].client_before, false)
        assert.deepEqual(parent.reward_nodes, [24])
        for (const packet of packets.filter((packet) => packet.id === 9853))
            assert.ok(!protocol.decode('SCTaskSync', packet.payload).del_tasks.includes(107016))
        f.call('TaskClientBefore', { task_id: 107016, node_id: 26 })
        assert.equal(f.state().storyCampaign, undefined, 'callbacks alone do not recreate a dungeon')
        f.call('CampaignCreate', { group_id: 216, difficulty: 1 })
        assert.equal(f.state().storyCampaign.return_world.map_id, 100)
        assert.equal(f.state().world.map_id, 6231)
        assert.equal(f.state().tasks.find((task) => task.task_id === 500011).client_trace, true)
    } finally {
        f.store.close()
    }
})

test('creation from an orphaned legacy dungeon repairs the next quit destination before saving it', () => {
    const f = fixture('campaign-create-orphan-return')
    try {
        const config = storyCampaignConfig(tables, 216, 1)
        f.edit((s) => {
            seed(s, config, 107016, 26, 623201)
            s.player.basic_info.lv = 20
            delete s.storyCampaign
            s.taskRecords = s.taskRecords.filter((record) => record.task_id !== 107016)
        })
        f.call('CampaignCreate', { group_id: 216, difficulty: 1 })
        assert.equal(f.state().storyCampaign.return_world.map_id, 100)
        assert.equal(f.state().storyCampaign.return_world.point_id, 10053)
        f.call('CampaignQuit')
        assert.equal(f.state().world.map_id, 100)
        assert.equal(f.state().storyCampaign, undefined)
    } finally {
        f.store.close()
    }
})

function seedCompletedEntry(s, config, withClear = true) {
    seed(s, config, 107016, 26, 10053)
    s.player.basic_info.lv = 20
    s.taskRecords = s.taskRecords.filter((record) => record.task_id !== 107016)
    s.taskRecords.push(...config.taskIds.map((task_id) => ({ task_id, count: 1, time: 1800000000 })))
    s.tasks[0].client_trace = true
    if (withClear) s.storyCampaignClears = { [config.dungeon.id]: { count: 1, time: 1800000000 } }
    delete s.storyCampaign
}

test('successful campaign auto-exit reconciles a cached entry Before reset and accepts the actual completion callbacks', () => {
    const f = fixture('campaign-clear-before-race')
    try {
        const config = storyCampaignConfig(tables, 216, 1)
        f.edit((s) => {
            seed(s, config, 500016, graphs.get(500016).end, 623302)
            s.player.basic_info.lv = 20
            const parent = {
                task_id: 107016,
                nodes: [makeNode(graphs.get(107016), 26, s)],
                finish_nodes: [25],
                reward_nodes: [24],
                client_trace: true,
            }
            s.tasks.unshift(parent)
            s.taskRecords = s.taskRecords.filter((record) => record.task_id !== 107016)
            s.taskRecords.push(
                ...config.taskIds.slice(0, -1).map((task_id) => ({ task_id, count: 1, time: 1800000000 })),
            )
            s.storyCampaign.entry_tasks = [structuredClone(parent)]
            s.storyCampaign.return_world = tables.position(tables.find('world_borthpos', 10053))
        })
        f.call('TaskFinish', { u32: 500016 })
        assert.equal(f.state().world.map_id, 100)
        assert.equal(f.state().storyCampaign, undefined)
        assert.equal(f.state().storyCampaignClears[10068].count, 1)
        const xp = f.state().player.basic_info.exp
        assert.equal(
            f.state().tasks.find((task) => task.task_id === 107016).nodes[0].node_id,
            26,
            'the current black-screen after-action still needs its normal client completion callback',
        )
        assert.equal(f.state().tasks.find((task) => task.task_id === 107016).nodes[0].client_before, true)
        f.call('TaskClientCondAfter', { task_id: 107016, node_id: 26, indexes: [0] })
        f.call('TaskClientAfter', { task_id: 107016, node_id: 26 })
        assert.equal(f.state().tasks.find((task) => task.task_id === 107016).nodes[0].node_id, 32)
        assert.equal(
            f.state().player.basic_info.exp,
            xp,
            'reconciling the acknowledgment must not grant clear XP again',
        )
    } finally {
        f.store.close()
    }
})

test('login repairs the completed legacy entry acknowledgment using all table-defined victory records', () => {
    const f = fixture('campaign-complete-recover')
    try {
        const config = storyCampaignConfig(tables, 216, 1)
        f.edit((s) => seedCompletedEntry(s, config))
        const xp = f.state().player.basic_info.exp
        f.relogin()
        assert.equal(
            f.state().tasks.find((task) => task.task_id === 107016).nodes[0].node_id,
            26,
            'a historical clear recovers Before without skipping the current after-action',
        )
        assert.equal(f.state().tasks.find((task) => task.task_id === 107016).nodes[0].client_before, true)
        f.call('TaskClientCondAfter', { task_id: 107016, node_id: 26, indexes: [0] })
        f.call('TaskClientAfter', { task_id: 107016, node_id: 26 })
        assert.equal(f.state().tasks.find((task) => task.task_id === 107016).nodes[0].node_id, 32)
        assert.equal(f.state().player.basic_info.exp, xp)
    } finally {
        f.store.close()
    }
})

test('a clear receipt without the full victory chain cannot bypass the normal Before requirement', () => {
    const f = fixture('campaign-incomplete-before')
    try {
        const config = storyCampaignConfig(tables, 216, 1)
        for (const completeReceipt of [false, true]) {
            f.edit((s) => {
                seedCompletedEntry(s, config, completeReceipt)
                if (!completeReceipt) delete s.storyCampaignClears
                else s.taskRecords = s.taskRecords.filter((record) => record.task_id !== config.taskIds[0])
            })
            f.relogin()
            assert.equal(f.state().tasks.find((task) => task.task_id === 107016).nodes[0].client_before, false)
            assert.throws(
                () => f.call('TaskClientCondAfter', { task_id: 107016, node_id: 26, indexes: [0] }),
                /pre-action is not acknowledged/,
            )
        }
    } finally {
        f.store.close()
    }
})

test('a cleared entry recovers after reentry erased mutable records, using durable finish receipts', () => {
    const f = fixture('campaign-clear-erased-records')
    try {
        const config = storyCampaignConfig(tables, 216, 1)
        f.edit((s) => {
            seedCompletedEntry(s, config)
            s.taskRecords = s.taskRecords.filter((record) => !config.taskIds.includes(record.task_id))
            s.taskFinishReceipts = Object.fromEntries(config.taskIds.map((id) => [id + ':1', []]))
            s.tasks[0].reward_nodes = [24]
        })
        const xp = f.state().player.basic_info.exp
        f.relogin()
        assert.equal(f.state().tasks.find((task) => task.task_id === 107016).nodes[0].node_id, 26)
        assert.equal(f.state().tasks.find((task) => task.task_id === 107016).nodes[0].client_before, true)
        f.call('TaskClientCondAfter', { task_id: 107016, node_id: 26, indexes: [0] })
        f.call('TaskClientAfter', { task_id: 107016, node_id: 26 })
        assert.equal(f.state().tasks.find((task) => task.task_id === 107016).nodes[0].node_id, 32)
        assert.deepEqual(f.state().tasks.find((task) => task.task_id === 107016).reward_nodes, [24])
        assert.equal(f.state().player.basic_info.exp, xp)
        assert.equal(f.state().storyCampaign, undefined)
    } finally {
        f.store.close()
    }
})

test('fresh campaign creation explicitly removes cached internal task completion records before publishing the new run', () => {
    const f = fixture('campaign-replay-cache-reset')
    try {
        const config = storyCampaignConfig(tables, 216, 1)
        f.edit((s) => {
            seedCompletedEntry(s, config, false)
            delete s.storyCampaignClears
        })
        const packets = f.call('CampaignCreate', { group_id: 216, difficulty: 1 })
        const syncs = packets
            .filter((packet) => packet.id === 9853)
            .map((packet) => protocol.decode('SCTaskSync', packet.payload))
        const reset = syncs.findIndex((sync) => config.taskIds.every((id) => sync.del_task_records.includes(id)))
        const start = syncs.findIndex((sync) => sync.tasks.some((task) => task.task_id === config.taskIds[0]))
        assert.ok(reset >= 0 && start > reset, 'old cached records must be removed before the current task is added')
        assert.ok(syncs[reset].del_tasks.includes(500011))
        assert.ok(!syncs[reset].del_tasks.includes(107016), 'keep parent automatic-entry preference')
        assert.ok(!f.state().taskRecords.some((record) => config.taskIds.includes(record.task_id)))
        assert.equal(f.state().tasks.find((task) => task.task_id === 500011).nodes[0].node_id, 3)
    } finally {
        f.store.close()
    }
})
