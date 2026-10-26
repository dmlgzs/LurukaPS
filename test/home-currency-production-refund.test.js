import test from 'node:test'
import assert from 'node:assert/strict'
import { homeCurrencyFixture, homeCurrencyBalance } from './home-currency-fixture.js'
import { productionTables } from '../src/production-tables.js'
import { parseRewards, grantRewards } from '../src/rewards.js'

function setup(name) {
    const f = homeCurrencyFixture(name)
    const recipe = productionTables(f.tables).find('products', 710010)
    f.edit((state) => {
        state.home.technology ??= { levels: {}, spent: 0 }
        state.home.technology.levels[11010] = { level: 1, lastTime: 0, isOpened: true }
        grantRewards(
            f.tables,
            state,
            parseRewards(recipe.material)
                .filter((r) => r.itemtype === 3)
                .map((r) => ({ ...r, itemnum: r.itemnum * 4 })),
        )
    })
    f.setOldBalance(3000)
    return {
        ...f,
        recipe,
        start: () => f.call('ProductStart', { build_guid: 1, product_id: recipe.id, count: 1 }),
        cancel: (ids) => f.call('ProductCancel', { guid: 1, product_guids: ids }),
    }
}
test('actual6112 refunds only paid unfinished currency and preserves prospective103 exclusion across retries', () => {
    const f = setup('home-currency-production-refund')
    try {
        const first = homeCurrencyBalance(f.state())
        for (let i = 0; i < 2; i++) {
            f.start()
            const job = f.state().home.productionJobs[1].at(-1)
            assert.equal(homeCurrencyBalance(f.state()), first - 600n)
            f.cancel([job.guid])
            assert.equal(homeCurrencyBalance(f.state()), first)
            assert.equal(f.state().homeCurrencyAcquisition, undefined)
            const before = f.state()
            assert.throws(() => f.cancel([job.guid]))
            assert.deepEqual(f.state(), before)
        }
    } finally {
        f.store.close()
    }
})
test('actual6112 mixed completed output and unfinished refunds remain distinct and a failed reply rolls back both', () => {
    const f = setup('home-currency-production-mixed')
    try {
        f.start()
        f.start()
        const jobs = f.state().home.productionJobs[1]
        f.setNow(jobs[0].start + jobs[0].seconds)
        const before = f.state(),
            packet = f.game.packet
        f.game.packet = function (name, ...args) {
            if (name === 'CSProtoSyncPlayerData') throw Error('currency-cancel-codec')
            return packet.call(this, name, ...args)
        }
        try {
            assert.throws(() => f.cancel(jobs.map((job) => job.guid)), /currency-cancel-codec/)
        } finally {
            f.game.packet = packet
        }
        assert.deepEqual(f.state(), before)
        f.cancel(jobs.map((job) => job.guid))
        assert.equal(homeCurrencyBalance(f.state()) - homeCurrencyBalance(before), 600n)
        assert.equal(f.state().home.inventory.find((row) => row.build_id === 20041).total_num, 1)
        assert.equal(f.state().homeCurrencyAcquisition, undefined)
        assert.equal(f.state().home.productionJobs[1].length, 0)
    } finally {
        f.store.close()
    }
})
