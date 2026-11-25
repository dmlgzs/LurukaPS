const adapters = new WeakMap(),
    wrapped = new WeakSet()

export function gachaTables(external) {
    if (wrapped.has(external)) return external
    if (!adapters.has(external)) {
        const adapter = Object.create(external),
            indices = new Map()
        adapter.find = (name, id) => {
            const key = name === 'gacha' ? 'gachaId' : name === 'gacha_guarantee' ? 'guaranteeId' : null
            if (!key) return external.find(name, id)
            if (!indices.has(name)) indices.set(name, new Map(external.get(name).map((row) => [row[key], row])))
            return indices.get(name).get(Number(id))
        }
        adapters.set(external, adapter)
        wrapped.add(adapter)
    }
    return adapters.get(external)
}
