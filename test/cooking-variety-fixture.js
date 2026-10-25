import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Protocol } from '../src/protocol.js'
import { Game } from '../src/game.js'
import { productionTables } from '../src/production-tables.js'
import { cookingRecipe } from '../src/cooking.js'
import { grantRewards } from '../src/rewards.js'

export function cookingVarietyFixture(name, file = ':memory:', resume = false) {
    const cfg = configuration(),
        tables = productionTables(new Tables(cfg.tables)),
        protocol = new Protocol(cfg.base),
        store = new Store(file),
        session = {}
    let now = 1800000000,
        sequence = 1
    const game = new Game(protocol, store, tables, { clock: () => now })
    const call = (name, request = {}, who = session) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(who, {
            id: entry.id,
            seq: sequence++,
            payload: entry.req ? protocol.encode(entry.req, request) : Buffer.alloc(0),
        })
    }
    call('EnterGame', { open_id: name })
    const state = () => store.load(session.id).state,
        edit = (fn) => store.transact(session.id, 0, fn)
    if (!resume)
        edit((s) => {
            s.tasks = []
            s.player.basic_info.lv = 45
        })
    const quality = tables.get('products_multi_quality')
    const current = quality.filter((row) => {
        const recipe = tables.find('products', row.productId)
        return recipe?.type === 3 && !recipe.notReleased && !recipe.isNeedPet
    })
    const groups = new Map()
    for (const row of current) {
        const previous = groups.get(row.productGroup)
        if (!previous || row.productRarity < previous.productRarity) groups.set(row.productGroup, row)
    }
    const station = (product) => {
        const groupIds = String(product.group).split('|').map(Number)
        const config = tables.get('home_building_production').find((row) => groupIds.includes(row.groupId))
        if (!config) throw Error('Current cooking recipe has no station')
        let build = state().home.builds.find((row) => row.build_id === config.id)
        if (!build) {
            const building = tables.find('home_building', config.id)
            const type = tables.get('home_building_group').find((row) => row.groupId === building.groupId).type
            edit((s) =>
                s.home.builds.push({
                    guid: Math.max(0, ...s.home.builds.map((row) => row.guid)) + 1,
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
        const recipe = cookingRecipe(tables, id),
            guid = station(recipe.product),
            materials = recipe.requirements.map((row) => ({ item_id: row.choices[0], item_num: row.count }))
        edit((s) => {
            // Legitimately learned prerequisites and ingredients only. No
            // production history, cooked item or achievement receipt is seeded.
            for (const condition of String(recipe.product.unlockCondition || '')
                .split('|')
                .filter(Boolean)) {
                const [kind, id, level] = condition.split('#').map(Number)
                if (kind === 11012) s.home.technology.levels[id] = { level: level || 1, lastTime: 0, isOpened: true }
                else if (kind === 2004) s.player.basic_info.lv = Math.max(s.player.basic_info.lv, id)
                else throw Error('Cooking test requires an unproven prerequisite ' + condition)
            }
            grantRewards(
                tables,
                s,
                materials.map((row) => ({ itemtype: 3, itemid: row.item_id, itemnum: row.item_num * count })),
            )
        })
        call('CookRequest', { build_guid: guid, cook_id: id, cook_count: count, cook_material: materials })
        return { guid, job: structuredClone(state().home.productionJobs[guid].at(-1)) }
    }
    const advance = (seconds) => {
        now += seconds
    }
    const due = ({ job }, units = job.count) => {
        now = Math.max(now, job.start + job.seconds * units)
    }
    const finish = ({ guid, job }, cancel = false) =>
        call(cancel ? 'ProductCancel' : 'ProductFinish', { guid, product_guids: [job.guid] })
    const aggregate = ({ guid }) => call('GetAllBuildReward', { build_guid: [guid] })
    const cook = (id, aggregateClaim = false) => {
        const accepted = start(id)
        due(accepted)
        return aggregateClaim ? aggregate(accepted) : finish(accepted)
    }
    return {
        cfg,
        tables,
        protocol,
        store,
        session,
        game,
        call,
        state,
        edit,
        current,
        groups,
        start,
        advance,
        due,
        finish,
        aggregate,
        cook,
        close: () => store.close(),
    }
}
