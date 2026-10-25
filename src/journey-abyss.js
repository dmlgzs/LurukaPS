import { abyssTables } from './abyss-catalog.js'
import { battlePassAbyssValue as abyssPassedValue } from './battle-pass-abyss.js'

// Current journey13111 rows address permanent modes. Reuse the already
// verified passed predicate, not a second win/star/reward interpretation.
export function journeyAbyssRule(tables, tokens) {
    const [kind, id] = tokens
    if (kind !== 13111 || tokens.length !== 2 || !Number.isSafeInteger(id) || id <= 0) return false
    const current = abyssTables(tables),
        level = current.find('abbys_level', id)
    if (![1, 2].includes(level?.mode)) return false
    return String(current.find('abbys_mode', level.mode)?.level).split('|').map(Number).includes(id)
}

export function journeyAbyssValue(tables, state, id) {
    // A future rotating journey needs explicit clock plumbing. Its rule stays
    // unsupported instead of consulting a stale rotation or wall-clock guess.
    if (!journeyAbyssRule(tables, [13111, id])) return null
    return abyssPassedValue(tables, state, id)
}
