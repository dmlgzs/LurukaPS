import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { parseRewards } from '../src/rewards.js'
import { ErrorCode } from '../src/error-codes.js'

function fixture(name, rng = () => 0) {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base),
        store = new Store(':memory:')
    let session = {},
        seq = 1,
        packets = []
    const game = new Game(protocol, store, tables, { clock: () => 1800000000, rng, gmEnabled: true })
    const frame = (name, request = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return { id: e.id, seq: seq++, payload: e.req ? protocol.encode(e.req, request) : Buffer.alloc(0) }
    }
    const dispatch = (request) => {
        packets = game.dispatch(session, request)
        const e = protocol.byId.get(request.id)
        return e.rsp ? protocol.decode(e.rsp, packets.find((p) => p.id === e.id).payload) : undefined
    }
    const call = (name, request) => dispatch(frame(name, request))
    const login = () => {
        session = {}
        call('EnterGame', { open_id: name })
        return packets
    }
    login()
    const state = () => store.load(session.id).state
    assert.equal(state().starterProfile.mode, 'normal')
    assert.equal(state().player.sbag_infos.items.length, 0)
    assert.equal(state().player.soulessence_infos.soulessences.length, 0)
    assert.equal(state().pets.length, 0)
    // Explicit trusted qualification for current system2's106010/78 UI gate.
    // No draw/claim/pity/currency history is supplied; not a full-story E2E.
    store.transact(session.id, 0, (s) => {
        s.tasks = []
        s.taskRecords = [{ task_id: 106010, count: 1 }]
    })
    return {
        tables,
        protocol,
        store,
        frame,
        dispatch,
        call,
        login,
        state,
        saved: () => store.load(session.id),
        packets: () => packets,
        gm: (command) => call('GMCommand', { command: Buffer.from(command).toString('base64') }),
        count: (id) =>
            state()
                .player.sbag_infos.items.filter((r) => r.itemid === id)
                .reduce((n, r) => n + r.itemnum, 0),
        close: () => store.close(),
    }
}

// Current GachaManager06029831/3a/42/4d updates pool/history caches;
// PageGachaResult uses main/transform/extra item IDs, not soul instance GUIDs.
class GachaConsumer {
    pools = new Map()
    heroes = new Map()
    souls = new Map()
    history = []
    consume(f, packets, expectNewHero = false) {
        for (const p of packets) {
            const e = f.protocol.byId.get(p.id),
                v = e.rsp ? f.protocol.decode(e.rsp, p.payload) : {}
            const player = p.id === 5001 ? v.data : p.id === 5008 ? v : null
            for (const h of player?.heros_info?.heros ?? []) this.heroes.set(h.conf_id, h)
            for (const s of player?.soulessence_infos?.soulessences ?? []) this.souls.set(String(s.guid), s)
            if (p.id === 9700) for (const r of v.gacha_pools) this.pools.set(r.gacha_pool.pool_id, r)
            if (p.id === 9707)
                this.pools.set(v.gacha_pool.pool_id, {
                    ...this.pools.get(v.gacha_pool.pool_id),
                    gacha_pool: v.gacha_pool,
                })
            if (p.id === 9701) {
                assert(this.pools.has(v.pool_info.gacha_pool.pool_id), 'result requires initialized current pool cache')
                this.pools.set(v.pool_info.gacha_pool.pool_id, v.pool_info)
                for (const r of v.gacha_results) {
                    assert(r.gacha_surprise)
                    const main = r.main_item
                    assert(f.tables.find(main.item_type === 1 ? 'hero' : 'soulessence', main.item_id))
                    if (expectNewHero)
                        assert(this.heroes.has(main.item_id), 'new permanent hero cache precedes result callback')
                    for (const extra of [r.transform_item, ...r.extra_item].filter(Boolean))
                        assert(f.tables.find('common_item', extra.item_id))
                }
            }
            if (p.id === 9706) this.history.push(...v.items)
        }
    }
}

test('normal empty assets use real ticket grants, current aiming and paid9701; result/history/cold caches and codec/SQL retry agree', () => {
    const f = fixture('gacha-normal-public'),
        client = new GachaConsumer()
    try {
        client.consume(f, f.packets())
        assert.equal(client.pools.size, f.tables.get('gacha').length)
        const empty = f.saved()
        assert.throws(() => f.call('GachaDraw', { pool_id: 1001, draw_count: 1 }))
        assert.deepEqual(f.saved(), empty)
        f.gm('item 501001 1')
        const before = f.count(501001),
            heroReply = f.call('GachaDraw', { pool_id: 1001, draw_count: 1 })
        client.consume(f, f.packets(), true)
        assert.equal(f.count(501001), before - 1)
        const hero = heroReply.gacha_results[0]
        assert.equal(hero.main_item.item_type, 1)
        assert(!hero.transform_item, 'normal first acquisition is not an already-owned copy')
        const row = f.tables.find('hero', hero.main_item.item_id),
            band = f.tables
                .get('gacha_add_reward')
                .find((r) => r.type === 1 && r.rarity === row.rarity && r.minCount === 1 && r.maxCount === 1)
        assert.deepEqual(
            hero.extra_item,
            parseRewards(band.reward).map((r) => ({ item_type: r.itemtype, item_id: r.itemid, item_num: r.itemnum })),
        )
        const definition = f.tables.get('gacha').find((r) => r.gachaType === 10),
            choices = parseRewards(definition.selfChooseuplist)
        const unselected = f.saved()
        assert.throws(() => f.call('GachaDraw', { pool_id: definition.gachaId, draw_count: 1 }), {
            code: ErrorCode.InvalidArgument,
        })
        assert.deepEqual(f.saved(), unselected)
        f.call('GachaAimTarget', { pool_id: definition.gachaId, item_id: choices[0].itemid })
        client.consume(f, f.packets())
        const pity = structuredClone(f.state().gacha.pools[definition.gachaId].pity)
        f.call('GachaAimTarget', { pool_id: definition.gachaId, item_id: choices[1].itemid })
        assert.deepEqual(f.state().gacha.pools[definition.gachaId].pity, pity)
        const ticket = f.tables.find('gacha_type', definition.gachaType).costItem
        f.gm(`item ${ticket} 2`)
        const soulReply = f.call('GachaDraw', { pool_id: definition.gachaId, draw_count: 1 })
        client.consume(f, f.packets())
        assert.equal(soulReply.gacha_results[0].main_item.item_id, choices[1].itemid)
        assert([...client.souls.values()].some((r) => r.id === choices[1].itemid))
        const request = f.frame('GachaDraw', { pool_id: definition.gachaId, draw_count: 1 }),
            ready = f.saved(),
            encode = f.protocol.encode
        f.protocol.encode = function (name, value) {
            if (name === f.protocol.byId.get(9701).rsp) throw Error('gacha-normal-codec')
            return encode.call(this, name, value)
        }
        try {
            assert.throws(() => f.dispatch(request), /gacha-normal-codec/)
        } finally {
            f.protocol.encode = encode
        }
        assert.deepEqual(f.saved(), ready)
        f.store.db.exec(
            "CREATE TRIGGER gacha_current_abort BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'gacha-current-sql'); END",
        )
        try {
            assert.throws(() => f.dispatch(request), /gacha-current-sql/)
        } finally {
            f.store.db.exec('DROP TRIGGER gacha_current_abort')
        }
        assert.deepEqual(f.saved(), ready)
        const retry = f.dispatch(request)
        const paid = f.state()
        assert.deepEqual(f.dispatch(request).gacha_results, retry.gacha_results)
        assert.deepEqual(f.state().player, paid.player)
        assert.deepEqual(f.state().gacha.history, paid.gacha.history)
        f.call('GachaHistory', { gacha_type: definition.gachaType, cursor: '0', select_num: 1 })
        const out = f.packets(),
            ntf = out.findIndex((p) => p.id === 9706),
            ack = out.findIndex((p) => p.id === 9705)
        assert(ntf >= 0 && ntf < ack)
        const page = f.protocol.decode(f.protocol.byId.get(9706).rsp, out[ntf].payload)
        assert.equal(page.total_count, '2')
        assert(page.has_more)
        assert.notEqual(page.next_cursor, '0')
        f.call('GachaHistory', { gacha_type: definition.gachaType, cursor: page.next_cursor, select_num: 1 })
        const second = f.protocol.decode(f.protocol.byId.get(9706).rsp, f.packets().find((p) => p.id === 9706).payload)
        assert.equal(second.items.length, 1)
        assert.notEqual(second.items[0].record_id, page.items[0].record_id)
        const cold = new GachaConsumer()
        cold.consume(f, f.login())
        assert.equal(cold.pools.get(definition.gachaId).gacha_pool.pool_draw_count, 2)
        assert.equal([...cold.souls.values()].filter((r) => r.id === choices[1].itemid).length, 2)
        assert.deepEqual(f.state().gacha.history, paid.gacha.history)
    } finally {
        f.close()
    }
})

test('normal actual fifty permanent observations earn9704 entitlement; explicit owned choice converts once without editing draw counters or pity', () => {
    const f = fixture('gacha-normal-real-selfchoose', (max) => max - 1)
    try {
        const definition = f.tables.get('gacha').find((r) => r.selfChoose > 0),
            pool = f.tables.get('gacha_pool').find((r) => r.gachaId === definition.gachaId),
            choice = parseRewards(pool.hero_SSR).find(
                (r) => !f.state().player.heros_info.heros.some((h) => h.conf_id === r.itemid && !h.trail),
            )
        assert.equal(definition.selfChoose, 50)
        f.gm(`give 1 ${choice.itemid} 1`)
        const config = f.tables.find('hero', choice.itemid),
            [shard, amount] = config.gradeUpItem.split('|')[0].split('#').map(Number),
            ticket = f.tables.find('gacha_type', definition.gachaType).costItem
        assert(String(definition.specialRule).split('|').includes('FIRST_FREE'))
        f.gm(`item ${ticket} ${definition.selfChoose - 1}`)
        const start = f.count(ticket)
        f.call('GachaDraw', { pool_id: definition.gachaId, draw_count: 1 })
        assert.equal(f.count(ticket), start)
        const under = f.saved()
        assert.throws(() => f.call('GachaGetNewPlayerHero', { pool_id: definition.gachaId, item_id: choice.itemid }))
        assert.deepEqual(f.saved(), under)
        let remaining = definition.selfChoose - 1
        while (remaining) {
            const n = remaining >= 10 ? 10 : 1
            f.call('GachaDraw', { pool_id: definition.gachaId, draw_count: n })
            remaining -= n
        }
        assert.equal(f.count(ticket), 0)
        const entry = () => f.state().gacha.pools[definition.gachaId],
            pity = structuredClone(entry().pity),
            history = f.state().gacha.history.length,
            before = f.count(shard),
            currency = f.count(502001)
        assert.equal(entry().gacha_pool.pool_draw_count, definition.selfChoose)
        const claimed = f.call('GachaGetNewPlayerHero', { pool_id: definition.gachaId, item_id: choice.itemid })
        assert(claimed.rewards.rewards.some((r) => r.itemtype === 3 && r.itemid === shard && r.itemnum === amount))
        assert.equal(f.count(shard), before + amount)
        assert.equal(f.count(502001), currency)
        assert.deepEqual(entry().pity, pity)
        assert.equal(f.state().gacha.history.length, history)
        assert(entry().gacha_pool.received_self_choose)
        assert.deepEqual(
            f.call('GachaGetNewPlayerHero', { pool_id: definition.gachaId, item_id: choice.itemid }).rewards.rewards,
            [],
        )
        const saved = f.state()
        f.login()
        assert.deepEqual(f.state().gacha.history, saved.gacha.history)
        assert(entry().gacha_pool.received_self_choose)
        assert.equal(f.count(shard), before + amount)
    } finally {
        f.close()
    }
})
