import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Tables } from './player.js'

const directory = fileURLToPath(new URL('../configs/gacha-tables/', import.meta.url))
const provenance = JSON.parse(fs.readFileSync(new URL('../configs/gacha-tables/source.json', import.meta.url)))
const names = new Set(provenance.tables.map((row) => row.name))
const current = new Tables(directory),
    adapters = new WeakMap(),
    wrapped = new WeakSet()

// Verified 2451868 data adds novice guarantee 802 and changes 801's base chance.
// Other tables remain external; never localize numeric IDs or copy the whole table tree.
export function gachaTables(external) {
    if (wrapped.has(external)) return external
    if (!adapters.has(external)) {
        const adapter = Object.create(external)
        adapter.get = (name) => (names.has(name) ? current.get(name) : external.get(name))
        adapter.find = (name, id) => (names.has(name) ? current.find(name, id) : external.find(name, id))
        adapters.set(external, adapter)
        wrapped.add(adapter)
    }
    return adapters.get(external)
}
