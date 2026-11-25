import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { GachaCatalog } from '../src/gacha.js'
import { GachaDrawEngine } from '../src/gacha-draw.js'
import { grantRewards } from '../src/rewards.js'
import { ErrorCode } from '../src/error-codes.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables)

test('all current pools compile, including the selected SSR soul guarantee and its existing explicit soft model', () => {
    const catalog = new GachaCatalog(tables),
        engine = new GachaDrawEngine(catalog, tables)
    assert.equal(catalog.pools.size, 5)
    for (const config of catalog.pools.values()) assert(engine.compile(config).rules.length > 0)
    const model = engine.compile(catalog.configuration(10001))
    assert.equal(model.rules[0].selfchoose, 1)
    assert.equal(model.rules[0].guaranteeCount, 80)
    assert.equal(model.probabilityModel.id, 'soulessence')
    assert.equal(model.probabilityModel.base_mass, 1200)
})

function fixture(rng) {
    const protocol = new Protocol(cfg.base),
        store = new Store(':memory:'),
        session = {},
        game = new Game(protocol, store, tables, { clock: () => 1800000000, rng })
    let seq = 1
    const frame = (name, data = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return { id: e.id, seq: seq++, payload: protocol.encode(e.req, data) }
    }
    const dispatch = (request) => {
        const e = protocol.byId.get(request.id),
            packets = game.dispatch(session, request)
        return protocol.decode(e.rsp, packets.find((p) => p.id === e.id).payload)
    }
    const call = (name, data) => dispatch(frame(name, data))
    call('EnterGame', { open_id: 'gacha-current' })
    const edit = (fn) => store.transact(session.id, 0, fn),
        state = () => store.load(session.id).state
    edit((s) => grantRewards(tables, s, [{ itemtype: 3, itemid: 501000, itemnum: 10 }]))
    return { store, call, frame, dispatch, edit, state }
}

test('current selected pool requires aiming and preserves its rarity pity when switching target; hard draw grants equipment once', () => {
    const f = fixture((n) => n - 1)
    try {
        const player = structuredClone(f.state().player)
        assert.throws(
            () => f.call('GachaDraw', { pool_id: 10001, draw_count: 1 }),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
        assert.deepEqual(f.state().player, player)
        f.call('GachaAimTarget', { pool_id: 10001, item_id: 10032 })
        f.edit((s) => {
            const pity = s.gacha.pools[10001].pity
            pity.find((p) => p.pity_id === 1001).pity_count = 79
            pity.find((p) => p.pity_id === 1003).pity_count = 9
        })
        f.call('GachaAimTarget', { pool_id: 10001, item_id: 10037 })
        assert.equal(f.state().gacha.pools[10001].pity.find((p) => p.pity_id === 1001).pity_count, 79)
        const before = f.state().player.soulessence_infos.soulessences.filter((s) => s.id === 10037).length,
            request = f.frame('GachaDraw', { pool_id: 10001, draw_count: 1 }),
            reply = f.dispatch(request)
        assert.deepEqual(reply.gacha_results[0].main_item, { item_type: 9, item_id: 10037, item_num: 1 })
        assert(reply.pool_info.pity.every((p) => p.pity_count === 0))
        assert.equal(f.state().player.soulessence_infos.soulessences.filter((s) => s.id === 10037).length, before + 1)
        const after = f.state()
        assert.deepEqual(f.dispatch(request).gacha_results, reply.gacha_results)
        assert.deepEqual(f.state().player, after.player)
        assert.deepEqual(f.state().gacha.history, after.gacha.history)
        f.call('GachaAimTarget', { pool_id: 10001, item_id: 0 })
        assert.throws(
            () => f.call('GachaDraw', { pool_id: 10001, draw_count: 1 }),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
        assert.equal(f.state().gacha.pools[10001].gacha_pool.pool_draw_count, 1)
    } finally {
        f.store.close()
    }
})

test('current selected pool ordinary SSR applies the explicit selected policy and real ticket/payment/history path', () => {
    const f = fixture(() => 0)
    try {
        f.call('GachaAimTarget', { pool_id: 10001, item_id: 10083 })
        const reply = f.call('GachaDraw', { pool_id: 10001, draw_count: 1 })
        assert.equal(reply.gacha_results[0].main_item.item_id, 10083)
        assert.equal(f.state().gacha.history.at(-1).item[0].item_id, 10083)
        assert.equal(
            f
                .state()
                .player.sbag_infos.items.filter((x) => x.itemid === 501000)
                .reduce((sum, x) => sum + x.itemnum, 0),
            9,
        )
        assert(reply.gacha_results[0].extra_item.length > 0)
    } finally {
        f.store.close()
    }
})
