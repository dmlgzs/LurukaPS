import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { permanentHeroFavorRecords } from './hero-favor-ownership.js'

// Both current rows12235|2|1 explicitly require equipping one soul on any
// hero. The general meaning of selector2 is not recovered: support only this
// exact visible goal, not other selectors/counts or old task-node evidence.
export function journeySoulWearRule(tokens) {
    return tokens.length === 3 && tokens[0] === 12235 && tokens[1] === 2 && tokens[2] === 1
}

export function journeySoulWearValue(tables, state, tokens) {
    if (!journeySoulWearRule(tokens)) return null
    // This shared roster validates permanent ownership, temporary/foreign
    // identities, duplicate GUIDs/configs and the current hero projection. It
    // does not require favor=1; the main character remains eligible to wear.
    const owned = permanentHeroFavorRecords(tables, state),
        souls = state.player?.soulessence_infos?.soulessences
    ensure(Array.isArray(souls), 'Invalid owned journey soul roster', ErrorCode.GameConfig)
    const byGuid = new Map()
    for (const soul of souls) {
        ensure(
            soul && typeof soul === 'object' && !Array.isArray(soul),
            'Invalid owned journey soul record',
            ErrorCode.GameConfig,
        )
        if (soul.trail || soul.trial || soul.is_trial || soul.abyss) continue
        const guid = Number(soul.guid)
        ensure(
            Number.isSafeInteger(guid) && guid > 0 && guid <= 0xffffffff && !byGuid.has(guid),
            'Duplicate or invalid owned journey soul identity',
            ErrorCode.GameConfig,
        )
        byGuid.set(guid, soul)
    }
    let worn = false
    for (const { actor, id } of owned) {
        const guid = Number(actor.wguid ?? 0)
        ensure(
            Number.isSafeInteger(guid) && guid >= 0 && guid <= 0xffffffff,
            'Invalid journey soul binding identity',
            ErrorCode.GameConfig,
        )
        if (!guid) continue
        const soul = byGuid.get(guid)
        if (!soul || String(soul.wear_hero) !== id) continue
        ensure(tables.find('soulessence', soul.id), 'Worn journey soul configuration unavailable', ErrorCode.GameConfig)
        worn = true
    }
    return Number(worn)
}
