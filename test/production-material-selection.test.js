import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { productionTables } from '../src/production-tables.js'
import { productionMaterials } from '../src/production-materials.js'
import { grantRewards, parseRewards } from '../src/rewards.js'
import { ensureHome } from '../src/home.js'
import { ErrorCode } from '../src/error-codes.js'

test('every current selectable recipe resolves table row IDs and aggregates identical items across distinct groups', () => {
    const tables = productionTables(new Tables(configuration().tables))
    const rows = tables.get('products_material_group')
    const selectedRecipes = tables.get('products').filter((row) => row.materialSelect)
    assert.equal(selectedRecipes.length, 16)
    for (const recipe of selectedRecipes) {
        const groups = recipe.materialSelect.split('|').map(Number)
        const choices = groups.map((id) => rows.find((row) => row.materialGroupId === id).Id)
        const costs = productionMaterials(tables, recipe, choices)
        const expected = new Map()
        for (const cost of [
            ...parseRewards(recipe.material),
            ...choices.flatMap((id) => parseRewards(rows.find((row) => row.Id === id).material)),
        ])
            expected.set(
                `${cost.itemtype}:${cost.itemid}`,
                (expected.get(`${cost.itemtype}:${cost.itemid}`) ?? 0) + cost.itemnum,
            )
        assert.deepEqual(new Map(costs.map((cost) => [`${cost.itemtype}:${cost.itemid}`, cost.itemnum])), expected)
        assert.throws(
            () => productionMaterials(tables, recipe, []),
            (error) => error.code === ErrorCode.ProductSelectMaterialFail,
        )
    }
    const combined = productionMaterials(tables, tables.find('products', 1600023), [14, 23])
    assert.equal(combined.find((row) => row.itemid === 307000).itemnum, 10)
    assert.equal(combined.find((row) => row.itemid === 306004).itemnum, 4)
    assert.throws(
        () => productionMaterials(tables, tables.find('products', 302001), [1]),
        (error) => error.code === ErrorCode.ProductSelectMaterialFail,
    )
})

test('6110 charges fixed and selected materials per serving and cancellation refunds actual uncompleted costs', () => {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base),
        store = new Store(':memory:')
    let now = 1800000000,
        seq = 1
    const game = new Game(protocol, store, tables, { clock: () => now }),
        session = {}
    const call = (name, data = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, data) })
    }
    const state = () => store.load(session.id).state
    const quantity = (id) =>
        state()
            .player.sbag_infos.items.filter((row) => row.itemid === id)
            .reduce((n, row) => n + row.itemnum, 0)
    const currency = (id) => BigInt(state().player.attr_infos.attrs.find((row) => row.attr_id === id).attr_val)
    try {
        call('EnterGame', { open_id: 'product-material-choice' })
        store.transact(session.id, 0, (s) => {
            const home = ensureHome(tables, s)
            home.technology ??= { levels: {}, spent: 0 }
            home.technology.levels[11005] = { level: 1, lastTime: 0, isOpened: true }
            const config = tables.find('home_building', 20091)
            const type = tables.get('home_building_group').find((row) => row.groupId === config.groupId).type
            home.builds.push({
                guid: 2,
                build_id: 20091,
                build_type: type,
                status: 1,
                locate: { ...home.builds[0].locate },
            })
            grantRewards(tables, s, [
                { itemtype: 3, itemid: 301000, itemnum: 50 },
                { itemtype: 10, itemid: 700, itemnum: 10 },
            ])
        })
        const option = tables
            .get('products_material_group')
            .find((row) => row.materialGroupId === 20 && row.material === '10#700#1')
        const request = { build_guid: 2, product_id: 303004, count: 3, select_material: [option.Id] }
        const before = structuredClone(state())
        for (const select_material of [[], [700], [14], [option.Id, option.Id]]) {
            assert.throws(
                () => call('ProductStart', { ...request, select_material }),
                (error) => error.code === ErrorCode.ProductSelectMaterialFail,
            )
            assert.deepEqual(state(), before)
        }
        call('ProductStart', request)
        assert.equal(quantity(301000), 5)
        assert.equal(currency(700), 7n)
        const job = state().home.productionJobs[2][0]
        assert.deepEqual(job.costs, [
            { itemtype: 3, itemid: 301000, itemnum: 15 },
            { itemtype: 10, itemid: 700, itemnum: 1 },
        ])
        now = job.start + job.seconds
        call('ProductFinish', { guid: 2, product_guids: [job.guid] })
        assert.equal(quantity(312001), 1)
        call('ProductCancel', { guid: 2, product_guids: [job.guid] })
        assert.equal(quantity(301000), 35)
        assert.equal(currency(700), 9n)
        assert.equal(state().home.craftCounts[303004], 1)
        assert.deepEqual(state().home.productionJobs[2], [])
        assert.throws(() => call('ProductCancel', { guid: 2, product_guids: [job.guid] }))
    } finally {
        store.close()
    }
})
