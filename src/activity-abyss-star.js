import { abyssTables } from './abyss-catalog.js'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const uint = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff,
    positive = (n) => uint(n) && n > 0,
    object = (value) => value && typeof value === 'object' && !Array.isArray(value)

export function activityAbyssStarValue(tables, state, tokens) {
    if (!Array.isArray(tokens) || tokens.length !== 3 || tokens[0] !== 13123 || !tokens.slice(1).every(positive))
        return null
    const [, id, target] = tokens,
        current = abyssTables(tables),
        level = current.find('abbys_level', id)
    // The complete current13123 activity family uses permanent levels.
    // Future rotation conditions require an explicit canonical clock.
    if (!level || ![1, 2].includes(level.mode)) return null
    ensure(positive(level.star), 'Invalid abyss activity maximum stars', ErrorCode.GameConfig)
    if (target > level.star) return null
    const mode = current.find('abbys_mode', level.mode),
        ids = String(mode?.level ?? '')
            .split('|')
            .filter(Boolean)
            .map(Number)
    ensure(
        mode && ids.every(positive) && new Set(ids).size === ids.length,
        'Invalid abyss activity mode membership',
        ErrorCode.GameConfig,
    )
    if (!ids.includes(id)) return null
    const abyss = state.abyss,
        modes = abyss?.modes,
        savedMode = modes?.[level.mode],
        levels = savedMode?.levels,
        saved = levels?.[id]
    for (const value of [abyss, modes, savedMode, levels, saved])
        ensure(value === undefined || object(value), 'Malformed saved abyss activity progress', ErrorCode.GameConfig)
    if (saved === undefined) return 0
    const passed = saved.passed === undefined ? false : saved.passed,
        stars = saved.star_num === undefined ? 0 : saved.star_num
    ensure(typeof passed === 'boolean', 'Invalid saved abyss activity passed flag', ErrorCode.GameConfig)
    ensure(uint(stars) && stars <= level.star, 'Invalid saved abyss activity stars', ErrorCode.GameConfig)
    // CBT3 AbbysLevelPassStarCond06028cc5: HasLevelPassed && maxStar>=target.
    // Populate0602a4f7 reads both properties from the sealed AbyssLevelInfo.
    return Number(passed && stars >= target)
}
