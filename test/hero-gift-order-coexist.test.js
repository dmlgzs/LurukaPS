import test from 'node:test'
import assert from 'node:assert/strict'
import { homeOrderFixture } from './home-order-progress-fixture.js'
import { heroGiftProgressFacts } from '../src/hero-gift-progress.js'
import { journeyModel } from '../src/journey.js'
import { grantRewards, parseRewards } from '../src/rewards.js'

test('actual6227→6610→6227 keeps order and gift sources independent and steady ordinary requests do not republish', () => {
    const f = homeOrderFixture('gift-order-source-coexist')
    try {
        const model = journeyModel(f.tables),
            orderRows = model.byKind.get(15003),
            giftRows = [12227, 12228].flatMap((kind) => model.byKind.get(kind)),
            ordinary = f.tables.get('hero_favorability_gift')[0]
        assert.equal(model.targets.filter((r) => r.supported).length, 155)
        assert.equal(model.referencedTargets.filter((r) => r.supported).length, 139)
        f.complete(1)
        const orderProgress = structuredClone(f.state().homeExchange.orderProgress),
            orderTargets = orderRows.map((r) => structuredClone(f.state().journey.targets[r.id]))
        assert.equal(orderProgress.revision, 1)
        assert.equal(heroGiftProgressFacts(f.state()).total, 0)
        // Fund only gift inventory, not either source ledger or completed goal.
        f.edit((s) => grantRewards(f.tables, s, [{ itemtype: 3, itemid: ordinary.id, itemnum: 5 }]))
        f.call('SendHeroGift', { heroId: 107002, item_id: ordinary.id, item_type: 110, num: 5 })
        assert.equal(heroGiftProgressFacts(f.state()).total, 5)
        assert.deepEqual(f.state().homeExchange.orderProgress, orderProgress)
        assert.deepEqual(
            orderRows.map((r) => f.state().journey.targets[r.id]),
            orderTargets,
        )
        const gifts = structuredClone(f.state().heroGiftProgress),
            giftTargets = giftRows.map((r) => structuredClone(f.state().journey.targets[r.id]))
        assert(giftTargets.every((r) => r.complete))
        f.complete(1)
        assert.equal(f.state().homeExchange.completedOrders, 2)
        assert.equal(f.state().homeExchange.orderProgress.revision, 2)
        assert.deepEqual(f.state().heroGiftProgress, gifts)
        assert.deepEqual(
            giftRows.map((r) => f.state().journey.targets[r.id]),
            giftTargets,
        )
        assert.equal(f.state().journey.observedSources.orders, 2)
        assert.equal(f.state().journey.observedSources.gift, 1)
        f.call('ActivityGet')
        for (let i = 0; i < 5; i++)
            assert.equal(
                f.call('ActivityGet').some((p) => p.id === 11880),
                false,
            )
        // Preserve the official260 strict-null order source guard, without
        // weakening it because the new unrelated gift ledger is valid.
        const slot = f.state().homeExchange.board.slots.find((r) => r.guid && !r.done),
            definition = f.tables.get('home_exchange_order').find((r) => r.orderID === slot.order_id)
        f.edit((s) => {
            grantRewards(f.tables, s, parseRewards(definition.orderNeedMaterials))
            s.homeExchange.completedOrders = null
        })
        const malformed = f.state()
        assert.throws(() => f.call('CSFinishOrder', { order_guid: slot.guid }), /Invalid completed home order total/)
        assert.deepEqual(f.state(), malformed)
    } finally {
        f.close()
    }
})
