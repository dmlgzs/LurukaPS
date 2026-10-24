import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { productionTables } from '../src/production-tables.js'
import { productionMaterials } from '../src/production-materials.js'
import { cookingRecipe } from '../src/cooking.js'
import { grantRewards } from '../src/rewards.js'

export function productionProgressFixture(name, file = ':memory:') {
    const cfg = configuration(),
        tables = productionTables(new Tables(cfg.tables)),
        protocol = new Protocol(cfg.base),
        store = new Store(file)
    let now = 1800000000,
        seq = 1
    const game = new Game(protocol, store, tables, { clock: () => now }),
        session = {}
    const call = (name, data = {}, who = session) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(who, {
            id: entry.id,
            seq: seq++,
            payload: entry.req ? protocol.encode(entry.req, data) : Buffer.alloc(0),
        })
    }
    call('EnterGame', { open_id: name })
    const edit = (fn) => store.transact(session.id, 0, fn)
    edit((state) => {
        state.tasks = []
        state.player.basic_info.lv = 45
        state.taskRecords = tables.get('task').map((row) => ({ task_id: row.id, count: 1, time: 1 }))
        for (const row of tables.get('home_technology'))
            state.home.technology.levels[row.type] = { level: 1, lastTime: 0, isOpened: true }
    })
    const state = () => store.load(session.id).state
    const station = (recipe) => {
        const groups = String(recipe.group).split('|').map(Number)
        const config = tables.get('home_building_production').find((row) => groups.includes(row.groupId))
        if (!config) throw Error('Test recipe has no current station')
        let build = state().home.builds.find((row) => row.build_id === config.id)
        if (!build) {
            const building = tables.find('home_building', config.id)
            const type = tables.get('home_building_group').find((row) => row.groupId === building.groupId).type
            edit((s) =>
                s.home.builds.push({
                    guid: 1000 + s.home.builds.length,
                    build_id: config.id,
                    build_type: type,
                    status: 1,
                    locate: { block_id: 101, anchor: 6750237, direction: 0 },
                }),
            )
            build = state().home.builds.find((row) => row.build_id === config.id)
        }
        return build.guid
    }
    const start = (id, count = 1) => {
        const recipe = tables.find('products', id),
            guid = station(recipe)
        const quality = tables.get('products_multi_quality').find((row) => row.productId === id)
        let request, costs, name
        if (quality) {
            const materials = cookingRecipe(tables, quality.id).requirements.map(({ count, choices }) => ({
                item_id: choices[0],
                item_num: count,
            }))
            costs = materials.map((row) => ({ itemtype: 3, itemid: row.item_id, itemnum: row.item_num }))
            request = { build_guid: guid, cook_id: quality.id, cook_count: count, cook_material: materials }
            name = 'CookRequest'
        } else {
            const selected = String(recipe.materialSelect || '')
                .split('|')
                .filter(Boolean)
                .map(Number)
                .map((group) => tables.get('products_material_group').find((row) => row.materialGroupId === group).Id)
            costs = productionMaterials(tables, recipe, selected)
            request = { build_guid: guid, product_id: id, count, select_material: selected }
            name = 'ProductStart'
        }
        edit((s) =>
            grantRewards(
                tables,
                s,
                costs.map((row) => ({ ...row, itemnum: row.itemnum * count })),
            ),
        )
        call(name, request)
        return { guid, job: state().home.productionJobs[guid].at(-1) }
    }
    const advance = (seconds) => {
        now += seconds
    }
    const finish = ({ guid, job }, cancel = false) =>
        call(cancel ? 'ProductCancel' : 'ProductFinish', { guid, product_guids: [job.guid] })
    const produce = (id, count = 1) => {
        const accepted = start(id, count)
        now = Math.max(now, accepted.job.start + accepted.job.seconds * count)
        return finish(accepted)
    }
    return {
        cfg,
        tables,
        protocol,
        store,
        game,
        session,
        call,
        state,
        edit,
        start,
        finish,
        produce,
        advance,
        reload: () => call('EnterGame', { open_id: name }, {}),
    }
}
