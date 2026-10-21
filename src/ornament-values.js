import values from '../configs/ornament-values/values.json' with { type: 'json' }

const adapters = new WeakMap(),
    wrapped = new WeakSet()
const overrides = Object.fromEntries(
    ['accessory', 'accessory_main'].map((name) => [name, new Map(values[name].map((row) => [row.id, row]))]),
)
// Update verified numeric fields only; names and unrelated configuration remain
// external. In particular this is not a replacement for the smelting tables.
export function ornamentValueTables(tables) {
    if (wrapped.has(tables)) return tables
    if (!adapters.has(tables)) {
        const adapter = Object.create(tables),
            cache = new Map(),
            indices = new Map()
        adapter.get = (name) => {
            if (!Object.hasOwn(overrides, name)) return tables.get(name)
            if (!cache.has(name)) {
                const removed = new Set(values['removed_' + name])
                const rows = tables
                    .get(name)
                    .filter((row) => !removed.has(row.id))
                    .map((row) => (overrides[name].has(row.id) ? { ...row, ...overrides[name].get(row.id) } : row))
                const ids = new Set(rows.map((row) => row.id))
                for (const row of overrides[name].values()) if (!ids.has(row.id)) rows.push({ ...row })
                cache.set(name, rows)
            }
            return cache.get(name)
        }
        adapter.find = (name, id) => {
            if (!Object.hasOwn(overrides, name)) return tables.find(name, id)
            if (!indices.has(name)) indices.set(name, new Map(adapter.get(name).map((row) => [row.id, row])))
            return indices.get(name).get(Number(id))
        }
        adapters.set(tables, adapter)
        wrapped.add(adapter)
    }
    return adapters.get(tables)
}
