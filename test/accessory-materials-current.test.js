import test from 'node:test'
import assert from 'node:assert/strict'
import { forgeFixture } from './forge-progress-fixture.js'
import { accessoryProductionPlan } from '../src/accessory-production.js'
import { parseRewards, grantRewards } from '../src/rewards.js'
import { ErrorCode } from '../src/error-codes.js'

const groups = (recipe) => String(recipe.materialSelect).split('|').filter(Boolean).map(Number)
const choices = (f, recipe) =>
    groups(recipe).map(
        (group) => f.tables.get('products_material_group').find((row) => row.materialGroupId === group).Id,
    )
const total = (rows) => {
    const result = new Map()
    for (const row of rows) {
        const key = row.itemtype + ':' + row.itemid
        result.set(key, (result.get(key) ?? 0) + row.itemnum)
    }
    return [...result].sort(([a], [b]) => a.localeCompare(b))
}
const stock = (state, id) =>
    state.player.sbag_infos.items.filter((row) => row.itemid === id).reduce((n, row) => n + row.itemnum, 0)
const plan = (f, recipe, selected) =>
    accessoryProductionPlan(
        f.tables,
        f.state(),
        f.state().home.builds.find((row) => row.guid === 200),
        { product_id: recipe.id, count: 1, select_material: selected },
    )

test('current accessory plans charge every configured selectable option as well as fixed materials', () => {
    const f = forgeFixture('current-accessory-material-catalogue')
    try {
        const recipes = f.tables.get('accessory_product')
        assert.equal(recipes.length, 22)
        assert.equal(recipes.filter((row) => groups(row).length).length, 20)
        for (const recipe of recipes) {
            const selected = choices(f, recipe)
            const combinations = [selected]
            for (let index = 0; index < selected.length; index++)
                for (const option of f.tables
                    .get('products_material_group')
                    .filter((row) => row.materialGroupId === groups(recipe)[index]))
                    combinations.push(selected.map((id, position) => (position === index ? option.Id : id)))
            for (const ids of combinations) {
                const result = plan(f, recipe, ids)
                const expected = [
                    ...parseRewards(recipe.material),
                    ...ids.flatMap((id) =>
                        parseRewards(f.tables.get('products_material_group').find((row) => row.Id === id).material),
                    ),
                ]
                assert.deepEqual(total(result.costs), total(expected), 'recipe ' + recipe.id + ' options ' + ids)
            }
        }
    } finally {
        f.store.close()
    }
})

test('current10202 rejects omitted, extra and wrong-group material choices without debiting assets', () => {
    const f = forgeFixture('current-accessory-material-negative')
    try {
        const recipe = f.tables.get('accessory_product').find((row) => groups(row).length)
        const valid = choices(f, recipe)
        const other = f.tables
            .get('products_material_group')
            .find((row) => !groups(recipe).includes(row.materialGroupId)).Id
        for (const selected of [[], [...valid, valid[0]], [other], [0]]) {
            const before = f.state()
            assert.throws(
                () =>
                    f.call('ProductOrnamentStart', {
                        build_guid: 200,
                        product_id: recipe.id,
                        count: 1,
                        select_material: selected,
                    }),
                (error) => error.code === ErrorCode.ProductSelectMaterialFail,
            )
            assert.deepEqual(f.state(), before)
        }
    } finally {
        f.store.close()
    }
})

test('current10202 selected-material debit survives relogin and rolls back start/claim codec failures', () => {
    const f = forgeFixture('current-accessory-material-public')
    const encode = f.protocol.encode.bind(f.protocol)
    try {
        const recipe = f.tables.get('accessory_product').find((row) => groups(row).length)
        const selected = choices(f, recipe)
        const output = plan(f, recipe, selected)
        const target = [...output.leaves.keys()][0]
        const directed = accessoryProductionPlan(
            f.tables,
            f.state(),
            f.state().home.builds.find((row) => row.guid === 200),
            { product_id: recipe.id, count: 1, select_material: selected, designated_item_id: target },
        )
        const expected = [
            ...parseRewards(recipe.material),
            ...selected.flatMap((id) =>
                parseRewards(f.tables.get('products_material_group').find((row) => row.Id === id).material),
            ),
            ...parseRewards(recipe.locateCost),
        ]
        f.edit((state) => grantRewards(f.tables, state, expected))
        const request = {
            build_guid: 200,
            product_id: recipe.id,
            count: 1,
            select_material: selected,
            designated_item_id: target,
        }
        const before = f.state()
        const sql = f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id)
        const ack = f.protocol.byName.get('CSProtoProductOrnamentStart').rsp
        f.protocol.encode = function (name, ...args) {
            if (name === ack) throw Error('current-material-start-codec')
            return encode(name, ...args)
        }
        assert.throws(() => f.call('ProductOrnamentStart', request), /current-material-start-codec/)
        assert.deepEqual(f.state(), before)
        assert.deepEqual(
            f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
            sql,
        )
        f.protocol.encode = encode
        f.call('ProductOrnamentStart', request)
        const job = f.state().home.productionJobs[200][0]
        assert.deepEqual(total(job.costs), total(directed.costs))
        for (const [key, count] of total(expected)) {
            const [type, id] = key.split(':').map(Number)
            if (type === 3) assert.equal(stock(f.state(), id), stock(before, id) - count)
        }
        f.reload()
        assert.deepEqual(total(f.state().home.productionJobs[200][0].costs), total(expected))
        f.due([job])
        const beforeClaim = f.state()
        const claimSql = f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id)
        const ornamentRsp = f.protocol.byId.get(6029).rsp
        f.protocol.encode = function (name, ...args) {
            if (name === ornamentRsp) throw Error('current-material-claim-codec')
            return encode(name, ...args)
        }
        assert.throws(() => f.finish([job]), /current-material-claim-codec/)
        assert.deepEqual(f.state(), beforeClaim)
        assert.deepEqual(
            f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
            claimSql,
        )
        f.protocol.encode = encode
        f.finish([job])
        assert.equal(f.state().ornaments.length, (beforeClaim.ornaments ?? []).length + 1)
        const claimed = f.state()
        assert.throws(() => f.finish([job]))
        assert.deepEqual(f.state(), claimed)
    } finally {
        f.protocol.encode = encode
        f.store.close()
    }
})
