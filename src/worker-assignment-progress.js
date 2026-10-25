import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'
import policy from '../configs/worker-assignment-progress-policy.json' with { type: 'json' }
const uint = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff,
    positive = (n) => uint(n) && n > 0,
    record = (v) => v && typeof v === 'object' && !Array.isArray(v),
    catalogues = new WeakMap(),
    warnings = new WeakMap()
function u64(value, allowZero = false) {
    ensure(
        (typeof value === 'string' && /^\d{1,20}$/.test(value)) ||
            (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0),
        'Invalid worker pet identity',
        ErrorCode.GameConfig,
    )
    const id = BigInt(value)
    ensure(
        id >= (allowZero ? 0n : 1n) && id <= 0xffffffffffffffffn,
        'Worker pet identity outside uint64',
        ErrorCode.GameConfig,
    )
    return id
}
function catalogue(tables) {
    if (catalogues.has(tables)) return catalogues.get(tables)
    ensure(
        policy.version === 1 &&
            policy.officiallyVerified === false &&
            policy.membership === 'current-home-hub-stationPets-owned-permanent' &&
            policy.counting === 'distinct-current-permanent-pet-per-positive-labor-capability' &&
            JSON.stringify(policy.homeStatuses) === '[1,2,5,6,7]',
        'Invalid worker assignment policy',
        ErrorCode.GameConfig,
    )
    const rows = tables.get('home_labor_type'),
        jobs = new Set()
    for (const row of rows) {
        ensure(positive(row.id) && !jobs.has(row.id), 'Invalid worker labor type configuration', ErrorCode.GameConfig)
        jobs.add(row.id)
    }
    ensure(jobs.size > 0, 'Worker labor type configuration is empty', ErrorCode.GameConfig)
    catalogues.set(tables, jobs)
    return jobs
}
function diagnostic(tables, state, id, reason) {
    if (!warnings.has(tables)) warnings.set(tables, new Set())
    const key = [state.player?.basic_info?.id, state.player?.basic_info?.account, id, reason].join(':')
    if (warnings.get(tables).has(key)) return
    warnings.get(tables).add(key)
    console.warn(
        '[worker-assignment-progress]',
        JSON.stringify({
            accountId: state.player?.basic_info?.id ?? null,
            petGuid: id,
            reason,
            action: 'unproven-member-not-counted',
        }),
    )
}
export function workerAssignmentProgressRule(tables, tokens) {
    return (
        Array.isArray(tokens) &&
        tokens.length === 3 &&
        tokens[0] === 12247 &&
        positive(tokens[1]) &&
        positive(tokens[2]) &&
        catalogue(tables).has(tokens[1])
    )
}
function counts(tables, state) {
    const jobs = catalogue(tables),
        pets = state.pets ?? [],
        members = state.home?.stationPets ?? [],
        temporary = new Set(),
        owned = new Map(),
        result = new Map([...jobs].map((id) => [id, 0]))
    ensure(Array.isArray(pets) && Array.isArray(members), 'Malformed worker assignment roster', ErrorCode.GameConfig)
    const stationed = new Set(members.map((id) => u64(id, true).toString()))
    if (!stationed.size) return result
    for (const list of [
        state.trialGroup?.pets,
        state.cultTrial?.pets,
        state.abyssRun?.pets,
        Object.values(state.kiboDuelTrialProfiles ?? {}),
    ]) {
        ensure(list === undefined || Array.isArray(list), 'Malformed temporary worker roster', ErrorCode.GameConfig)
        for (const pet of list ?? []) temporary.add(u64(pet.guid).toString())
    }
    for (const pet of pets) {
        if (!record(pet)) continue
        if (pet.trial || pet.trail || pet.is_trial || pet.abyss || ![undefined, 0, 1].includes(pet.type)) continue
        // This is a membership predicate,not a new global pet-roster repair.
        // Only a canonical candidate for a current member needs UID validation.
        const text = String(pet.guid)
        if (!/^\d{1,20}$/.test(text)) continue
        const candidate = BigInt(text)
        if (candidate === 0n || !stationed.has(candidate.toString())) continue
        const id = u64(pet.guid),
            kind = id >> 56n
        if (![0n, 2n].includes(kind) || temporary.has(id.toString())) continue
        const key = id.toString()
        ensure(!owned.has(key), 'Duplicate permanent worker pet identity', ErrorCode.GameConfig)
        owned.set(key, pet)
    }
    for (const id of stationed) {
        const pet = owned.get(id)
        if (!pet) {
            diagnostic(tables, state, id, 'unowned-or-temporary-member')
            continue
        }
        const status = pet.work_status === undefined ? 0 : pet.work_status
        ensure(uint(status), 'Invalid saved worker status', ErrorCode.GameConfig)
        if (!policy.homeStatuses.includes(status)) {
            diagnostic(tables, state, id, 'non-home-or-stale-member')
            continue
        }
        ensure(positive(pet.config_id), 'Malformed permanent worker configuration identity', ErrorCode.GameConfig)
        ensure(
            tables.find('pet', pet.config_id),
            'Permanent worker pet configuration missing',
            ErrorCode.PetConfNotExist,
        )
        const labor = pet.labor_infos === undefined ? [] : pet.labor_infos,
            abilities = new Set()
        ensure(Array.isArray(labor), 'Malformed worker labor capabilities', ErrorCode.GameConfig)
        for (const info of labor) {
            ensure(record(info), 'Malformed worker labor record', ErrorCode.GameConfig)
            const job = info.labor_id === undefined ? 0 : info.labor_id,
                grade = info.labor_grade === undefined ? 0 : info.labor_grade
            ensure(uint(job) && uint(grade), 'Invalid worker labor capability', ErrorCode.GameConfig)
            if (jobs.has(job) && grade > 0) abilities.add(job)
        }
        for (const job of abilities) result.set(job, result.get(job) + 1)
    }
    return result
}
export function workerAssignmentProgressValue(tables, state, tokens, facts = new Map()) {
    if (!workerAssignmentProgressRule(tables, tokens)) return null
    const key = 'current-home-worker-capabilities'
    if (!facts.has(key)) facts.set(key, counts(tables, state))
    return Math.min(tokens[2], facts.get(key).get(tokens[1]) ?? 0)
}
