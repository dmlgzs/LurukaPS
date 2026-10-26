import test from 'node:test'
import assert from 'node:assert/strict'
import { homeCurrencyFixture, homeCurrencyBalance } from './home-currency-fixture.js'
import { addItems } from '../src/inventory.js'

function legacyJob(name) {
    const f = homeCurrencyFixture(name)
    f.fundItems('3#312001#4')
    f.setOldBalance(1000)
    f.call('SimpleProductStart', { product_id: 501001, count: 2 })
    const current = f.state().simpleProducts[0]
    // A bounded compatibility fixture: current recipe has no103 fee. Preserve
    // a structurally valid old paid-cost job without claiming it was a current
    // real103 quick-production recipe or a proved official historical invoice.
    f.edit((state) => {
        addItems(
            state,
            current.costs.map((row) => ({ ...row, itemnum: row.itemnum * current.count })),
        )
        state.player.attr_infos.attrs.find((row) => row.attr_id === 103).attr_val = '854'
        state.simpleProducts[0].costs = [{ itemtype: 10, itemid: 103, itemnum: 73 }]
    })
    return { ...f, job: current }
}
test('actual11011 preserves a legacy paid103 refund once without calling it new earned currency', () => {
    const f = legacyJob('home-currency-quick-refund')
    try {
        f.call('SimpleProductCancel', { u32: f.job.guid })
        assert.equal(homeCurrencyBalance(f.state()), 1000n)
        assert.equal(f.state().homeCurrencyAcquisition, undefined)
        f.call('SimpleProductCancel', { u32: f.job.guid })
        assert.equal(homeCurrencyBalance(f.state()), 1000n)
    } finally {
        f.store.close()
    }
})
test('actual11011 separates one real completed output from remaining old paid refund and rolls both back on sync failure', () => {
    const f = legacyJob('home-currency-quick-partial')
    try {
        f.setNow(f.job.start + f.job.seconds)
        const before = f.state(),
            packet = f.game.packet
        f.game.packet = function (name, ...args) {
            if (name === 'CSProtoSimpleProductFinish') throw Error('currency-quick-codec')
            return packet.call(this, name, ...args)
        }
        try {
            assert.throws(() => f.call('SimpleProductCancel', { u32: f.job.guid }), /currency-quick-codec/)
        } finally {
            f.game.packet = packet
        }
        assert.deepEqual(f.state(), before)
        f.call('SimpleProductCancel', { u32: f.job.guid })
        assert.equal(homeCurrencyBalance(f.state()), 927n)
        assert.equal(
            f
                .state()
                .player.sbag_infos.items.filter((row) => row.itemid === 1000001)
                .reduce((n, row) => n + row.itemnum, 0),
            1,
        )
        assert.equal(f.state().homeCurrencyAcquisition, undefined)
        assert.equal(f.state().simpleProducts.length, 0)
    } finally {
        f.store.close()
    }
})
