import { abyssTables } from './abyss-catalog.js'
import { activeAbyssRotation } from './abyss-rotation.js'

// 13111 is AbbysLevelPassCond: the configured level's authoritative passed
// property, not a lifetime clear counter or a client-provided result.
export function battlePassAbyssRule(tables, row, tokens) {
    const [kind, id] = tokens
    // Current fixed-season tasks have a one-time property predicate. Do not
    // reinterpret a future daily/weekly row as this historical property.
    if (
        kind !== 13111 ||
        tokens.length !== 2 ||
        row.type !== 3 ||
        row.param !== 1 ||
        !Number.isSafeInteger(id) ||
        id <= 0
    )
        return false
    return [1, 2, 3].includes(abyssTables(tables).find('abbys_level', id)?.mode)
}

export function battlePassAbyssValue(tables, state, id, now) {
    const level = abyssTables(tables).find('abbys_level', id)
    if (!level) return 0
    if (level.mode !== 3) return Number(state.abyss?.modes?.[level.mode]?.levels?.[id]?.passed === true)
    const rotation = activeAbyssRotation(abyssTables(tables), now)
    if (!rotation || !String(rotation.level).split('|').map(Number).includes(id)) return 0
    return Number(state.abyss?.rotation?.id === rotation.id && state.abyss.rotation.levels?.[id]?.passed === true)
}
