import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import policy from '../configs/hero-favor-ownership-policy.json' with { type: 'json' }

const uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
const catalogues = new WeakMap()
function identity(value) {
    ensure(
        (typeof value === 'string' && /^\d{1,20}$/.test(value)) ||
            (typeof value === 'number' && Number.isSafeInteger(value) && value > 0),
        'Invalid owned hero favorability identity',
        ErrorCode.GameConfig,
    )
    const result = BigInt(value)
    ensure(
        result > 0n && result <= 0xffffffffffffffffn,
        'Hero favorability identity outside uint64',
        ErrorCode.GameConfig,
    )
    return result
}
function catalogue(tables) {
    ensure(
        policy.version === 1 &&
            policy.normalGuidType === 1 &&
            policy.ownerBits === 32 &&
            policy.legacyOwnedSmallIdMaximum === 0xffffffff &&
            policy.legacyCompatibilityOfficiallyVerified === false,
        'Invalid hero favorability ownership policy',
        ErrorCode.GameConfig,
    )
    if (!catalogues.has(tables)) {
        const rows = new Map()
        for (const row of tables.get('hero')) {
            ensure(
                row && uint(row.id) && row.id > 0 && !rows.has(row.id) && [0, 1].includes(row.favor),
                'Invalid hero favorability qualification catalogue',
                ErrorCode.GameConfig,
            )
            rows.set(row.id, row)
        }
        ensure(rows.size > 0, 'Hero favorability qualification catalogue is missing', ErrorCode.HeroFavorConfNone)
        catalogues.set(tables, rows)
    }
    return catalogues.get(tables)
}

export function permanentHeroFavorRecords(tables, state) {
    const rows = catalogue(tables)
    const owned = state.player?.heros_info?.heros,
        owner = state.player?.basic_info?.id
    ensure(
        Array.isArray(owned) && uint(owner) && owner > 0,
        'Invalid owned hero favorability roster',
        ErrorCode.GameConfig,
    )
    const temporary = new Set()
    for (const list of [
        state.trialGroup?.heroes,
        state.cultTrial?.heroes,
        state.abyssRun?.heroes,
        state.npcArenaTrialTrainer?.hero === undefined ? undefined : [state.npcArenaTrialTrainer.hero],
    ]) {
        ensure(
            list === undefined || Array.isArray(list),
            'Invalid temporary hero favorability roster',
            ErrorCode.GameConfig,
        )
        for (const hero of list ?? []) {
            ensure(object(hero), 'Malformed temporary hero favorability record', ErrorCode.GameConfig)
            temporary.add(identity(hero.guid).toString())
        }
    }
    const ids = new Set(),
        configs = new Set(),
        result = []
    for (const actor of owned) {
        ensure(object(actor), 'Malformed owned hero favorability record', ErrorCode.GameConfig)
        ensure(
            actor.trail === undefined || typeof actor.trail === 'boolean',
            'Invalid hero favorability trial flag',
            ErrorCode.GameConfig,
        )
        if (actor.trail || actor.trial || actor.is_trial || actor.abyss) continue
        const guid = identity(actor.guid),
            id = guid.toString(),
            kind = guid >> 56n
        if (temporary.has(id)) continue
        // The normal map is proven by HeroStore.CheckHeroData/GetNormalHero.
        // Legacy nonzero UInt32 IDs are narrowly retained local compatibility.
        const normal = kind === 1n && (guid & 0xffffffffn) === BigInt(owner)
        const legacy = guid <= BigInt(policy.legacyOwnedSmallIdMaximum)
        if (!normal && !legacy) continue
        ensure(
            uint(actor.conf_id) && actor.conf_id > 0 && !ids.has(id) && !configs.has(actor.conf_id),
            'Duplicate or invalid permanent hero favorability identity',
            ErrorCode.GameConfig,
        )
        ids.add(id)
        configs.add(actor.conf_id)
        const config = rows.get(actor.conf_id)
        ensure(config, 'Hero favorability qualification is unavailable', ErrorCode.HeroFavorConfNone)
        result.push({ actor, config, id })
    }
    return result
}

export function heroGiftRecipient(tables, state, configId) {
    ensure(uint(configId) && configId > 0, 'Invalid hero gift recipient', ErrorCode.HeroGiftArgs)
    const record = permanentHeroFavorRecords(tables, state).find((entry) => entry.actor.conf_id === configId)
    ensure(record, 'Gift recipient is not permanently owned', ErrorCode.HeroNotExist)
    ensure(record.config.favor === 1, 'Hero favorability is not unlocked', ErrorCode.HeroFavorExpLocked)
    return record.actor
}
