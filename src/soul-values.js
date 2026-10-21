import references from '../configs/soul-tables/attributes.json' with { type: 'json' }
import values from '../configs/soul-tables/values.json' with { type: 'json' }

const groups = new Map(references.map((row) => [row.id, row.attribute]))
const overrides = new Map(values.map((row) => [row.id, row]))
// 2451868 changes eight template references and 900 numeric rows. Localized
// names, descriptions and unrelated fields still come from external tables.
export function soulEssenceValue(tables, config, level) {
    const id = (groups.get(config.id) ?? config.attribute) * 1000 + level
    return overrides.get(id) ?? tables.find('soulessence_value', id)
}
