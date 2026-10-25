import { fixture, tables, protocol } from './home-collection-fixture.js'
export { tables, protocol }
export const product = 139000002
export const build = (state) => state.home.builds.find((row) => row.guid === 100)
export const extra = (state) => build(state).collect_build_data.items.filter((row) => row.source_product_id === product)
export const stock = (state, id) =>
    state.player.sbag_infos.items.filter((row) => row.itemid === id).reduce((n, row) => n + row.itemnum, 0)
export function multiCollectionFixture(file) {
    const f = fixture(file)
    f.edit((state) => {
        // Isolate existing prerequisite nodes.10087 itself is purchased by its
        // real protocol, with normal15+ gate and actual technology-point debit.
        state.player.basic_info.lv = 30
        for (const id of [10023, 10055]) state.home.technology.levels[id] = { level: 1, lastTime: 0 }
    })
    f.call('HomeTechnologyLevelUp', { type: 1, subType: 10087 })
    f.call('PetStationed', { build_guid: 100, build_type: 1, pet_guid: f.worker })
    return f
}
