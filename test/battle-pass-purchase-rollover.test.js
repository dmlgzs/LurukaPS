import test from 'node:test'
import assert from 'node:assert/strict'
import { achievementFixture } from './achievement-fixture.js'
import { prepareBattlePass } from '../src/battle-pass.js'

test('replaying a same-season premium order after weekly rollover cannot publish last weeks XP or grant again', () => {
    const f = achievementFixture('battle-pass-order-new-week')
    f.game.offlinePayments = true
    const request = {
        purchase_sdk_id: 4001,
        buy_count: 1,
        product_id: 'lurukaps-offline:bp-week-replay-0001:local-sku-metadata',
        amount: '0',
    }
    try {
        f.call('NonMallCreatePayOrder', request)
        f.store.transact(f.session.id, 0, (state) => {
            prepareBattlePass(f.tables, state, 1800000000).ledger.curr_week_exp = 500
        })
        const diamonds = f.state().player.basic_info.diamond
        f.game.clock = () => 1800000000 + 7 * 86400
        const packets = f.call('NonMallCreatePayOrder', request)
        const packet = packets.find((row) => row.id === 18005)
        assert(packet, 'actual paid-level synchronization must be present')
        const info = f.protocol.decode(f.protocol.byId.get(18005).rsp, packet.payload)
        assert.equal(info.curr_week_exp, 0)
        assert.equal(prepareBattlePass(f.tables, f.state(), f.game.clock()).ledger.curr_week_exp, 0)
        assert.equal(f.state().player.basic_info.diamond, diamonds)
        assert.equal(Object.keys(f.state().mall.localOrders).length, 1)
    } finally {
        f.store.close()
    }
})
