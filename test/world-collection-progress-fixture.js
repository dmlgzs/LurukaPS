import { achievementFixture } from './achievement-fixture.js'
import { parseRewards } from '../src/rewards.js'
import { addItems } from '../src/inventory.js'

export function worldCollectionProgressFixture(name, file = ':memory:') {
    const f = achievementFixture(name, file)
    const edit = (fn) => f.store.transact(f.session.id, 0, fn)
    if (!Object.keys(f.state().home.worldCollections ?? {}).length)
        edit((state) => {
            state.player.basic_info.lv = 80
            state.player.basic_info.gold = 100000000
            // Isolate repair prerequisites and fees, never inject13039 repairs,
            // progress or journey completion receipts.
            state.taskRecords ??= []
            for (const id of [106009, 400201])
                if (!state.taskRecords.some((row) => row.task_id === id))
                    state.taskRecords.push({ task_id: id, count: 1 })
            const items = new Map(),
                currencies = new Map()
            for (const row of f.tables.get('home_building_collection'))
                for (const cost of parseRewards(row.material)) {
                    const map = cost.itemtype === 3 ? items : currencies
                    map.set(cost.itemid, (map.get(cost.itemid) ?? 0) + cost.itemnum)
                }
            addItems(
                state,
                [...items].map(([itemid, itemnum]) => ({ itemtype: 3, itemid, itemnum: itemnum + 100 })),
            )
            for (const [id, amount] of currencies) {
                const attr = state.player.attr_infos.attrs.find((row) => row.attr_id === id)
                if (attr) attr.attr_val = String(amount + 100)
                else state.player.attr_infos.attrs.push({ attr_id: id, attr_val: String(amount + 100) })
            }
        })
    const repair = (id) => f.call('CollectBuildCreate', { collect_id: id, source_build: 0 })
    return { ...f, edit, repair }
}
