import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { productionTables } from './production-tables.js'
import { productionSeconds } from './production-time.js'
import { planProductionFeeding, applyProductionFeeding } from './production-work-food.js'
import {
    workFraction as F,
    workAdd as add,
    workSub as sub,
    workMul as mul,
    workDiv as div,
    workCompare as cmp,
    workFloor as floor,
    workCeil as ceil,
    workSerialize as serial,
    workNumber as number,
} from './production-work-fractions.js'

const uint = (v) => Number.isSafeInteger(v) && v >= 0 && v <= 0xffffffff
const positive = (v) => uint(v) && v > 0
const object = (v) => v && typeof v === 'object' && !Array.isArray(v)
const zero = () => serial(0)
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const min = (a, b) => (cmp(a, b) < 0 ? F(a) : F(b))
const kind = (job) => job.kind ?? 'ordinary'
const decimal = (id) => {
    const value = String(id)
    ensure(/^[1-9][0-9]*$/.test(value), 'Invalid production work identity', ErrorCode.GameConfig)
    return BigInt(value)
}
function enabled(policy) {
    if (!policy) return false
    ensure(
        policy.schemaVersion === 1 &&
            typeof policy.policyId === 'string' &&
            policy.policyId.length > 0 &&
            positive(policy.unitBudgetMultiplier) &&
            Array.isArray(policy.scope) &&
            new Set(policy.scope).size === policy.scope.length &&
            policy.scope.every((value) => typeof value === 'string' && value.length > 0),
        'Invalid injected production work policy',
        ErrorCode.GameConfig,
    )
    ensure(
        policy.scope.every((value) => ['ordinary', 'cook', 'accessory'].includes(value)),
        'Production work scope is not implemented',
        ErrorCode.FunctionClosed,
    )
    const supported = {
        feeBasis: 'actual-assisted-progress',
        eligibility: 'full-unit-budget-at-new-unit-or-new-worker',
        refillTarget: 'unit-eligibility-budget',
        recoveryCap: 'pet-home-profile',
        foodSelection: 'largest-fitting-cap-headroom-else-smallest',
        overflow: 'whole-food-explicit-waste',
        insufficientFood: 'pause-without-partial-food-consumption',
        history: 'adopt-current-progress-no-backcharge',
    }
    for (const [key, value] of Object.entries(supported)) {
        ensure(
            typeof policy[key] === 'string' && policy[key].length > 0,
            'Malformed production work policy ' + key,
            ErrorCode.GameConfig,
        )
        ensure(
            policy[key] === value,
            'Production work policy variant is not implemented: ' + key,
            ErrorCode.FunctionClosed,
        )
    }
    ensure(
        uint(policy.feedingDurationSeconds) &&
            typeof policy.newFoodRetroactive === 'boolean' &&
            Array.isArray(policy.foodTieBreak) &&
            policy.foodTieBreak.length > 0 &&
            policy.foodTieBreak.every((value) => typeof value === 'string' && value.length > 0),
        'Malformed production feeding policy',
        ErrorCode.GameConfig,
    )
    ensure(
        policy.feedingDurationSeconds === 0 &&
            policy.newFoodRetroactive === false &&
            equal(policy.foodTieBreak, ['canteen-guid', 'item-id']),
        'Production feeding policy variant is not implemented',
        ErrorCode.FunctionClosed,
    )
    return true
}

export function validateProductionWorkPolicy(policy) {
    return enabled(policy)
}
function time(now) {
    ensure(uint(now), 'Invalid production work clock', ErrorCode.GameConfig)
    return F(now)
}
function managed(job, policy) {
    return policy.scope.includes(kind(job))
}
function recipeOf(tables, job) {
    const row = tables.find(kind(job) === 'accessory' ? 'accessory_product' : 'products', job.productId)
    return row && (kind(job) === 'accessory' ? { ...row, time: row.time * 60 } : row)
}
function copyScope(state) {
    return {
        ...state,
        home: {
            ...state.home,
            builds: state.home.builds.map((build) => ({ ...build })),
            productionJobs: Object.fromEntries(
                Object.entries(state.home.productionJobs ?? {}).map(([id, jobs]) => [
                    id,
                    jobs.map((job) => ({ ...job })),
                ]),
            ),
            productionWork: state.home.productionWork ? structuredClone(state.home.productionWork) : undefined,
        },
        pets: (state.pets ?? []).map((pet) => ({ ...pet })),
    }
}
function newLedger(now, policy) {
    return {
        version: 1,
        policyVersion: policy.policyId,
        adoptedAt: now,
        settledAt: serial(now),
        nextEpoch: 1,
        jobs: {},
        pets: {},
        stats: { spent: zero(), recovery: zero(), waste: zero() },
        nextAt: null,
    }
}
function nonnegative(value, message) {
    const fraction = F(value)
    ensure(cmp(fraction, 0) >= 0, message, ErrorCode.GameConfig)
    return fraction
}
function validateLedger(ledger) {
    ensure(
        object(ledger) &&
            ledger.version === 1 &&
            object(ledger.jobs) &&
            object(ledger.pets) &&
            object(ledger.stats) &&
            Number.isSafeInteger(ledger.nextEpoch) &&
            ledger.nextEpoch > 0 &&
            (ledger.nextAt === null || uint(ledger.nextAt)),
        'Invalid production work ledger',
        ErrorCode.GameConfig,
    )
    nonnegative(ledger.settledAt, 'Negative production work cursor')
    for (const field of ['spent', 'recovery', 'waste'])
        nonnegative(ledger.stats[field], 'Invalid production work totals')
}
function initialProgress(job, now) {
    ensure(uint(job.start) && positive(job.seconds), 'Invalid legacy production clock', ErrorCode.GameConfig)
    return min(job.count, cmp(now, job.start) <= 0 ? F(0) : div(sub(now, job.start), job.seconds))
}
function rowsOf(state, ledger) {
    const rows = []
    for (const build of state.home.builds) {
        decimal(build.guid)
        const jobs = state.home.productionJobs?.[build.guid] ?? []
        ensure(Array.isArray(jobs), 'Invalid production work queue', ErrorCode.GameConfig)
        for (const job of jobs) {
            const entry = job.workEpoch === undefined ? null : ledger.jobs[job.workEpoch]
            rows.push({ build, job, entry })
        }
    }
    return rows
}
function adopt(tables, state, now, policy) {
    const first = !state.home.productionWork
    const ledger = (state.home.productionWork ??= newLedger(number(now), policy))
    validateLedger(ledger)
    const seen = new Set(),
        live = new Set()
    for (const build of state.home.builds) {
        const jobs = state.home.productionJobs?.[build.guid] ?? []
        ensure(Array.isArray(jobs), 'Invalid production work queue', ErrorCode.GameConfig)
        for (const job of jobs) {
            if (!managed(job, policy) && job.workEpoch === undefined) continue
            ensure(
                positive(job.guid) &&
                    positive(job.productId) &&
                    positive(job.count) &&
                    uint(job.claimed ?? 0) &&
                    (job.claimed ?? 0) <= job.count,
                'Invalid production work job',
                ErrorCode.GameConfig,
            )
            let entry
            if (job.workEpoch === undefined) {
                ensure(
                    ledger.nextEpoch < Number.MAX_SAFE_INTEGER,
                    'Production work epoch exhausted',
                    ErrorCode.GameConfig,
                )
                const recipe = recipeOf(tables, job)
                const budget = recipe ? recipe.satietyScore * policy.unitBudgetMultiplier : null
                ensure(first || recipe, 'New production recipe is missing', ErrorCode.HomeNoProductConf)
                ensure(budget === null || positive(budget), 'Invalid production work budget', ErrorCode.GameConfig)
                const progress = first ? initialProgress(job, now) : F(0)
                ensure(
                    cmp(progress, job.claimed ?? 0) >= 0,
                    'Legacy claimed work exceeds completed work',
                    ErrorCode.GameConfig,
                )
                job.workEpoch = ledger.nextEpoch++
                entry = ledger.jobs[job.workEpoch] = {
                    epoch: job.workEpoch,
                    buildGuid: String(build.guid),
                    productGuid: job.guid,
                    kind: kind(job),
                    productId: job.productId,
                    count: job.count,
                    budget,
                    policyVersion: policy.policyId,
                    progress: serial(progress),
                    worker: '0',
                    seconds: job.seconds,
                    paused: false,
                    pauseReason: null,
                    admittedUnit: null,
                    admittedPet: '0',
                    lastAt: serial(now),
                    completedAt:
                        cmp(progress, job.count) === 0 ? serial(add(job.start, mul(job.count, job.seconds))) : null,
                    legacyUnpriced: !recipe,
                }
            } else {
                ensure(
                    Number.isSafeInteger(job.workEpoch) && job.workEpoch > 0 && job.workEpoch < ledger.nextEpoch,
                    'Invalid production work epoch',
                    ErrorCode.GameConfig,
                )
                entry = ledger.jobs[job.workEpoch]
                ensure(
                    entry &&
                        entry.epoch === job.workEpoch &&
                        entry.buildGuid === String(build.guid) &&
                        entry.productGuid === job.guid &&
                        entry.kind === kind(job) &&
                        entry.productId === job.productId &&
                        entry.count === job.count,
                    'Production work identity changed',
                    ErrorCode.GameConfig,
                )
                const progress = nonnegative(entry.progress, 'Invalid production work progress')
                ensure(
                    cmp(progress, job.count) <= 0 &&
                        cmp(progress, job.claimed ?? 0) >= 0 &&
                        (entry.budget === null || positive(entry.budget)) &&
                        positive(entry.seconds),
                    'Invalid saved production work progress',
                    ErrorCode.GameConfig,
                )
            }
            ensure(!seen.has(job.workEpoch), 'Duplicate production work epoch', ErrorCode.GameConfig)
            seen.add(job.workEpoch)
            live.add(String(job.workEpoch))
            job.workCompleted = number(F(floor(entry.progress)))
        }
    }
    for (const epoch of Object.keys(ledger.jobs)) if (!live.has(epoch)) delete ledger.jobs[epoch]
    ledger.policyVersion = policy.policyId
    return { ledger, first }
}
function petRecord(state, ledger, pet) {
    ensure(uint(pet.satiety_val), 'Invalid production worker satiety', ErrorCode.GameConfig)
    let record = ledger.pets[pet.guid]
    if (!record)
        record = ledger.pets[pet.guid] = {
            balance: serial(pet.satiety_val),
            lastWire: pet.satiety_val,
            pauseOwned: false,
        }
    const balance = nonnegative(record.balance, 'Invalid production worker balance')
    ensure(
        cmp(balance, 0xffffffff) <= 0 && uint(record.lastWire) && typeof record.pauseOwned === 'boolean',
        'Invalid saved worker balance',
        ErrorCode.GameConfig,
    )
    if (pet.satiety_val !== record.lastWire) {
        // A real external integer restoration/debit is an event cut. Keep its
        // explicit integer value; never reconstruct fractions from a wire floor.
        record.balance = serial(pet.satiety_val)
        record.lastWire = pet.satiety_val
        for (const entry of Object.values(ledger.jobs)) if (entry.worker === pet.guid) entry.admittedUnit = null
    }
    return record
}
function secondsFor(tables, state, build, job, balance, fallback) {
    const recipe = recipeOf(tables, job)
    if (!recipe) return fallback
    const threshold = Number(tables.get('game').find((row) => row.title === 'PET_HOME_TIRED_SATIETY')?.value)
    ensure(uint(threshold), 'Production tired threshold is missing', ErrorCode.GameConfig)
    const shadow =
        balance === null
            ? state
            : {
                  ...state,
                  pets: state.pets.map((pet) =>
                      pet.guid === String(build.station_pet_guid)
                          ? { ...pet, satiety_val: cmp(balance, threshold) > 0 ? threshold + 1 : threshold }
                          : pet,
                  ),
              }
    return productionSeconds(tables, shadow, build, recipe)
}
function activeRows(state, ledger, at) {
    const result = []
    for (const build of state.home.builds) {
        for (const job of state.home.productionJobs?.[build.guid] ?? []) {
            const entry = job.workEpoch === undefined ? null : ledger.jobs[job.workEpoch]
            if (entry) {
                if (cmp(entry.progress, job.count) === 0) continue
                result.push({ build, job, entry })
                break
            }
            // Excluded work retains its existing lifecycle and blocks a mixed
            // queue until its old completion time; it is never charged here.
            ensure(
                uint(job.start) && positive(job.count) && positive(job.seconds),
                'Invalid excluded production job',
                ErrorCode.GameConfig,
            )
            const end = add(job.start, mul(job.count, job.seconds))
            if (cmp(end, at) > 0) {
                result.push({ build, job, blockedUntil: end })
                break
            }
        }
    }
    return result.sort((a, b) => {
        const compare = (x, y) => (x < y ? -1 : x > y ? 1 : 0)
        return (
            compare(decimal(a.build.guid), decimal(b.build.guid)) ||
            compare(BigInt(a.build.station_pet_guid || '0'), BigInt(b.build.station_pet_guid || '0')) ||
            (a.entry?.epoch ?? 0) - (b.entry?.epoch ?? 0)
        )
    })
}
function prepare(tables, state, ledger, rows, at) {
    const occupied = new Set()
    for (const row of rows) {
        if (!row.entry) continue
        const { build, job, entry } = row
        const id = String(build.station_pet_guid || '0')
        if (entry.worker !== id) {
            entry.worker = id
            entry.admittedUnit = null
            entry.admittedPet = '0'
        }
        entry.paused = false
        entry.pauseReason = null
        if (id === '0' || entry.budget === null) {
            entry.seconds = secondsFor(tables, state, build, job, null, entry.seconds)
            const legacyPet = id === '0' ? null : state.pets.find((pet) => pet.guid === id)
            if (legacyPet?.canteen_id || legacyPet?.work_pause) {
                entry.paused = true
                entry.pauseReason = 'foreign-pause'
            }
            continue
        }
        decimal(id)
        ensure(!occupied.has(id), 'Worker is assigned to multiple production buildings', ErrorCode.GameConfig)
        occupied.add(id)
        const pet = state.pets.find((pet) => pet.guid === id)
        ensure(
            pet && [1, 2].includes(pet.work_status) && pet.work_build === build.guid,
            'Production worker binding is inconsistent',
            ErrorCode.GameConfig,
        )
        const record = petRecord(state, ledger, pet)
        row.pet = pet
        row.record = record
        const profile = tables.find('pet_home_talent', pet.config_id),
            cap = profile?.satietyScore
        ensure(
            positive(cap) && entry.budget <= cap,
            'Production budget exceeds the worker recovery capacity',
            ErrorCode.GameConfig,
        )
        if (pet.canteen_id || (pet.work_pause && !record.pauseOwned)) {
            entry.paused = true
            entry.pauseReason = 'foreign-pause'
            continue
        }
        const unit = number(F(floor(entry.progress)))
        if (entry.admittedUnit !== unit || entry.admittedPet !== id) {
            if (cmp(record.balance, entry.budget) < 0) {
                const plan = planProductionFeeding(tables, state, {
                    balance: F(record.balance),
                    budget: entry.budget,
                    cap,
                })
                if (!plan.satisfied) {
                    entry.paused = true
                    entry.pauseReason = 'food'
                    pet.work_pause = true
                    record.pauseOwned = true
                    continue
                }
                applyProductionFeeding(state, plan)
                record.balance = serial(plan.balance)
                ledger.stats.recovery = serial(add(ledger.stats.recovery, plan.recovery))
                ledger.stats.waste = serial(add(ledger.stats.waste, plan.waste))
                pet.canteen_id = 0
            }
            entry.admittedUnit = unit
            entry.admittedPet = id
            pet.work_start_time = number(F(ceil(at)))
        }
        if (record.pauseOwned) {
            pet.work_pause = false
            record.pauseOwned = false
        }
        entry.seconds = secondsFor(tables, state, build, job, record.balance, entry.seconds)
    }
    return rows
}
function horizon(tables, row, at) {
    if (row.blockedUntil) return sub(row.blockedUntil, at)
    const { entry, job, record } = row
    if (entry.paused) return null
    let quantity = sub(job.count, entry.progress)
    if (record) {
        const remainder = sub(entry.progress, F(floor(entry.progress)))
        const current = sub(1, remainder)
        const afterCurrent = sub(record.balance, mul(current, entry.budget))
        ensure(cmp(afterCurrent, 0) >= 0, 'An admitted production unit has insufficient balance', ErrorCode.GameConfig)
        quantity = min(quantity, add(current, F(floor(div(afterCurrent, entry.budget)))))
        const threshold = Number(tables.get('game').find((item) => item.title === 'PET_HOME_TIRED_SATIETY').value)
        if (cmp(record.balance, threshold) > 0)
            quantity = min(quantity, div(sub(record.balance, threshold), entry.budget))
    }
    return mul(quantity, entry.seconds)
}
function advance(ledger, rows, duration, to) {
    for (const { entry, job, record } of rows) {
        if (!entry || entry.paused) continue
        const quantity = div(duration, entry.seconds),
            next = add(entry.progress, quantity)
        ensure(cmp(next, job.count) <= 0, 'Production work advanced beyond its job', ErrorCode.GameConfig)
        entry.progress = serial(next)
        entry.lastAt = serial(to)
        if (record) {
            const fee = mul(quantity, entry.budget)
            record.balance = serial(nonnegative(sub(record.balance, fee), 'Production balance became negative'))
            ledger.stats.spent = serial(add(ledger.stats.spent, fee))
            entry.admittedUnit = cmp(next, floor(next)) === 0 ? null : number(F(floor(next)))
        }
        if (cmp(next, job.count) === 0 && !entry.completedAt) entry.completedAt = serial(to)
    }
}
function stamp(value) {
    const result = number(F(ceil(value)))
    ensure(uint(result), 'Production work wire timestamp overflows', ErrorCode.GameConfig)
    return result
}
function project(state, ledger, at) {
    const active = new Map(
        activeRows(state, ledger, at)
            .filter((row) => row.entry)
            .map((row) => [String(row.build.guid), row.entry.epoch]),
    )
    for (const build of state.home.builds) {
        let queuedAt = F(at),
            unknown = false
        for (const job of state.home.productionJobs?.[build.guid] ?? []) {
            const entry = ledger.jobs[job.workEpoch]
            if (!entry) {
                queuedAt = add(job.start, mul(job.count, job.seconds))
                continue
            }
            job.workCompleted = number(F(floor(entry.progress)))
            job.workPaused = !!entry.paused
            if (cmp(entry.progress, job.count) === 0) {
                const end = stamp(entry.completedAt ?? at)
                job.workProjection = { start_time: end, finish_time: end, total_finish_time: end }
                continue
            }
            const isActive = active.get(String(build.guid)) === entry.epoch
            const remainder = sub(entry.progress, F(floor(entry.progress)))
            const start = isActive ? sub(at, mul(remainder, entry.seconds)) : queuedAt
            if (entry.paused || unknown) {
                entry.pauseAt ??= serial(at)
                job.workProjection = { start_time: stamp(entry.pauseAt), finish_time: 0, total_finish_time: 0 }
                unknown = true
            } else {
                delete entry.pauseAt
                const finish = add(isActive ? at : start, mul(sub(1, remainder), entry.seconds))
                const total = add(isActive ? at : start, mul(sub(job.count, entry.progress), entry.seconds))
                job.workProjection = {
                    start_time: stamp(start),
                    finish_time: stamp(finish),
                    total_finish_time: stamp(total),
                }
                queuedAt = total
            }
        }
    }
    const paused = new Set(
        Object.values(ledger.jobs)
            .filter((entry) => entry.paused && entry.pauseReason === 'food')
            .map((entry) => entry.worker),
    )
    for (const pet of state.pets) {
        const record = ledger.pets[pet.guid]
        if (!record) continue
        if (record.pauseOwned && !paused.has(pet.guid)) {
            pet.work_pause = false
            record.pauseOwned = false
        }
        pet.satiety_val = number(F(floor(record.balance)))
        record.lastWire = pet.satiety_val
    }
}
function nextEvent(tables, state, ledger, at) {
    let next = null
    for (const row of activeRows(state, ledger, at)) {
        if (row.entry) {
            if (row.entry.paused) continue
            if (row.entry.worker !== '0' && row.entry.budget !== null) {
                row.record = ledger.pets[row.entry.worker]
            }
        }
        const duration = horizon(tables, row, at)
        if (duration && cmp(duration, 0) > 0) next = next === null ? add(at, duration) : min(next, add(at, duration))
        if (row.entry && !row.entry.paused) {
            // Wake observers at the next visible unit completion, even though
            // the arithmetic horizon can batch many units in an offline pass.
            const pieceLeft = sub(add(F(floor(row.entry.progress)), 1), row.entry.progress)
            const pieceAt = add(at, mul(pieceLeft, row.entry.seconds))
            next = next === null ? pieceAt : min(next, pieceAt)
            if (row.record) {
                // floor(balance) falls only strictly after the fractional
                // remainder has been spent. At an exact integer it therefore
                // changes at the next whole server second, never at this one.
                const remainder = sub(row.record.balance, F(floor(row.record.balance)))
                const boundary = add(at, div(mul(remainder, row.entry.seconds), row.entry.budget))
                const wireAt = F(floor(boundary) + 1n)
                next = min(next, wireAt)
            }
        }
    }
    return next === null ? null : stamp(next)
}
function wireHome(state) {
    return JSON.stringify({
        jobs: Object.fromEntries(
            Object.entries(state.home.productionJobs ?? {}).map(([key, jobs]) => [
                key,
                jobs.map((job) => [job.guid, job.workCompleted, job.workPaused, job.workProjection]),
            ]),
        ),
        food: state.home.builds
            .filter((build) => build.build_type === 6)
            .map((build) => [build.guid, build.pet_canteen]),
    })
}
function wirePets(state) {
    return JSON.stringify(
        (state.pets ?? []).map((pet) => [
            pet.guid,
            pet.satiety_val,
            pet.work_pause,
            pet.work_start_time,
            pet.canteen_id,
        ]),
    )
}
function run(tables, state, now, policy, reconcile) {
    if (
        !enabled(policy) ||
        !state.home ||
        (!state.home.productionWork &&
            !Object.values(state.home.productionJobs ?? {}).some((jobs) =>
                jobs.some((job) => managed(job, policy) || job.workEpoch !== undefined),
            ))
    )
        return { changed: false, homeChanged: false, petChanged: false, nextAt: null }
    time(now)
    tables = productionTables(tables)
    const homeBefore = wireHome(state),
        petsBefore = wirePets(state),
        draft = copyScope(state)
    const { ledger, first } = adopt(tables, draft, F(now), policy)
    let cursor = F(ledger.settledAt)
    if (cmp(now, cursor) < 0) return { changed: false, homeChanged: false, petChanged: false, nextAt: ledger.nextAt }
    if (reconcile) {
        // Called after the real event at this same time. New food/worker/rate
        // never completes a previously paused historical interval.
        cursor = F(now)
        ledger.settledAt = serial(cursor)
    }
    let rows = prepare(tables, draft, ledger, activeRows(draft, ledger, cursor), cursor)
    while (!first && !reconcile && cmp(cursor, now) < 0) {
        let duration = sub(now, cursor),
            moving = false
        for (const row of rows) {
            const until = horizon(tables, row, cursor)
            if (until !== null) {
                moving = true
                duration = min(duration, until)
            }
        }
        if (!moving) break
        ensure(cmp(duration, 0) > 0, 'Production work event did not advance', ErrorCode.GameConfig)
        const end = add(cursor, duration)
        advance(ledger, rows, duration, end)
        cursor = end
        ledger.settledAt = serial(cursor)
        rows = prepare(tables, draft, ledger, activeRows(draft, ledger, cursor), cursor)
    }
    project(draft, ledger, cursor)
    ledger.nextAt = nextEvent(tables, draft, ledger, cursor)
    const homeChanged = wireHome(draft) !== homeBefore,
        petChanged = wirePets(draft) !== petsBefore
    const changed = homeChanged || petChanged || !equal(draft.home.productionWork, state.home.productionWork)
    if (changed) {
        state.home = draft.home
        state.pets = draft.pets
    }
    return { changed, homeChanged, petChanged, nextAt: ledger.nextAt }
}

export function settleProductionWork(tables, state, now, policy) {
    return run(tables, state, now, policy, false)
}
export function reconcileProductionWork(tables, state, now, policy) {
    return run(tables, state, now, policy, true)
}
export function productionWorkDue(tables, state, now, policy) {
    if (!enabled(policy) || !state.home) return false
    time(now)
    const ledger = state.home.productionWork
    if (ledger) {
        validateLedger(ledger)
        if (cmp(now, ledger.settledAt) < 0) return false
    }
    const jobs = Object.values(state.home.productionJobs ?? {})
        .flat()
        // A narrower future scope does not discard an already sealed epoch.
        .filter((job) => managed(job, policy) || job.workEpoch !== undefined)
    if (!jobs.length) return !!ledger && Object.keys(ledger.jobs ?? {}).length > 0
    if (!ledger || jobs.some((job) => job.workEpoch === undefined || !ledger.jobs?.[job.workEpoch])) return true
    return ledger.nextAt !== null && now >= ledger.nextAt
}
