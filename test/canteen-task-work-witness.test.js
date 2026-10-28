import test from 'node:test'
import assert from 'node:assert/strict'
import { productionWorkGameFixture } from './production-work-game-fixture.js'
import { Game } from '../src/game.js'
import { TaskGraphs, makeNode, conditionValue, nodeConditions } from '../src/tasks.js'
import { deliveryKey } from '../src/task-delivery.js'
import { guidedConditionValue } from '../src/guided-conditions.js'
import { ErrorCode } from '../src/error-codes.js'
import policy from '../configs/production-work-policy.json' with { type: 'json' }

const taskId = 106015,
    nodeId = 69,
    guidedId = 10048
function fixture(name, { satiety = 0, active = true, before = true } = {}) {
    const f = productionWorkGameFixture(name, { satiety })
    const game = new Game(f.protocol, f.store, f.tables, {
        clock: f.now,
        productionWorkPolicy: structuredClone(policy),
    })
    let seq = 100
    const call = (name, request = {}, session = f.session) => {
        const entry = f.protocol.byName.get('CSProto' + name)
        return game.dispatch(session, {
            id: entry.id,
            seq: seq++,
            payload: entry.req ? f.protocol.encode(entry.req, request) : Buffer.alloc(0),
        })
    }
    const graph = new TaskGraphs(f.tables).get(taskId)
    f.edit((state) => {
        state.player.basic_info.lv = 16
        state.tasks = active
            ? [
                  {
                      task_id: taskId,
                      nodes: [makeNode(graph, nodeId, state)],
                      finish_nodes: [1, 71, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 43, 73, 23, 62, 68, 67],
                      reward_nodes: [],
                      client_trace: true,
                  },
              ]
            : []
        state.taskRecords = f.tables
            .get('task')
            .filter((row) => row.type === 1 && row.id !== taskId)
            .map((row) => ({ task_id: row.id, count: 1, time: 1 }))
        state.taskEpochs[taskId] = 1
        state.player.sbag_infos.items.find((row) => row.itemid === 9002901).itemnum = 1
    })
    if (active && before) call('TaskClientBefore', { task_id: taskId, node_id: nodeId })
    const currentNode = () =>
        f
            .state()
            .tasks.find((task) => task.task_id === taskId)
            ?.nodes.find((node) => node.node_id === nodeId)
    const deposit = () =>
        call('AddPetFood', {
            build_guid: 992951,
            operate_type: 1,
            items: [{ itemtype: 3, itemid: 9002901, itemnum: 1 }],
        })
    const key = () => deliveryKey(f.state(), taskId, nodeId, 0)
    const earn = () => {
        call('ProductStart', { build_guid: 1, product_id: 302001, count: 2 })
        return deposit()
    }
    const syncedValues = (packets) =>
        packets
            .filter((packet) => packet.id === 9853)
            .flatMap((packet) => f.protocol.decode('SCTaskSync', packet.payload).tasks ?? [])
            .filter((task) => task.task_id === taskId)
            .flatMap((task) => task.nodes ?? [])
            .filter((node) => node.node_id === nodeId)
            .map((node) => node.node_values[0])
    return { ...f, game, call, graph, currentNode, deposit, key, earn, syncedValues }
}

test('last real dish consumed by work retains only its active task-step snapshot through normal CondAfter and After', () => {
    const f = fixture('work-task-last-dish')
    try {
        const packets = f.earn()
        assert.equal(f.bag(9002901), 0)
        assert.equal(f.canteen().food_value, 0)
        assert.equal(guidedConditionValue(guidedId, f.state()), 0, 'Underlying inventory predicate stays current')
        assert.equal(f.currentNode().node_values[0], 1)
        assert(f.syncedValues(packets).includes(1))
        const record = f.state().taskWorkFoodWitnesses[f.key()]
        assert.equal(record.value, 1)
        assert.equal(record.source.kind, 'production-work-feeding')
        const totals = structuredClone(f.state().home.productionWork.stats)
        assert.throws(() => f.call('TaskClientAfter', { task_id: taskId, node_id: nodeId }), /not complete/)
        f.call('TaskClientCondAfter', { task_id: taskId, node_id: nodeId, indexes: [0] })
        assert(f.currentNode().client_cond_after[0])
        assert(f.state().taskWorkFoodWitnesses[f.key()], 'After still needs the same witness')
        f.call('TaskClientAfter', { task_id: taskId, node_id: nodeId })
        assert(
            f
                .state()
                .tasks.find((task) => task.task_id === taskId)
                .finish_nodes.includes(nodeId),
        )
        assert.equal(f.state().taskWorkFoodWitnesses, undefined)
        f.call('TaskClientAfter', { task_id: taskId, node_id: nodeId })
        assert.deepEqual(f.state().home.productionWork.stats, totals)
    } finally {
        f.close()
    }
})

test('actual feeding without an active step or acknowledged Before creates no task witness', () => {
    for (const options of [{ active: false }, { before: false }]) {
        const f = fixture('work-task-inactive-' + JSON.stringify(options), options)
        try {
            f.earn()
            assert(f.pet().satiety_val > 0)
            assert.equal(f.state().taskWorkFoodWitnesses, undefined)
            if (options.before === false)
                assert.throws(
                    () => f.call('TaskClientCondAfter', { task_id: taskId, node_id: nodeId, indexes: [0] }),
                    /pre-action/,
                )
        } finally {
            f.close()
        }
    }
})

test('ordinary withdrawal remains a dynamic inventory condition even after CondAfter and forged node values do not count', () => {
    const f = fixture('work-task-withdraw-current')
    try {
        f.deposit()
        assert.equal(guidedConditionValue(guidedId, f.state()), 1)
        assert.equal(f.state().taskWorkFoodWitnesses, undefined)
        f.call('TaskClientCondAfter', { task_id: taskId, node_id: nodeId, indexes: [0] })
        f.call('AddPetFood', {
            build_guid: 992951,
            operate_type: 0,
            items: [{ itemtype: 3, itemid: 9002901, itemnum: 1 }],
        })
        assert.equal(guidedConditionValue(guidedId, f.state()), 0)
        assert.equal(f.currentNode().node_values[0], 0)
        assert.equal(f.state().taskWorkFoodWitnesses, undefined)
        f.edit((state) => {
            const node = state.tasks.find((task) => task.task_id === taskId).nodes[0]
            node.node_values[0] = 99
            node.client_cond_after[0] = true
        })
        assert.throws(() => f.call('TaskClientAfter', { task_id: taskId, node_id: nodeId }), /not complete/)
    } finally {
        f.close()
    }
})

test('old epoch, changed condition fingerprint, fabricated value and same-epoch rebuilt Before cannot reuse a witness', () => {
    for (const variant of ['epoch', 'fingerprint', 'forged-value', 'rewind']) {
        const f = fixture('work-task-invalid-' + variant)
        try {
            f.earn()
            const condition = structuredClone(nodeConditions(f.graph.nodes.get(nodeId))[0])
            condition.__type_TaskConditionBaseData.conditionInfoId++
            assert.equal(
                conditionValue(condition, f.state(), { taskId, nodeId, index: 0 }),
                0,
                'Complete graph-condition fingerprint is binding',
            )
            f.edit((state) => {
                if (variant === 'epoch') state.taskEpochs[taskId]++
                if (variant === 'fingerprint') state.taskWorkFoodWitnesses[f.key()].fingerprint = '0'.repeat(64)
                if (variant === 'forged-value') state.taskWorkFoodWitnesses[f.key()].value++
                if (variant === 'rewind') {
                    const task = state.tasks.find((row) => row.task_id === taskId)
                    task.nodes = [makeNode(f.graph, nodeId, state)]
                }
            })
            if (variant === 'rewind') {
                const packets = f.call('TaskClientBefore', { task_id: taskId, node_id: nodeId })
                assert.equal(f.currentNode().node_values[0], 0)
                assert(f.syncedValues(packets).every((value) => value === 0))
                assert.equal(f.state().taskWorkFoodWitnesses, undefined)
            }
            const before = structuredClone(f.state())
            assert.throws(
                () => f.call('TaskClientCondAfter', { task_id: taskId, node_id: nodeId, indexes: [0] }),
                variant === 'forged-value' ? (error) => error.code === ErrorCode.GameConfig : /not complete/,
            )
            assert.deepEqual(f.state(), before)
        } finally {
            f.close()
        }
    }
})

test('real tick and login feeding publish final positive TaskSync, including an existing epoch after scope shrinks', () => {
    for (const variant of ['tick', 'login']) {
        const f = fixture('work-task-' + variant, { satiety: 1 })
        try {
            f.call('ProductStart', { build_guid: 1, product_id: 302001, count: 2 })
            const admitted = f.deposit()
            assert.equal(
                f.state().taskWorkFoodWitnesses,
                undefined,
                'No feeding happened while the current unit was admitted',
            )
            f.advance(f.job().seconds, false)
            let packets
            if (variant === 'tick') {
                f.game.productionWorkPolicy = { ...structuredClone(policy), scope: [] }
                const raw = [],
                    packet = f.game.packet.bind(f.game)
                f.game.packet = (...args) => {
                    const value = packet(...args)
                    raw.push(value)
                    return value
                }
                packets = f.game.tick(f.session.id, f.session)
                f.game.packet = packet
                assert(f.syncedValues(raw).includes(1), 'Tick creates final positive TaskSync before deduplication')
                assert(f.syncedValues(admitted).includes(1), 'Client already received the identical inventory value')
                assert(
                    !f.syncedValues(packets).includes(0),
                    'Sync deduplication must not replace the witness with zero',
                )
            } else packets = f.call('EnterGame', { open_id: 'work-task-' + variant }, {})
            assert.equal(f.canteen().food_value, 0)
            assert.equal(guidedConditionValue(guidedId, f.state()), 0)
            assert(f.state().taskWorkFoodWitnesses[f.key()])
            assert.equal(f.currentNode().node_values[0], 1)
            if (variant === 'login') assert(f.syncedValues(packets).includes(1))
        } finally {
            f.close()
        }
    }
})

test('TaskSync codec and SQLite failures roll back food, inventory, model recovery, witness and pending references together', () => {
    const f = fixture('work-task-witness-atomic')
    try {
        f.call('ProductStart', { build_guid: 1, product_id: 302001, count: 2 })
        f.store.transact(
            f.session.id,
            0,
            (state) => {
                state.workWitnessMarker = 'pending'
            },
            { defer: true },
        )
        const before = structuredClone(f.state()),
            pending = f.store.pending.get(f.session.id),
            sql = () => f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
            saved = sql(),
            encode = f.protocol.encode.bind(f.protocol)
        f.protocol.encode = (name, value) => {
            if (name.split('.').at(-1) === 'SCTaskSync') throw Error('injected witness TaskSync')
            return encode(name, value)
        }
        assert.throws(() => f.deposit(), /injected witness TaskSync/)
        assert.deepEqual(f.state(), before)
        assert.equal(f.store.pending.get(f.session.id), pending)
        assert.deepEqual(sql(), saved)
        f.protocol.encode = encode
        f.store.db.exec(
            "CREATE TRIGGER reject_food_witness BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'injected witness SQL'); END",
        )
        assert.throws(() => f.deposit(), /injected witness SQL/)
        assert.deepEqual(f.state(), before)
        assert.equal(f.store.pending.get(f.session.id), pending)
        assert.deepEqual(sql(), saved)
        f.store.db.exec('DROP TRIGGER reject_food_witness')
        f.deposit()
        const totals = structuredClone(f.state().home.productionWork.stats)
        f.call('TaskClientCondAfter', { task_id: taskId, node_id: nodeId, indexes: [0] })
        assert.deepEqual(f.state().home.productionWork.stats, totals)
        assert.equal(f.bag(9002901), 0)
    } finally {
        f.close()
    }
})
