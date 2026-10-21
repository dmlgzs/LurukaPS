import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { grantRewards } from '../src/rewards.js'
import { ErrorCode } from '../src/error-codes.js'
const cfg = configuration()
function fixture(name, options = {}) {
    const tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base),
        store = new Store(':memory:'),
        session = {}
    const game = new Game(protocol, store, tables, { clock: () => 1790000000, ...options })
    let seq = 1
    const frame = (name, data = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return { id: e.id, seq: seq++, payload: protocol.encode(e.req, data) }
    }
    const dispatch = (f, who = session) => {
        const e = protocol.byId.get(f.id),
            packets = game.dispatch(who, f)
        return { packets, data: protocol.decode(e.rsp, packets.find((p) => p.id === e.id).payload) }
    }
    const call = (name, data = {}, who = session) => dispatch(frame(name, data), who)
    call('EnterGame', { open_id: name })
    const state = () => store.load(session.id).state
    const pool = () => state().gacha.pools[9001].gacha_pool
    const count = (id) =>
        state()
            .player.sbag_infos.items.filter((i) => i.itemid === id)
            .reduce((n, i) => n + i.itemnum, 0)
    const claim = (item_id = 107002, pool_id = 9001) => call('GachaGetNewPlayerHero', { pool_id, item_id })
    return { tables, protocol, store, session, frame, dispatch, call, state, pool, count, claim }
}
test('real 9701 observations unlock 9704 once; owned choice delivers a shard without new draws, pity resets or extra currency', () => {
    const f = fixture('self-choice-real-draws', { rng: (max) => max - 1 })
    try {
        f.store.transact(f.session.id, 0, (s) =>
            grantRewards(f.tables, s, [{ itemtype: 3, itemid: 501000, itemnum: 50 }]),
        )
        f.call('GachaDraw', { pool_id: 9001, draw_count: 1 })
        let last
        for (let i = 0; i < 5; i++) {
            last = f.frame('GachaDraw', { pool_id: 9001, draw_count: 10 })
            f.dispatch(last)
        }
        assert.equal(f.pool().pool_draw_count, 51)
        const before = structuredClone(f.state().gacha.pools[9001].pity),
            history = f.state().gacha.history.length,
            shards = f.count(1100015),
            extras = f.count(502001)
        const { packets, data } = f.claim()
        assert.equal(data.rewards.src, 141)
        assert(data.rewards.rewards.some((i) => i.itemtype === 3 && i.itemid === 1100015 && i.itemnum === 1))
        assert.equal(f.count(1100015), shards + 1)
        assert.equal(f.count(502001), extras)
        assert.equal(data.gachaPool.pool_draw_count, 51)
        assert(data.gachaPool.received_self_choose)
        assert.deepEqual(f.state().gacha.pools[9001].pity, before)
        assert.equal(f.state().gacha.history.length, history)
        const ack = packets.findIndex((p) => p.id === 9704)
        assert(packets.slice(0, ack).some((p) => p.id === f.protocol.byName.get('CSProtoSyncPlayerData').id))
        const saved = structuredClone(f.state())
        assert.deepEqual(f.claim().data.rewards.rewards, [])
        assert.deepEqual(f.state(), saved)
        assert.throws(
            () => f.claim(109001),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
        assert.deepEqual(f.state(), saved)
        // A cached draw response must not restore received_self_choose=false.
        assert(f.dispatch(last).data.pool_info.gacha_pool.received_self_choose)
        assert.deepEqual(f.state(), saved)
        f.call('EnterGame', { open_id: 'self-choice-real-draws' }, {})
        assert(f.pool().received_self_choose)
        assert.deepEqual(f.claim().data.rewards.rewards, [])
    } finally {
        f.store.close()
    }
})
test('earned self-choice remains claimable after closure and a new hero is synchronized before its common reward page', () => {
    let randomCalls = 0
    const f = fixture('self-choice-new-hero', {
        rng: () => {
            randomCalls++
            return 0
        },
        gachaPolicy: { missing_schedule: 'closed' },
    })
    try {
        f.call('GachaData')
        f.store.transact(f.session.id, 0, (s) => {
            s.gacha.pools[9001].gacha_pool.pool_draw_count = 50
            s.player.heros_info.heros = s.player.heros_info.heros.filter((h) => h.conf_id !== 109001)
        })
        f.session.syncCache.clear()
        const before = randomCalls,
            { packets, data } = f.claim(109001)
        assert.equal(randomCalls, before)
        assert(data.rewards.rewards.some((i) => i.itemtype === 1 && i.itemid === 109001 && i.itemnum === 1))
        assert(f.state().player.heros_info.heros.some((h) => h.conf_id === 109001 && !h.trail))
        const ack = packets.findIndex((p) => p.id === 9704),
            sync = f.protocol.byName.get('CSProtoSyncPlayerData').id
        assert(
            packets
                .slice(0, ack)
                .filter((p) => p.id === sync)
                .some((p) =>
                    f.protocol
                        .decode(f.protocol.byId.get(sync).rsp, p.payload)
                        .heros_info?.heros.some((h) => h.conf_id === 109001),
                ),
        )
        assert(data.gachaPool.received_self_choose)
        assert.equal(data.gachaPool.pool_draw_count, 50)
    } finally {
        f.store.close()
    }
})
test('the current candidate list and threshold are enforced and failed conversion never consumes the once-only claim', () => {
    const f = fixture('self-choice-errors'),
        hero = f.tables.find('hero', 107002),
        original = hero.gradeUpItem
    try {
        f.call('GachaData')
        assert.throws(
            () => f.claim(101010, 1001),
            (e) => e.code === ErrorCode.FunctionClosed,
        )
        assert.throws(
            () => f.claim(199001),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
        f.store.transact(f.session.id, 0, (s) => (s.gacha.pools[9001].gacha_pool.pool_draw_count = 49))
        const under = structuredClone(f.state())
        assert.throws(
            () => f.claim(),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
        assert.deepEqual(f.state(), under)
        f.store.transact(f.session.id, 0, (s) => (s.gacha.pools[9001].gacha_pool.pool_draw_count = 50))
        hero.gradeUpItem = Array(6).fill('4294967295#1').join('|')
        const before = structuredClone(f.state())
        assert.throws(
            () => f.claim(),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
        assert(!f.pool().received_self_choose)
    } finally {
        hero.gradeUpItem = original
        f.store.close()
    }
})
