import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { petSoulRow } from './pet-star-soul.js'
import policy from '../configs/pet-star-soul-progress-policy.json' with { type: 'json' }

const uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
const record = (value) => value && typeof value === 'object' && !Array.isArray(value)
const targets = new WeakMap()
function trainedTargets(tables) {
    if (!targets.has(tables)) {
        const positions = new Set()
        for (const row of tables.get('pet_starsoul')) {
            ensure(
                [row.templateId, row.group, row.node].every((n) => uint(n) && n > 0),
                'Invalid star-soul condition position',
                ErrorCode.GameConfig,
            )
            if (row.group > 1 || row.node > 1) positions.add(`${row.group}:${row.node}`)
        }
        targets.set(tables, positions)
    }
    return targets.get(tables)
}
function u64(value, allowZero, message) {
    ensure(
        (typeof value === 'string' && /^\d{1,20}$/.test(value)) ||
            (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0),
        message,
        ErrorCode.GameConfig,
    )
    const n = BigInt(value)
    ensure(n >= (allowZero ? 0n : 1n) && n <= 0xffffffffffffffffn, message, ErrorCode.GameConfig)
    return n
}
function permanentId(value) {
    const n = u64(value, false, 'Invalid permanent pet identity')
    return [0n, 2n].includes(n >> 56n) ? n.toString() : null
}
export function petStarSoulProgressRule(tables, tokens) {
    if (!Array.isArray(tokens)) return false
    const [kind, stage, node, count] = tokens
    return (
        kind === 15045 &&
        tokens.length === 4 &&
        [stage, node, count].every((n) => uint(n) && n > 0) &&
        trainedTargets(tables).has(`${stage}:${node}`)
    )
}
function ownedPositions(tables, state) {
    const pets = state.pets ?? []
    ensure(Array.isArray(pets), 'Malformed permanent pet roster', ErrorCode.GameConfig)
    const transient = new Set()
    for (const list of [
        state.trialGroup?.pets,
        state.cultTrial?.pets,
        state.abyssRun?.pets,
        Object.values(state.kiboDuelTrialProfiles ?? {}),
    ]) {
        ensure(list === undefined || Array.isArray(list), 'Malformed temporary pet roster', ErrorCode.GameConfig)
        for (const pet of list ?? []) transient.add(u64(pet.guid, false, 'Invalid temporary pet identity').toString())
    }
    const ids = new Set(),
        result = new Map()
    for (const pet of pets) {
        ensure(record(pet), 'Malformed permanent pet record', ErrorCode.GameConfig)
        if (pet.trial || pet.trail || pet.is_trial || pet.abyss || ![undefined, 0, 1].includes(pet.type)) continue
        const id = permanentId(pet.guid)
        if (id === null || transient.has(id)) continue
        ensure(!ids.has(id), 'Duplicate permanent pet identity', ErrorCode.GameConfig)
        ids.add(id)
        const raw = u64(pet.soul_link_level ?? '0', true, 'Invalid saved star-soul uint64')
        // Missing/zero and explicit1/1 are genuine untrained defaults. They
        // cannot satisfy current targets, including pets without a template.
        if (raw === 0n || raw === 0x100000001n) continue
        const current = petSoulRow(tables, { ...pet, soul_link_level: raw.toString() })
        result.set(id, { configId: current.config.id, level: raw.toString() })
    }
    return result
}
function position(tables, fact) {
    ensure(
        record(fact) && uint(fact.configId) && fact.configId > 0,
        'Invalid star-soul attainment fact',
        ErrorCode.GameConfig,
    )
    const raw = u64(fact.level, false, 'Invalid star-soul attainment uint64')
    ensure(raw !== 0x100000001n, 'Untrained star-soul attainment fact', ErrorCode.GameConfig)
    return petSoulRow(tables, { config_id: fact.configId, soul_link_level: raw.toString() })
}
function ledger(tables, state) {
    ensure(
        policy.version === 1 &&
            policy.counting === 'ever-attained-permanent-instance' &&
            policy.migration === 'current-trained-lower-bound',
        'Invalid star-soul progress policy',
        ErrorCode.GameConfig,
    )
    const current = ownedPositions(tables, state)
    if (state.petStarSoulProgress === undefined) {
        // User-selected local policy. Only surviving, validated trained
        // instances provide a migration lower bound; released history is unknown.
        state.petStarSoulProgress = {
            version: 1,
            migration: policy.migration,
            revision: 0,
            entries: Object.fromEntries(current),
        }
    }
    const saved = state.petStarSoulProgress
    ensure(
        record(saved) &&
            saved.version === 1 &&
            saved.migration === policy.migration &&
            Number.isSafeInteger(saved.revision) &&
            saved.revision >= 0 &&
            record(saved.entries),
        'Malformed star-soul progress ledger',
        ErrorCode.GameConfig,
    )
    for (const [id, fact] of Object.entries(saved.entries)) {
        ensure(permanentId(id) === id, 'Invalid star-soul attainment identity', ErrorCode.GameConfig)
        // Historical configuration validates the earned fact even after a
        // same-UID evolution. Never bind UID species bits to current config_id.
        position(tables, fact)
    }
    return { saved, current }
}
export function initializePetStarSoulProgress(tables, state) {
    ledger(tables, state)
}
export function petStarSoulAllocationFloor(tables, state) {
    // Old accounts may omit the allocator counter even after their last
    // kind2 individual was released. Historical identities remain reserved.
    if (state.petStarSoulProgress === undefined) return 1
    const { saved } = ledger(tables, state)
    let next = 1
    for (const key of Object.keys(saved.entries)) {
        const id = u64(key, false, 'Invalid reserved permanent pet identity')
        if (id >> 56n === 2n) next = Math.max(next, Number(id & 0xffffffffn) + 1)
    }
    return next
}
export function recordPetStarSoulProgress(tables, state, pet) {
    const { saved, current } = ledger(tables, state),
        id = permanentId(pet.guid),
        fact = current.get(id)
    ensure(id !== null && fact, 'Temporary or untrained pet cannot record star-soul progress', ErrorCode.GameConfig)
    const previous = saved.entries[id]
    if (!previous || BigInt(fact.level) > BigInt(previous.level)) {
        saved.entries[id] = fact
        ensure(saved.revision < Number.MAX_SAFE_INTEGER, 'Star-soul progress revision overflow', ErrorCode.GameConfig)
        saved.revision++
    }
}
export function petStarSoulProgressValue(tables, state, tokens, facts = new Map()) {
    if (!petStarSoulProgressRule(tables, tokens)) return null
    const [, stage, node] = tokens,
        key = `pet-soul:${stage}:${node}`
    if (facts.has(key)) return facts.get(key)
    const sourceKey = 'permanent-pet-soul-attainments'
    if (!facts.has(sourceKey))
        facts.set(
            sourceKey,
            Object.values(ledger(tables, state).saved.entries).map((fact) => position(tables, fact)),
        )
    let count = 0
    for (const current of facts.get(sourceKey)) {
        const target = current.rows.findIndex((row) => row.group === stage && row.node === node)
        if (target >= 0 && current.index >= target) count++
    }
    ensure(uint(count), 'Star-soul pet progress overflow', ErrorCode.GameConfig)
    facts.set(key, count)
    return count
}
