export function soulEssenceValue(tables, config, level) {
    return tables.find('soulessence_value', config.attribute * 1000 + level)
}
