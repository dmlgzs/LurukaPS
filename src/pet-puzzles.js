import fs from 'node:fs'
import { WorldObjectCatalog } from './world-objects.js'

const rules = new Map(
    JSON.parse(fs.readFileSync(new URL('../configs/pet-puzzle-rules.json', import.meta.url), 'utf8')).blueprints.map(
        (rule) => [rule.path.toLowerCase(), rule],
    ),
)
export function petPuzzleRule(tables, row, spawner) {
    const blueprint = tables.find('world_blueprint', row.blueprint || spawner.blueprint)
    return rules.get(blueprint?.path?.toLowerCase())
}
// CommonState is an enum + component snapshot, not a cumulative counter.
// Only graph-backed puzzle objects use these semantics; harvesting keeps its
// existing monotonic stages and reward receipts.
export function puzzleVisibility(record, row) {
    return record.active ?? (!record.complete || !!row.keepOnComplete)
}
const catalogs = new WeakMap()
export function repairSavedPetPuzzleVisibility(tables, state) {
    let catalog = catalogs.get(tables)
    if (!catalog) catalogs.set(tables, (catalog = new WorldObjectCatalog(tables)))
    for (const [key, record] of Object.entries(state.worldObjects ?? {})) {
        if (record.active !== undefined) continue
        const [map, id] = key.split(':').map(Number)
        if (!Number.isInteger(map) || map <= 0 || !Number.isInteger(id) || id <= 0) continue
        let row
        try {
            row = catalog.find('worldmap_' + map, id)
        } catch (error) {
            if (error.code === 'ENOENT') continue
            throw error
        }
        const spawner = row && catalog.find('world_spawner', row.spawnerId)
        if (spawner && petPuzzleRule(tables, row, spawner)) record.active = puzzleVisibility(record, row)
    }
}
