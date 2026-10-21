import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { productionTables } from '../src/production-tables.js'
import { grantRewards } from '../src/rewards.js'
import { ErrorCode } from '../src/error-codes.js'

test('11010 shares row-ID material validation and refunds selected costs after partial automatic completion', () => {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        current = productionTables(tables),
        protocol = new Protocol(cfg.base)
    const store = new Store(':memory:')
    let now = 1800000000,
        seq = 1
    const game = new Game(protocol, store, tables, { clock: () => now }),
        session = {}
    const call = (name, data = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, data) })
    }
    const state = () => store.load(session.id).state
    const count = (id) =>
        state()
            .player.sbag_infos.items.filter((row) => row.itemid === id)
            .reduce((n, row) => n + row.itemnum, 0)
    const recipe = current.find('products', 501001),
        old = recipe.materialSelect
    try {
        call('EnterGame', { open_id: 'quick-production-choice' })
        const quick = current.get('products').filter((row) => row.isQuickProduct === 1)
        assert.equal(quick.length, 20)
        assert.ok(quick.every((row) => row.time > 0))
        assert.ok(quick.every((row) => !row.materialSelect))
        // Current quick recipes have no selectable slot. This fixture variant
        // tests the protocol's documented select_material field using a real
        // option group, without changing a shipped config or enabling a recipe.
        recipe.materialSelect = '5'
        store.transact(session.id, 0, (s) => {
            s.player.sbag_infos.items = []
            grantRewards(tables, s, [
                { itemtype: 3, itemid: 312001, itemnum: 10 },
                { itemtype: 3, itemid: 307000, itemnum: 20 },
            ])
        })
        const request = { build_guid: 0, product_id: recipe.id, count: 3, select_material: [14] }
        const before = structuredClone(state())
        for (const select_material of [[], [1], [307000], [14, 14]]) {
            assert.throws(
                () => call('SimpleProductStart', { ...request, select_material }),
                (error) => error.code === ErrorCode.ProductSelectMaterialFail,
            )
            assert.deepEqual(state(), before)
        }
        call('SimpleProductStart', request)
        assert.equal(count(312001), 4)
        assert.equal(count(307000), 5)
        const job = state().simpleProducts[0]
        assert.deepEqual(job.costs, [
            { itemtype: 3, itemid: 312001, itemnum: 2 },
            { itemtype: 3, itemid: 307000, itemnum: 5 },
        ])
        now = job.start + job.seconds
        game.tick(session.id)
        assert.equal(count(1000001), 1)
        call('SimpleProductCancel', { u32: job.guid })
        assert.equal(count(312001), 8)
        assert.equal(count(307000), 15)
        assert.equal(state().simpleProduced['3:1000001'], 1)
        assert.deepEqual(state().simpleProducts, [])
        call('SimpleProductCancel', { u32: job.guid })
        assert.equal(count(307000), 15)
    } finally {
        recipe.materialSelect = old
        store.close()
    }
})
