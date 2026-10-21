import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'
import { gachaTables } from '../src/gacha-tables.js'
import { parseRewards } from '../src/rewards.js'

test('9707 saves or cancels a table-offered target independently of costs and pity; query uses current novice rule 802', () => {
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
    const decode = (name, packets) => protocol.decode(protocol.byName.get('CSProto' + name).rsp, packets.at(-1).payload)
    const state = () => store.load(session.id).state
    const aim = (item_id) => decode('GachaAimTarget', call('GachaAimTarget', { pool_id: 10001, item_id }))
    try {
        call('EnterGame', { open_id: 'gacha-aim' })
        const query = decode('GachaData', call('GachaData'))
        assert.deepEqual(
            query.gacha_pools.find((row) => row.gacha_pool.pool_id === 8001).pity.map((row) => row.pity_id),
            [801, 802, 803, 804],
        )
        assert.equal(
            gachaTables(tables)
                .get('gacha_guarantee')
                .find((row) => row.guaranteeId === 801).probability_base,
            0,
        )
        assert.equal(
            gachaTables(tables)
                .get('gacha_guarantee')
                .find((row) => row.guaranteeId === 802).probability_base,
            800,
        )
        assert.equal(gachaTables(gachaTables(tables)), gachaTables(tables))
        const target = parseRewards(
            gachaTables(tables)
                .get('gacha')
                .find((row) => row.gachaId === 10001).selfChooseuplist,
        )[0].itemid
        const player = structuredClone(state().player)
        store.transact(session.id, 0, (s) => {
            s.gacha.pools[10001].pity[0].pity_count = 17
        })
        assert.deepEqual(aim(target).gacha_pool.aimed_item_ids, [target])
        assert.deepEqual(aim(target).gacha_pool.aimed_item_ids, [target])
        assert.deepEqual(state().player, player)
        assert.equal(state().gacha.pools[10001].pity[0].pity_count, 17)
        call('EnterGame', { open_id: 'gacha-aim' }, {})
        assert.deepEqual(state().gacha.pools[10001].gacha_pool.aimed_item_ids, [target])
        const before = structuredClone(state())
        assert.throws(
            () => aim(0xffffffff),
            (error) => error.code === ErrorCode.InvalidArgument,
        )
        assert.throws(
            () => call('GachaAimTarget', { pool_id: 1001, item_id: target }),
            (error) => error.code === ErrorCode.FunctionClosed,
        )
        assert.deepEqual(state(), before)
        assert.deepEqual(aim(0).gacha_pool.aimed_item_ids, [])
        assert.equal(state().gacha.pools[10001].pity[0].pity_count, 17)
    } finally {
        store.close()
    }
})
