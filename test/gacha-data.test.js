import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'
import { GachaCatalog } from '../src/gacha.js'
import { gachaTables } from '../src/gacha-tables.js'

export function gachaFixture(name) {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base),
        store = new Store(':memory:'),
        game = new Game(protocol, store, tables),
        session = {}
    let seq = 1
    const call = (name, data = {}, who = session) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(who, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, data) })
    }
    call('EnterGame', { open_id: name })
    const response = (name) => {
        const packets = call(name),
            last = packets.at(-1)
        return protocol.decode(protocol.byId.get(last.id).rsp, last.payload)
    }
    return {
        tables,
        protocol,
        store,
        game,
        session,
        call,
        response,
        state: () => store.load(session.id).state,
        reload: () => call('EnterGame', { open_id: name }, {}),
    }
}
test('9700 returns every actual table pool and guarantee counter without granting rewards or resetting saved progress', () => {
    const f = gachaFixture('gacha-data')
    try {
        const beforePlayer = structuredClone(f.state().player)
        const data = f.response('GachaData')
        assert.deepEqual(
            data.gacha_pools.map((entry) => entry.gacha_pool.pool_id),
            gachaTables(f.tables)
                .get('gacha')
                .map((row) => row.gachaId),
        )
        for (const entry of data.gacha_pools) {
            const config = gachaTables(f.tables)
                .get('gacha')
                .find((row) => row.gachaId === entry.gacha_pool.pool_id)
            assert.deepEqual(
                entry.pity.map((item) => item.pity_id),
                config.guaranteeId.split('|').map(Number),
            )
            assert.ok(entry.pity.every((item) => item.pity_count === 0 && item.is_completed === false))
            assert.equal(entry.gacha_pool.pool_draw_count, 0)
        }
        assert.deepEqual(f.state().player, beforePlayer)
        const id = data.gacha_pools[0].gacha_pool.pool_id
        f.store.transact(f.session.id, 0, (state) => {
            const entry = state.gacha.pools[id]
            entry.gacha_pool.pool_draw_count = 19
            entry.gacha_pool.last_gacha_time = '1790000000'
            entry.gacha_pool.received_stage_count = 1
            entry.pity[0].pity_count = 7
        })
        f.reload()
        const restored = f.response('GachaData').gacha_pools.find((entry) => entry.gacha_pool.pool_id === id)
        assert.equal(restored.gacha_pool.pool_draw_count, 19)
        assert.equal(restored.gacha_pool.received_stage_count, 1)
        assert.equal(restored.pity[0].pity_count, 7)
        assert.deepEqual(
            f.response('GachaData').gacha_pools.find((entry) => entry.gacha_pool.pool_id === id),
            restored,
        )
        f.store.transact(f.session.id, 0, (state) => {
            state.gacha.pools[id].gacha_pool.pool_draw_count = -1
        })
        const broken = structuredClone(f.state())
        assert.throws(
            () => f.response('GachaData'),
            (error) => error.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), broken)
    } finally {
        f.store.close()
    }
})
test('gacha indices use each table real key and reject duplicate configuration identifiers', () => {
    const tables = new Tables(configuration().tables),
        get = tables.get.bind(tables)
    tables.get = (name) => (name === 'gacha' ? [get(name)[0], get(name)[0]] : get(name))
    assert.throws(
        () => new GachaCatalog(tables),
        (error) => error.code === ErrorCode.GameConfig,
    )
})
