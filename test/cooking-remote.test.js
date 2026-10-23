import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ErrorCode } from '../src/error-codes.js'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { TaskGraphs, makeNode } from '../src/tasks.js'
import { cookingRecipe, cookingMaterials } from '../src/cooking.js'
import { guidedConditionValue } from '../src/guided-conditions.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
const corn = { build_guid: 18, cook_id: 9000301, cook_count: 1, cook_material: [{ item_id: 400301, item_num: 6 }] }
function fixture(file = ':memory:') {
    let now = 1800000000,
        seq = 1
    const store = new Store(file),
        game = new Game(protocol, store, tables, { clock: () => now }),
        session = {}
    const call = (name, r = {}, who = session) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(who, { id: e.id, seq: seq++, payload: Buffer.isBuffer(r) ? r : protocol.encode(e.req, r) })
    }
    call('EnterGame', { open_id: 'cooking-remote-b07' })
    store.transact(session.id, 0, (state) => {
        state.world.map_id = 701
        state.player.basic_info.lv = 16
        for (const id of [22010, 22015, 22020])
            state.home.technology.levels[id] = { level: 1, lastTime: 0, isOpened: true }
        state.home.builds.push({
            guid: 18,
            build_id: 100011,
            build_type: 10,
            status: 1,
            locate: { block_id: 101, anchor: 6750237, direction: 0 },
            product: [],
        })
        state.home.inventory.push({ build_id: 100011, total_num: 1, used_num: 1, unlock: true })
        state.player.sbag_infos.items = [
            { itemid: 400301, itemnum: 34, itemtype: 3, guid: '21' },
            { itemid: 400101, itemnum: 30, itemtype: 3, guid: '22' },
            { itemid: 400302, itemnum: 18, itemtype: 3, guid: '23' },
            { itemid: 400102, itemnum: 18, itemtype: 3, guid: '24' },
            { itemid: 1400101, itemnum: 12, itemtype: 3, guid: '25' },
        ]
        state.taskEpochs[106016] = 1
        state.tasks = [
            {
                task_id: 106016,
                nodes: [{ ...makeNode(new TaskGraphs(tables).get(106016), 26, state), client_before: true }],
                finish_nodes: [1, 25],
                reward_nodes: [],
                client_trace: true,
            },
        ]
        state.taskRecords = tables
            .get('task')
            .filter((row) => row.type === 1 && row.id !== 106016)
            .map((row) => ({ task_id: row.id, count: 1, time: 1 }))
    })
    return {
        store,
        game,
        session,
        call,
        state: () => store.load(session.id).state,
        advance: (seconds) => {
            now += seconds
            return game.tick(session.id)
        },
    }
}
const stock = (state, id) => state.player.sbag_infos.items.find((item) => item.itemid === id)?.itemnum ?? 0

const request = {
    build_guid: 18,
    cook_id: 9000201,
    cook_count: 1,
    cook_material: [
        { item_id: 400101, item_num: 6 },
        { item_id: 400301, item_num: 6 },
    ],
}
test('10201 current remote home-center recipe works in big world, home and home interior without teleporting', () => {
    for (const map of [100, 701, 7110]) {
        const f = fixture()
        try {
            f.store.transact(f.session.id, 0, (s) => {
                s.world.map_id = map
            })
            const before = f.state(),
                packets = f.call('CookRequest', request),
                after = f.state()
            assert.equal(after.world.map_id, map)
            assert.deepEqual(after.world.pos, before.world.pos)
            assert.equal(after.world.point_id, before.world.point_id)
            assert.equal(stock(after, 400101), stock(before, 400101) - 6)
            assert.equal(stock(after, 400301), stock(before, 400301) - 6)
            assert.equal(stock(after, 9000201), 0)
            const job = after.home.productionJobs[18][0]
            assert.equal(job.productId, 9100201)
            assert.equal(job.count, 1)
            assert(packets.some((p) => p.id === 6102))
            assert.deepEqual(protocol.decode('Rewards', packets.find((p) => p.id === 10201).payload).rewards, [])
            f.advance(job.seconds)
            f.call('ProductFinish', { guid: 18, is_all: true })
            assert.equal(stock(f.state(), 9000201), 1)
            assert.throws(() => f.call('ProductFinish', { guid: 18, is_all: true }))
        } finally {
            f.store.close()
        }
    }
})
test('remote cooking cannot use portable, unknown, unplaced or constructing stations', () => {
    const f = fixture()
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.world.map_id = 100
        })
        for (const r of [
            { ...request, build_guid: 0 },
            { ...request, build_guid: 999999 },
        ]) {
            const before = f.state()
            assert.throws(
                () => f.call('CookRequest', r),
                (e) => e.code === ErrorCode.HomeNoBuild,
            )
            assert.deepEqual(f.state(), before)
        }
        f.store.transact(f.session.id, 0, (s) => {
            delete s.home.builds.find((b) => b.guid === 18).locate
        })
        let before = f.state()
        assert.throws(
            () => f.call('CookRequest', request),
            (e) => e.code === ErrorCode.HomeNoBuild,
        )
        assert.deepEqual(f.state(), before)
        f.store.transact(f.session.id, 0, (s) => {
            Object.assign(
                s.home.builds.find((b) => b.guid === 18),
                { locate: { block_id: 101, anchor: 6750237, direction: 0 }, status: 2 },
            )
        })
        before = f.state()
        assert.throws(
            () => f.call('CookRequest', request),
            (e) => e.code === ErrorCode.HomeBuildInvalidStatus,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})
test('remote cooking still validates unlocked recipe, group materials and funds atomically', () => {
    const f = fixture()
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.world.map_id = 100
        })
        for (const r of [
            { ...request, cook_id: 999999 },
            { ...request, cook_count: 101 },
            { ...request, cook_material: [{ item_id: 400101, item_num: 6 }] },
            { ...request, cook_count: 6 },
        ]) {
            const before = f.state()
            assert.throws(() => f.call('CookRequest', r))
            assert.deepEqual(f.state(), before)
        }
        f.store.transact(f.session.id, 0, (s) => {
            delete s.home.technology.levels[22015]
        })
        const before = f.state()
        assert.throws(() => f.call('CookRequest', request), /locked/)
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})
test('remote cooking cancellation refunds only paid ingredients and does not turn 11012 into an alias', () => {
    const f = fixture()
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.world.map_id = 100
        })
        const before = f.state()
        f.call('CookRequest', { ...request, cook_count: 2 })
        assert.equal(stock(f.state(), 400101), stock(before, 400101) - 12)
        assert.equal(stock(f.state(), 400301), stock(before, 400301) - 12)
        f.call('ProductCancel', { guid: 18, is_all: true })
        assert.equal(stock(f.state(), 400101), stock(before, 400101))
        assert.equal(stock(f.state(), 400301), stock(before, 400301))
        assert.equal(stock(f.state(), 9000201), 0)
        assert.throws(
            () => f.call('SimpleCookRequest', request),
            (e) => e.code === ErrorCode.InvalidProtoID,
        )
    } finally {
        f.store.close()
    }
})
test('remote cooking retains transaction rollback on inventory, home and reward acknowledgement codecs', () => {
    for (const id of [5008, 6102, 10201]) {
        const f = fixture(),
            encode = protocol.encode.bind(protocol)
        try {
            f.store.transact(f.session.id, 0, (s) => {
                s.world.map_id = 100
            })
            const before = f.state(),
                type = protocol.byId.get(id).rsp
            protocol.encode = (name, data) => {
                if (name === type) throw Error('remote cooking codec')
                return encode(name, data)
            }
            assert.throws(() => f.call('CookRequest', request), /remote cooking codec/)
            assert.deepEqual(f.state(), before)
            protocol.encode = encode
            f.call('CookRequest', request)
            assert.equal(f.state().home.productionJobs[18].length, 1)
            assert.equal(stock(f.state(), 400101), stock(before, 400101) - 6)
        } finally {
            protocol.encode = encode
            f.store.close()
        }
    }
})
test('remote cooking queue persists in SQLite and claims from the same owned station after relogin', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'luruka-cooking-remote-')),
        file = path.join(dir, 'state.sqlite')
    let f
    try {
        f = fixture(file)
        f.store.transact(f.session.id, 0, (s) => {
            s.world.map_id = 100
        })
        f.call('CookRequest', request)
        const account = f.session.id,
            job = f.state().home.productionJobs[18][0]
        f.store.close()
        f = null
        const store = new Store(file),
            game = new Game(protocol, store, tables, { clock: () => 1800000000 + job.seconds }),
            session = {}
        try {
            const login = protocol.byName.get('CSProtoEnterGame')
            game.dispatch(session, {
                id: login.id,
                seq: 1000,
                payload: protocol.encode(login.req, { open_id: 'cooking-remote-b07' }),
            })
            assert.equal(session.id, account)
            const state = store.load(account).state
            assert.equal(state.home.productionJobs[18][0].guid, job.guid)
            const finish = protocol.byName.get('CSProtoProductFinish')
            game.dispatch(session, {
                id: finish.id,
                seq: 1001,
                payload: protocol.encode(finish.req, { guid: 18, is_all: true }),
            })
            assert.equal(stock(store.load(account).state, 9000201), 1)
        } finally {
            store.close()
        }
    } finally {
        f?.store.close()
        assert.equal(path.dirname(dir), path.resolve(tmpdir()))
        assert(path.basename(dir).startsWith('luruka-cooking-remote-'))
        rmSync(dir, { recursive: true, force: true })
    }
})

test('remote cooking uses only the requesting account station and preserves a full queue without another debit', () => {
    const f = fixture()
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.world.map_id = 100
        })
        const outsider = {}
        f.call('EnterGame', { open_id: 'cooking-peer-no-station' }, outsider)
        assert.notEqual(outsider.id, f.session.id)
        assert.throws(
            () => f.call('CookRequest', request, outsider),
            (e) => e.code === ErrorCode.HomeNoBuild,
        )
        assert.equal(f.state().home.productionJobs?.[18]?.length ?? 0, 0)
        for (let i = 0; i < 4; i++) f.call('CookRequest', request)
        const before = f.state()
        assert.equal(before.home.productionJobs[18].length, 4)
        assert.throws(() => f.call('CookRequest', request), /queue is full/)
        assert.deepEqual(f.state(), before)
        assert.equal(stock(f.state(), 9000201), 0)
    } finally {
        f.store.close()
    }
})
