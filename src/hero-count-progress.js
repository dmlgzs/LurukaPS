import policy from '../configs/hero-count-policy.json' with { type: 'json' }
import { permanentHeroFavorRecords } from './hero-favor-ownership.js'
import { mainHeroConfigId } from './main-hero.js'
import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'

const uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
const catalogues = new WeakMap()
ensure(
    policy.version === 1 &&
        policy.condition === 12036 &&
        policy.zeroSelector === 'current-usable-permanently-owned-hero-configurations' &&
        policy.avatarPolicy === 'merge-owned-male-and-female-variants-as-one' &&
        policy.avatarIdsFrom === 'game:AVATAR_HERO_ID_MALE+AVATAR_HERO_ID_FEMALE' &&
        policy.ownership === 'existing-normal-guid-owner-guard-with-declared-legacy-small-id-compatibility' &&
        policy.officiallyVerified === false &&
        policy.userSelectedAvatarPolicy === '2026-10-26' &&
        policy.source === 'current-roster-property-not-acquisition-request-count' &&
        policy.unfinishedProgress === 'recompute-from-qualified-current-roster' &&
        policy.validTerminalReceipts === 'preserve-without-roster-or-history-backfill',
    'Invalid owned hero count policy',
    ErrorCode.GameConfig,
)

function catalogue(tables) {
    if (!catalogues.has(tables)) {
        const all = new Map(),
            usable = new Set()
        for (const row of tables.get('hero')) {
            ensure(
                row && uint(row.id) && row.id > 0 && !all.has(row.id) && [0, 1].includes(row.isUsable),
                'Invalid owned hero count catalogue',
                ErrorCode.GameConfig,
            )
            all.set(row.id, row)
            // The actual permanent hero reward producer enforces isUsable=1.
            if (row.isUsable === 1) usable.add(row.id)
        }
        let avatars
        try {
            avatars = new Set([mainHeroConfigId(tables, 1), mainHeroConfigId(tables, 2)])
        } catch {
            ensure(false, 'Owned hero count avatar configuration unavailable', ErrorCode.GameConfig)
        }
        ensure(
            avatars.size === 2 && [...avatars].every((id) => usable.has(id)),
            'Owned hero count avatar configuration unavailable',
            ErrorCode.GameConfig,
        )
        catalogues.set(tables, { usable, avatars })
    }
    return catalogues.get(tables)
}

export function heroCountProgressRule(tables, tokens) {
    if (!Array.isArray(tokens)) return false
    const [kind, selector, target] = tokens
    if (!(kind === 12036 && tokens.length === 3 && selector === 0 && uint(target) && target > 0)) return false
    catalogue(tables)
    return true
}

export function heroCountProgressValue(tables, state, tokens, facts = new Map()) {
    if (!heroCountProgressRule(tables, tokens)) return null
    const key = 'owned-hero-count:0'
    if (facts.has(key)) return facts.get(key)
    const data = catalogue(tables)
    let records
    try {
        // This existing helper returns permanent identities and configurations;
        // it does NOT filter by favor eligibility. Protagonists remain present.
        records = permanentHeroFavorRecords(tables, state)
    } catch (error) {
        if (error.code === ErrorCode.HeroFavorConfNone)
            ensure(false, 'Owned hero count configuration unavailable', ErrorCode.GameConfig)
        throw error
    }
    let count = 0,
        avatarOwned = false
    for (const { actor } of records) {
        if (!data.usable.has(actor.conf_id)) continue
        if (data.avatars.has(actor.conf_id)) avatarOwned = true
        else count++
    }
    if (avatarOwned) count++
    ensure(uint(count), 'Owned hero count overflow', ErrorCode.GameConfig)
    facts.set(key, count)
    return count
}
