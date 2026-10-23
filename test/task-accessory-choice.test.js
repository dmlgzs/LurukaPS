import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { TaskGraphs, makeNode } from '../src/tasks.js'
import { ErrorCode } from '../src/error-codes.js'

const conf = configuration(),
    protocol = new Protocol(conf.base)
// Real exported graph; it is absent from the current task table. Inject only
// the active node to test its wire contract, not TaskAccept availability.
function setup(filename = ':memory:') {
    const tables = new Tables(conf.tables),
        originalFind = tables.find.bind(tables)
    // Only the task-table registration is synthetic. Keep its real exported
    // graph and all selected accessory configurations unmodified.
    const taskConfig = { ...originalFind('task', 206022), id: 816084 }
    tables.find = (name, id) => (name === 'task' && Number(id) === 816084 ? taskConfig : originalFind(name, id))
    let store = new Store(filename),
        game = new Game(protocol, store, tables),
        session = {},
        seq = 1
    const call = (name, request) => {
        const p = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: p.id, seq: seq++, payload: protocol.encode(p.req, request) })
    }
    const login = () => {
        session = {}
        return call('EnterGame', { open_id: 'accessory-choice' })
    }
    login()
    store.transact(session.id, 0, (s) => {
        s.world.map_id = 101
        s.taskEpochs = { 816084: 1 }
        s.tasks = [
            {
                task_id: 816084,
                finish_nodes: [],
                reward_nodes: [],
                nodes: [{ ...makeNode(new TaskGraphs(tables).get(816084), 3, s), client_before: true }],
            },
        ]
        s.ornaments = [
            { id: 1010211, guid: 4294967294, lock: false },
            { id: 1010211, guid: 4294967295, lock: false },
        ]
    })
    return {
        call,
        login,
        state: () => store.load(session.id).state,
        mutate: (fn) => store.transact(session.id, 0, fn),
        store: () => store,
        reopen: () => {
            store.close()
            store = new Store(filename)
            game = new Game(protocol, store, tables)
            login()
        },
        close: () => store.close(),
    }
}
const request = (guid = '4294967294', id = 1010211, count = 1) => ({
    task_id: 816084,
    node_id: 3,
    node_index: 0,
    items: [{ item_type: 15, item_id: id, item_count: count, item_guid: guid }],
})

test('9859 current accessory choice consumes explicit upper-range uint32 ornament instance, syncs deletion and advances through9862 once', () => {
    const c = setup()
    try {
        const packets = c.call('TaskSubmitItemChoose', request())
        assert.deepEqual(
            c.state().ornaments.map((o) => o.guid),
            [4294967295],
        )
        const deletion = packets.find((p) => p.id === protocol.byName.get('CSProtoUpdateOrnament').id)
        assert.ok(deletion)
        assert.deepEqual(
            protocol.decode(protocol.byName.get('CSProtoUpdateOrnament').rsp, deletion.payload).guid,
            [4294967294],
        )
        assert.ok(packets.indexOf(deletion) < packets.findIndex((p) => p.id === 9859))
        assert.equal(c.state().tasks[0].nodes[0].node_values[0], 1)
        assert.equal(c.state().ornamentSmeltNum, undefined)
        const receipt = c.state().taskInstanceDeliveries
        c.call('TaskSubmitItemChoose', request())
        assert.deepEqual(c.state().taskInstanceDeliveries, receipt)
        assert.throws(() => c.call('TaskSubmitItem', request()), /protocol/)
        assert.throws(() => c.call('TaskSubmitItemType', request()), /protocol/)
        c.call('TaskClientAfter', { task_id: 816084, node_id: 3 })
        assert.ok(c.state().tasks[0].finish_nodes.includes(3))
        c.call('TaskSubmitItemChoose', request())
        assert.deepEqual(c.state().taskInstanceDeliveries, receipt)
        assert.equal(c.state().ornaments.length, 1)
        c.mutate((s) => {
            s.tasks = []
            s.taskRecords = [{ task_id: 816084, count: 1 }]
        })
        c.call('TaskSubmitItemChoose', request())
        assert.equal(c.state().ornaments.length, 1)
    } finally {
        c.close()
    }
})

test('submission guards distinguish missing node, condition limits and each wire parameter error without spoiling receipts', () => {
    const c = setup()
    try {
        const reject = (name, r, code) => {
            const before = c.state()
            assert.throws(
                () => c.call(name, r),
                (e) => e.code === code,
            )
            assert.deepEqual(c.state(), before)
        }
        const check = () => {
            for (const name of ['TaskSubmitItem', 'TaskSubmitItemType', 'TaskSubmitItemChoose']) {
                reject(name, { ...request(), node_id: 999999 }, ErrorCode.TaskNoNodeId)
                reject(name, { ...request(), node_index: 1 }, ErrorCode.TaskNodeIndexLimit)
                reject(name, { ...request(), node_index: 0xffffffff }, ErrorCode.TaskNodeIndexLimit)
            }
            reject('TaskSubmitItem', request(), ErrorCode.SubItemParamError)
            reject('TaskSubmitItemType', request(), ErrorCode.SubmitItemTypeParamError)
            reject(
                'TaskSubmitItemChoose',
                { ...request(), task_id: 100002, node_id: 21 },
                ErrorCode.SubmitItemChooseParamError,
            )
        }
        check()
        c.call('TaskSubmitItemChoose', request())
        const receipt = c.state().taskInstanceDeliveries
        check()
        c.call('TaskSubmitItemChoose', request())
        assert.deepEqual(c.state().taskInstanceDeliveries, receipt)
        assert.equal(c.state().ornaments.length, 1)
    } finally {
        c.close()
    }
})

test('9859 protects lock, equipment, reverse equipment and temporary instances atomically', () => {
    for (const [mutate, code] of [
        [
            (s) => {
                s.ornaments[0].lock = true
            },
            ErrorCode.LockOrnament,
        ],
        [
            (s) => {
                s.ornaments[0].wear_hero = '7'
            },
            ErrorCode.EquipOrnament,
        ],
        [
            (s) => {
                s.player.heros_info.heros[0].oguid = [4294967294]
            },
            ErrorCode.EquipOrnament,
        ],
        [
            (s) => {
                s.ornaments[0].trail = true
            },
            ErrorCode.TaskSubmitItemChoseError,
        ],
    ]) {
        const c = setup()
        try {
            c.mutate(mutate)
            const before = c.state()
            assert.throws(
                () => c.call('TaskSubmitItemChoose', request()),
                (e) => e.code === code,
            )
            assert.deepEqual(c.state(), before)
        } finally {
            c.close()
        }
    }
})

test('9859 rejects missing configured old option, wrong option, mismatched identity, omitted and duplicate instances', () => {
    const c = setup()
    try {
        for (const r of [
            request('4294967294', 1010111),
            request('4294967294', 1110111),
            request('4294967294', 1010311),
            request('0'),
            request('4294967294', 1010211, 2),
            { ...request(), items: [] },
            { ...request(), items: [request().items[0], request().items[0]] },
        ]) {
            const before = c.state()
            assert.throws(() => c.call('TaskSubmitItemChoose', r))
            assert.deepEqual(c.state(), before)
        }
        c.call('TaskSubmitItemChoose', request())
        const done = c.state()
        assert.throws(() => c.call('TaskSubmitItemChoose', request('4294967295')), /fulfilled/)
        assert.deepEqual(c.state(), done)
        c.mutate((s) => {
            s.taskEpochs[816084]++
        })
        assert.throws(() => c.call('TaskSubmitItemChoose', request()))
    } finally {
        c.close()
    }
})

test('9859 uint64 container identities above uint32 cannot alias a valid ornament by truncation', () => {
    const c = setup()
    try {
        const before = c.state()
        // These low32 values match both legitimate instances in the fixture.
        for (const guid of ['8589934590', '8589934591', '9007199254740993']) {
            assert.throws(
                () => c.call('TaskSubmitItemChoose', request(guid)),
                (e) => e.code === ErrorCode.OrnamentNotExist,
            )
            assert.deepEqual(c.state(), before)
        }
    } finally {
        c.close()
    }
})

test('9859 deletion and acknowledgement encoding errors roll back inventory, phase and instance receipt', () => {
    for (const name of ['CSProtoUpdateOrnament', 'CSProtoTaskSubmitItemChoose', 'CSProtoTaskSync']) {
        const c = setup(),
            old = protocol.encode
        try {
            const before = c.state(),
                target = protocol.byName.get(name)
            assert.ok(target)
            protocol.encode = function (type, value) {
                if (type === target.rsp) throw Error('simulated choice encoding error')
                return old.call(this, type, value)
            }
            assert.throws(() => c.call('TaskSubmitItemChoose', request()), /simulated choice/)
            assert.deepEqual(c.state(), before)
        } finally {
            protocol.encode = old
            c.close()
        }
    }
})

test('9859 SQL failure is atomic and persisted receipt survives closing and reopening SQLite', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luruka-task-choice-')),
        filename = path.join(dir, 'player.sqlite')
    const c = setup(filename)
    try {
        const before = c.state()
        c.store().db.exec(
            "CREATE TRIGGER task_choice_fail BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT, 'choice sql failure'); END",
        )
        assert.throws(() => c.call('TaskSubmitItemChoose', request()), /choice sql failure/)
        assert.deepEqual(c.state(), before)
        c.store().db.exec('DROP TRIGGER task_choice_fail')
        c.call('TaskSubmitItemChoose', request())
        const receipts = c.state().taskInstanceDeliveries
        c.reopen()
        assert.deepEqual(c.state().taskInstanceDeliveries, receipts)
        assert.equal(c.state().ornaments.length, 1)
        c.call('TaskSubmitItemChoose', request())
        assert.equal(c.state().ornaments.length, 1)
        assert.deepEqual(c.state().taskInstanceDeliveries, receipts)
    } finally {
        c.close()
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
