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
const c = configuration(),
    t = new Tables(c.tables),
    p = new Protocol(c.base)
function setup(file = ':memory:') {
    let now = 1800000000
    const store = new Store(file),
        game = new Game(p, store, t, { clock: () => now }),
        session = {}
    let seq = 1
    const call = (name, r) => {
        const e = p.byName.get('CSProto' + name)
        return game.dispatch(session, { id: e.id, seq: seq++, pushSeq: 0, payload: p.encode(e.req, r) })
    }
    call('EnterGame', { open_id: 'producer' })
    store.transact(session.id, 0, (s) => {
        s.player.basic_info.lv = 6
        s.player.sbag_infos.items = [{ itemid: 300000, itemnum: 30 }]
    })
    call('HomeTechnologyLevelUp', { type: 1, subType: 11005 })
    return {
        store,
        game,
        session,
        call,
        advance: (n) => {
            now += n
        },
        now: () => now,
    }
}
const start = { build_guid: 1, product_id: 302001, count: 3 }
test('real workbench recipe starts, ticks, partially claims and cancels without duplication', () => {
    const { store, game, session, call, advance } = setup()
    try {
        call('ProductStart', start)
        let s = store.load(session.id).state
        assert.equal(s.player.sbag_infos.items[0].itemnum, 21)
        assert.equal(s.home.builds[0].product[0].total_count, 3)
        assert.equal(s.home.builds[0].product[0].finish_count, 0)
        assert.equal(s.dailyActive.day.counts[15011] ?? 0, 0)
        const before = store.load(session.id)
        assert.throws(() => call('ProductFinish', { guid: 1, is_all: true }), /No finished/)
        assert.deepEqual(store.load(session.id), before)
        advance(3)
        const pushed = game.tick(session.id)
        assert.equal(pushed[0].id, 6102)
        const progress = p.decode('SCHomeSync', pushed[0].payload).home_builds[0].product[0]
        assert.equal(progress.total_count, 2)
        assert.equal(progress.finish_count, 1)
        assert.deepEqual(game.tick(session.id), [])
        call('ProductFinish', { guid: 1, is_all: true })
        s = store.load(session.id).state
        assert.equal(s.player.sbag_infos.items.find((i) => i.itemid === 350000).itemnum, 1)
        assert.equal(s.home.builds[0].product[0].finish_count, 0)
        assert.throws(() => call('ProductFinish', { guid: 1, is_all: true }))
        call('ProductCancel', { guid: 1, product_guids: [1] })
        s = store.load(session.id).state
        assert.equal(s.player.sbag_infos.items.find((i) => i.itemid === 300000).itemnum, 27)
        assert.equal(s.home.builds[0].product.length, 0)
        assert.equal(s.home.craftCounts[302001], 1)
        assert.equal(s.dailyActive.day.counts[15011], 1)
        assert.throws(() => call('ProductCancel', { guid: 1, product_guids: [1] }))
    } finally {
        store.close()
    }
})
test('queue serial timing and cancellation reschedule waiting jobs', () => {
    const { store, session, call, advance } = setup()
    try {
        call('ProductStart', { ...start, count: 1 })
        call('ProductStart', { ...start, count: 1 })
        let jobs = store.load(session.id).state.home.productionJobs[1]
        assert.equal(jobs[1].start, jobs[0].start + 3)
        advance(1)
        call('ProductCancel', { guid: 1, product_guids: [1] })
        jobs = store.load(session.id).state.home.productionJobs[1]
        assert.equal(jobs[0].guid, 2)
        assert.equal(jobs[0].start, 1800000001)
        advance(3)
        call('ProductFinish', { guid: 1, product_guids: [2] })
        assert.equal(store.load(session.id).state.home.builds[0].product.length, 0)
    } finally {
        store.close()
    }
})
test('production validates station, material stock, recipe unlock and unique claims', () => {
    const { store, session, call } = setup()
    try {
        const before = store.load(session.id)
        for (const r of [
            { ...start, build_guid: 999 },
            { ...start, count: 0 },
            { ...start, count: 11 },
            { ...start, product_id: 160001 },
            { ...start, select_material: [1] },
        ]) {
            assert.throws(() => call('ProductStart', r))
            assert.deepEqual(store.load(session.id), before)
        }
        call('ProductStart', start)
        const running = store.load(session.id)
        assert.throws(() => call('BuildUnlocate', { guid: 1 }), /busy/)
        assert.throws(() => call('ProductFinish', { guid: 1, product_guids: [1, 1] }))
        assert.deepEqual(store.load(session.id), running)
    } finally {
        store.close()
    }
})
test('completed task unlocks a type-25 saddle recipe supported by grantRewards', () => {
    const { store, session, call, advance } = setup()
    try {
        store.transact(session.id, 0, (state) => {
            state.taskRecords ??= []
            state.taskRecords.push({ task_id: 206016, count: 1, time: 1800000000 })
            state.player.sbag_infos.items.push({ itemid: 302001, itemnum: 20 }, { itemid: 317001, itemnum: 20 })
        })
        call('ProductStart', { build_guid: 1, product_id: 600007, count: 1 })
        advance(30)
        const packets = call('ProductFinish', { guid: 1, is_all: true })
        const result = p.decode('SCProductFinish', packets.find((packet) => packet.id === 6111).payload)
        assert(result.reward.rewards.some((item) => item.itemtype === 25 && item.itemid === 500022))
        assert(store.load(session.id).state.mountSaddles.includes(500022))
    } finally {
        store.close()
    }
})
test('absolute queue timestamps survive SQLite restart and offline time', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-production-')),
        file = path.join(dir, 'state.sqlite')
    let fixture = setup(file),
        store = fixture.store
    try {
        fixture.call('ProductStart', start)
        const id = fixture.session.id
        store.close()
        store = new Store(file)
        const game = new Game(p, store, t, { clock: () => 1800000010 }),
            session = {},
            enter = p.byName.get('CSProtoEnterGame')
        const packets = game.dispatch(session, {
            id: enter.id,
            seq: 1,
            pushSeq: 0,
            payload: p.encode(enter.req, { open_id: 'producer' }),
        })
        const home = p.decode('SCHomeSync', packets.find((x) => x.id === 6102).payload)
        assert.equal(home.home_builds[0].product[0].total_count, 0)
        assert.equal(home.home_builds[0].product[0].finish_count, 3)
        assert.equal(session.id, id)
        const finish = p.byName.get('CSProtoProductFinish')
        game.dispatch(session, {
            id: finish.id,
            seq: 2,
            pushSeq: 0,
            payload: p.encode(finish.req, { guid: 1, is_all: true }),
        })
        assert.equal(store.load(id).state.player.sbag_infos.items.find((i) => i.itemid === 350000).itemnum, 3)
    } finally {
        store.close()
        assert.equal(path.dirname(dir), os.tmpdir())
        assert(path.basename(dir).startsWith('lurukaps-production-'))
        fs.rmSync(dir, { recursive: true })
    }
})
import net from 'node:net'
import { once } from 'node:events'
import { startServer } from '../src/server.js'
import { FrameReader, encodeFrame } from '../src/wire.js'
test('live TCP receives a production-completion push without another client request', async () => {
    const server = await startServer({ ...c, gamePort: 0, httpPort: 0, database: ':memory:' }, { warn: () => {} })
    let now = 1800000000
    server.game.clock = () => now
    const socket = net.connect(server.tcp.address().port, '127.0.0.1'),
        reader = new FrameReader(),
        queue = []
    socket.on('data', (chunk) => queue.push(...reader.feed(chunk)))
    async function receive(predicate) {
        const end = Date.now() + 4000
        while (Date.now() < end) {
            const index = queue.findIndex(predicate)
            if (index >= 0) return queue.splice(index, 1)[0]
            await new Promise((r) => setTimeout(r, 20))
        }
        throw Error('Production packet timeout')
    }
    function send(name, req, seq) {
        const e = p.byName.get('CSProto' + name)
        socket.write(encodeFrame({ id: e.id, seq }, p.encode(e.req, req)))
    }
    try {
        await once(socket, 'connect')
        send('EnterGame', { open_id: 'live-producer' }, 1)
        const login = await receive((f) => f.id === 5001),
            id = p.decode('SCEnterGame', login.payload).player_id
        server.store.transact(id, 0, (s) => {
            s.player.basic_info.lv = 6
            s.home.technology.levels[11005] = { level: 1, lastTime: now }
            s.player.sbag_infos.items = [{ itemid: 300000, itemnum: 3 }]
        })
        send('ProductStart', { build_guid: 1, product_id: 302001, count: 1 }, 2)
        assert.equal((await receive((f) => f.id === 6110)).error, 0)
        now += 3
        const done = await receive(
            (f) =>
                f.id === 6102 && p.decode('SCHomeSync', f.payload).home_builds?.[0]?.product?.[0]?.finish_count === 1,
        )
        assert.equal(done.seq, 0)
        assert(done.pushSeq > 0)
        assert.equal(server.store.load(id).state.home.builds[0].product[0].total_count, 0)
    } finally {
        socket.destroy()
        await server.close()
    }
})
