import policy from '../configs/field-reclamation-policy.json' with { type: 'json' }
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
const positive = (value) => uint(value) && value > 0
const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
ensure(
    policy.version === 1 &&
        policy.condition === 12031 &&
        policy.officiallyVerified === false &&
        policy.unit === 'accepted-new-server-field-build-guid' &&
        policy.zeroSelector === 'all-recorded-field-types' &&
        policy.existingInstanceRetry === 'no-new-count' &&
        policy.close === 'preserve-cumulative-count' &&
        policy.reopen === 'count-accepted-new-guid-even-at-a-previous-location' &&
        policy.legacyBackfill === false,
    'Invalid field reclamation policy',
    ErrorCode.GameConfig,
)

function ledger(state) {
    const saved = state.home?.reclamationProgress
    if (saved === undefined) return { value: { version: 1, countsByType: {}, lastGuid: 0, lastFieldType: 0 }, total: 0 }
    ensure(object(saved) && positive(saved.version), 'Malformed reclamation source version', ErrorCode.GameConfig)
    ensure(saved.version === 1, 'Reclamation source version is not implemented', ErrorCode.FunctionClosed)
    ensure(
        object(saved.countsByType) && uint(saved.lastGuid) && uint(saved.lastFieldType),
        'Malformed reclamation source',
        ErrorCode.GameConfig,
    )
    let total = 0
    for (const [key, count] of Object.entries(saved.countsByType)) {
        const type = Number(key)
        ensure(
            positive(type) && String(type) === key && uint(count),
            'Malformed reclamation type count',
            ErrorCode.GameConfig,
        )
        total += count
        ensure(uint(total), 'Reclamation source count overflow', ErrorCode.GameConfig)
    }
    ensure(
        (total === 0 && saved.lastGuid === 0 && saved.lastFieldType === 0) ||
            (total > 0 &&
                total <= saved.lastGuid &&
                positive(saved.lastGuid) &&
                positive(saved.lastFieldType) &&
                saved.countsByType[saved.lastFieldType] > 0),
        'Reclamation source receipt is inconsistent',
        ErrorCode.GameConfig,
    )
    return { value: saved, total }
}

export function recordFieldReclamation(tables, state, build) {
    const map = Number(tables.get('game').find((row) => row.title === 'HOME_ID')?.value)
    ensure(positive(map), 'Reclamation home configuration unavailable', ErrorCode.GameConfig)
    ensure(state.world?.map_id === map, 'Reclamation source requires the home scene', ErrorCode.PlayerNotInHome)
    const home = state.home,
        type = build?.crop_info?.field_type
    const config = positive(type) && tables.find('home_fieldtype', type)
    ensure(
        object(home) &&
            Array.isArray(home.builds) &&
            object(build) &&
            config &&
            build.build_id === config.homeBuildingId &&
            build.status === 1 &&
            positive(build.guid) &&
            home.builds.includes(build) &&
            home.builds.filter((row) => row.guid === build.guid).length === 1 &&
            Number.isSafeInteger(home.nextBuildGuid) &&
            home.nextBuildGuid > build.guid &&
            home.nextBuildGuid <= 0x100000000,
        'Reclamation source is not an accepted field creation',
        ErrorCode.GameConfig,
    )
    const current = ledger(state)
    if (build.guid === current.value.lastGuid) {
        ensure(current.value.lastFieldType === type, 'Reclamation source identity changed type', ErrorCode.GameConfig)
        return false
    }
    ensure(build.guid > current.value.lastGuid, 'Reclamation source GUID moved backwards', ErrorCode.GameConfig)
    ensure(uint(current.total + 1), 'Reclamation total overflow', ErrorCode.GameConfig)
    home.reclamationProgress = {
        version: 1,
        countsByType: { ...current.value.countsByType, [type]: (current.value.countsByType[type] ?? 0) + 1 },
        lastGuid: build.guid,
        lastFieldType: type,
    }
    return true
}

export function fieldReclamationRule(tokens) {
    if (!Array.isArray(tokens)) return false
    const [kind, selector, target] = tokens
    return kind === 12031 && tokens.length === 3 && selector === 0 && positive(target)
}

export function fieldReclamationValue(state, tokens, facts = new Map()) {
    if (!fieldReclamationRule(tokens)) return null
    const key = 'field-reclamation:0'
    if (facts.has(key)) return facts.get(key)
    const value = ledger(state).total
    facts.set(key, value)
    return value
}
