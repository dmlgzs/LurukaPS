import { GachaCatalog } from '../gacha.js'

export function registerGacha(on, tables) {
    // Loaded on first request: an unrelated login need not parse the entire gacha catalog.
    let catalog
    const data = () => (catalog ??= new GachaCatalog(tables))
    on('GachaData', (c) => ({
        // This is progress data, not permission to draw in a closed banner.
        gacha_pools: [...data().pools.keys()].map((id) => data().snapshot(c.state, id)),
    }))
}
