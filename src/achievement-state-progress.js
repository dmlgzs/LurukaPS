import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'
import { capturedPetVarieties } from './capture-variety.js'

const uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff

// Current table shapes only. In particular selector 0 means all known caught
// species here; an unobserved future selector must not inherit that meaning.
export function achievementStateRule([kind, ...args]) {
    if (kind === 12046) return args.length === 2 && args[0] === 0 && uint(args[1]) && args[1] > 0
    if (kind === 13104) return args.length === 2 && args.every((value) => uint(value) && value > 0)
    if (kind === 15017) return args.length === 1 && uint(args[0]) && args[0] > 0
    return false
}

export function achievementStateValue(tables, state, tokens, facts) {
    if (!achievementStateRule(tokens)) return null
    const [kind, id] = tokens,
        key = kind === 13104 ? `${kind}:${id}` : String(kind)
    if (facts.has(key)) return facts.get(key)
    let value = 0
    if (kind === 12046) value = capturedPetVarieties(tables, state)
    else if (kind === 13104) {
        const maps = state.exploration?.map_info ?? []
        ensure(Array.isArray(maps), 'Invalid achievement exploration history', ErrorCode.GameConfig)
        const matching = maps.filter((row) => row?.map_id === id)
        ensure(matching.length <= 1, 'Duplicate achievement exploration map', ErrorCode.GameConfig)
        value = matching[0]?.lv ?? 0
    } else if (kind === 15017) value = state.home?.level ?? 0
    ensure(uint(value), 'Invalid achievement state progress', ErrorCode.GameConfig)
    facts.set(key, value)
    return value
}
