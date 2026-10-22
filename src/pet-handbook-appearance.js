import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const indexes = new WeakMap()
const value = (row, key) => row?.[key + '_id'] ?? row?.[key]
export function handbookPalettes(tables) {
    if (!indexes.has(tables)) {
        const result = new Map()
        for (const row of tables.get('pet_color')) {
            ensure(
                Number.isSafeInteger(row.starcolorId) && row.starcolorId > 0 && !result.has(row.starcolorId),
                'Invalid star-color palette configuration',
                ErrorCode.GameConfig,
            )
            result.set(row.starcolorId, row)
        }
        indexes.set(tables, result)
    }
    return indexes.get(tables)
}
function variantLimit(tables, config) {
    const unit = tables.find('unit', config.unitId)
    ensure(unit, 'Missing pet appearance unit configuration', ErrorCode.GameConfig)
    const variants = value(unit, 'specialParm')
    if (!variants) return 0
    return Array.isArray(variants) ? variants.length : String(variants).split('|').filter(Boolean).length
}
export function observeHandbookAppearance(tables, config, previous, specimens) {
    const palettes = handbookPalettes(tables)
    const colors = previous?.colors ?? [],
        colorfuls = previous?.colorfuls ?? []
    ensure(
        Array.isArray(colors) && Array.isArray(colorfuls),
        'Invalid handbook appearance history',
        ErrorCode.GameConfig,
    )
    const normal = new Set(colors),
        stars = new Set(colorfuls)
    let limit
    const validVariant = (id) => {
        limit ??= variantLimit(tables, config)
        return Number.isSafeInteger(id) && id > 0 && id <= limit
    }
    ensure(
        [...normal].every(validVariant) && [...stars].every((id) => Number.isSafeInteger(id) && palettes.has(id)),
        'Saved handbook appearance history has unknown entries',
        ErrorCode.GameConfig,
    )
    for (const pet of specimens) {
        const variant = pet.color ?? 0,
            palette = pet.colorful ?? 0
        ensure(
            [variant, palette].every((id) => Number.isSafeInteger(id) && id >= 0 && id <= 0xffffffff),
            'Invalid saved pet appearance identifier',
            ErrorCode.GameConfig,
        )
        if (variant) {
            ensure(validVariant(variant), 'Pet appearance variant has no unit model', ErrorCode.GameConfig)
            normal.add(variant)
        }
        if (palette) {
            ensure(palettes.has(palette), 'Pet star color has no palette configuration', ErrorCode.GameConfig)
            stars.add(palette)
        }
    }
    // Zero is the normal preview option inserted by the frontend; it is not
    // an acquired special model or star-color palette.
    return { colors: [...normal].sort((a, b) => a - b), colorfuls: [...stars].sort((a, b) => a - b) }
}
