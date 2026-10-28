import { createHash } from 'node:crypto'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { canteenFoodScore, readCanteenFoodLedger } from './canteen-food-ledger.js'
import {
    workFraction,
    workAdd,
    workSub,
    workDiv,
    workCompare,
    workFloor,
    workCeil,
    workNumber,
    workSerialize,
} from './production-work-fractions.js'

const uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
const positive = (value) => uint(value) && value > 0
const emptyCanteen = () => ({ pets: [], food_value: 0, foods: [], food_extra_ids: [], food_extra_values: [] })
function fingerprint(value) {
    let json
    try {
        json = JSON.stringify(value)
    } catch {
        ensure(false, 'Production food preimage is not serializable', ErrorCode.GameConfig)
    }
    ensure(typeof json === 'string', 'Missing production food preimage', ErrorCode.GameConfig)
    return createHash('sha256').update(json).digest('hex')
}
function sources(state) {
    if (!state.home) return []
    ensure(Array.isArray(state.home.builds), 'Invalid owned production food sources', ErrorCode.GameConfig)
    const counts = new Map()
    for (const build of state.home.builds) counts.set(build.guid, (counts.get(build.guid) ?? 0) + 1)
    return state.home.builds
        .filter((build) => build.build_type === 6 && build.locate && [1, 4].includes(build.status))
        .map((build) => {
            ensure(
                positive(build.guid) && counts.get(build.guid) === 1,
                'Invalid or duplicate production food building identity',
                ErrorCode.GameConfig,
            )
            return build
        })
        .sort((a, b) => a.guid - b.guid)
}
function sourcePreimage(state, builds) {
    return fingerprint({
        owner: state.player?.basic_info?.id ?? null,
        homeRevision: state.homeRevision ?? 0,
        builds: builds.map((build) => ({
            guid: build.guid,
            build_id: build.build_id,
            build_type: build.build_type,
            status: build.status,
            locate: build.locate,
            pet_canteen: build.pet_canteen ?? null,
        })),
    })
}
function argumentsFor(balance, budget, cap) {
    ensure(
        positive(budget) && positive(cap) && budget <= cap,
        'Production food budget is incompatible with recovery cap',
        ErrorCode.GameConfig,
    )
    const value = workFraction(balance)
    ensure(
        workCompare(value, 0) >= 0 && workCompare(value, 0xffffffff) <= 0,
        'Production food balance is outside its wire range',
        ErrorCode.GameConfig,
    )
    return value
}

// Review-only local whole-dish policy. This function never initializes or edits state.
export function planProductionFeeding(tables, state, { balance, budget, cap }) {
    const original = argumentsFor(balance, budget, cap)
    const result = (
        satisfied,
        value = original,
        recovery = 0,
        waste = 0,
        transfers = [],
        updates = [],
        preimage = null,
    ) => ({
        version: 1,
        satisfied,
        input: { balance: workSerialize(original), budget, cap },
        balance: workSerialize(value),
        recovery: workSerialize(recovery),
        waste: workSerialize(waste),
        transfers,
        updates,
        sourcePreimage: preimage,
    })
    // Retained old balances above cap remain valid; cap limits recovery only.
    if (workCompare(original, budget) >= 0) return result(true)
    const builds = sources(state),
        preimage = sourcePreimage(state, builds),
        ledgers = new Map(),
        rows = []
    let total = 0n
    for (const build of builds) {
        const config = tables.find('home_building', build.build_id)
        ensure(config, 'Production food building configuration is missing', ErrorCode.BuildConfNotFound)
        const group = tables.get('home_building_group').find((entry) => entry.groupId === config.groupId)
        ensure(group, 'Production food building group is missing', ErrorCode.BuildGroupConfNotFound)
        ensure(group.type === 6, 'Production food source is not a canteen', ErrorCode.BuildTypeNotMatch)
        const canteen = build.pet_canteen ?? emptyCanteen(),
            foods = readCanteenFoodLedger(tables, canteen)
        ledgers.set(build.guid, { build, canteen, foods })
        for (const [itemId, count] of foods) {
            const score = canteenFoodScore(tables, itemId, true)
            rows.push({ buildGuid: build.guid, itemId, count, score })
            total += BigInt(count) * BigInt(score)
        }
    }
    // Never consume a fragment of the available stock if it cannot admit this unit.
    if (workCompare(total, workSub(budget, original)) < 0) return result(false, original, 0, 0, [], [], preimage)
    const tie = (a, b) => a.buildGuid - b.buildGuid || a.itemId - b.itemId
    const descending = rows.slice().sort((a, b) => b.score - a.score || tie(a, b))
    const ascending = rows.slice().sort((a, b) => a.score - b.score || tie(a, b))
    const transfers = new Map(),
        usedBuilds = new Set()
    let current = original,
        recovery = workFraction(0),
        waste = workFraction(0)
    while (workCompare(current, budget) < 0) {
        const space = workSub(cap, current)
        const fitting = descending.find((row) => row.count > 0 && workCompare(row.score, space) <= 0)
        const row = fitting ?? ascending.find((entry) => entry.count > 0)
        ensure(row, 'Production food plan exhausted proven stock', ErrorCode.GameConfig)
        let count = 1n
        if (fitting) {
            const room = workFloor(workDiv(space, row.score)),
                need = workCeil(workDiv(workSub(budget, current), row.score))
            count = [BigInt(row.count), room, need].reduce((a, b) => (a < b ? a : b))
        }
        ensure(count > 0n, 'Production food batch made no progress', ErrorCode.GameConfig)
        const consumed = count * BigInt(row.score),
            gain = workCompare(consumed, space) > 0 ? space : workFraction(consumed)
        recovery = workAdd(recovery, gain)
        waste = workAdd(waste, workSub(consumed, gain))
        current = workAdd(current, gain)
        const amount = workNumber(count),
            key = row.buildGuid + ':' + row.itemId
        row.count -= amount
        const previous = transfers.get(key)
        if (previous) previous.count += amount
        else transfers.set(key, { buildGuid: row.buildGuid, itemId: row.itemId, count: amount, score: row.score })
        usedBuilds.add(row.buildGuid)
    }
    const updates = [...usedBuilds]
        .sort((a, b) => a - b)
        .map((buildGuid) => {
            const { canteen, foods } = ledgers.get(buildGuid),
                deductions = new Map()
            let removed = 0n
            for (const transfer of transfers.values())
                if (transfer.buildGuid === buildGuid) {
                    deductions.set(transfer.itemId, transfer.count)
                    removed += BigInt(transfer.count) * BigInt(transfer.score)
                }
            return {
                buildGuid,
                preimage: fingerprint(canteen),
                foods: [...foods].flatMap(([itemid, itemnum]) => {
                    const remaining = itemnum - (deductions.get(itemid) ?? 0)
                    return remaining ? [{ itemtype: 3, itemid, itemnum: remaining }] : []
                }),
                food_value: Number(BigInt(canteen.food_value ?? 0) - removed),
            }
        })
    return result(true, current, recovery, waste, [...transfers.values()], updates, preimage)
}

// Plans are immediate synchronous-transaction values, not persisted authorization.
// Validate every physical preimage before assigning any copy-on-write branch.
export function applyProductionFeeding(state, plan) {
    ensure(
        plan?.version === 1 &&
            typeof plan.satisfied === 'boolean' &&
            Array.isArray(plan.transfers) &&
            Array.isArray(plan.updates),
        'Invalid production food plan',
        ErrorCode.GameConfig,
    )
    const original = argumentsFor(plan.input?.balance, plan.input?.budget, plan.input?.cap)
    const balance = workFraction(plan.balance),
        recovery = workFraction(plan.recovery),
        waste = workFraction(plan.waste)
    ensure(
        workCompare(recovery, 0) >= 0 &&
            workCompare(waste, 0) >= 0 &&
            workCompare(workAdd(original, recovery), balance) === 0,
        'Invalid production food balance conservation',
        ErrorCode.GameConfig,
    )
    if (plan.transfers.length === 0) {
        ensure(
            plan.updates.length === 0 &&
                workCompare(recovery, 0) === 0 &&
                workCompare(waste, 0) === 0 &&
                plan.satisfied === workCompare(original, plan.input.budget) >= 0,
            'Invalid empty production food plan',
            ErrorCode.GameConfig,
        )
        return false
    }
    ensure(
        plan.satisfied && workCompare(balance, plan.input.budget) >= 0 && workCompare(balance, plan.input.cap) <= 0,
        'Unfulfilled production food plan cannot consume stock',
        ErrorCode.GameConfig,
    )
    const builds = sources(state),
        byGuid = new Map(builds.map((build) => [build.guid, build]))
    ensure(
        typeof plan.sourcePreimage === 'string' && sourcePreimage(state, builds) === plan.sourcePreimage,
        'Stale production food source preimage',
        ErrorCode.GameConfig,
    )
    const deductions = new Map(),
        pairs = new Set()
    let raw = 0n
    for (const transfer of plan.transfers) {
        ensure(
            positive(transfer.buildGuid) &&
                positive(transfer.itemId) &&
                positive(transfer.count) &&
                positive(transfer.score) &&
                transfer.score <= 0x7fffffff &&
                byGuid.has(transfer.buildGuid),
            'Invalid production food transfer',
            ErrorCode.GameConfig,
        )
        const key = transfer.buildGuid + ':' + transfer.itemId
        ensure(!pairs.has(key), 'Duplicate production food transfer', ErrorCode.GameConfig)
        pairs.add(key)
        const rows = deductions.get(transfer.buildGuid) ?? new Map()
        rows.set(transfer.itemId, transfer)
        deductions.set(transfer.buildGuid, rows)
        raw += BigInt(transfer.count) * BigInt(transfer.score)
    }
    ensure(
        workCompare(workAdd(recovery, waste), raw) === 0 && plan.updates.length === deductions.size,
        'Invalid production food quantity conservation',
        ErrorCode.GameConfig,
    )
    const replacements = new Map()
    for (const update of plan.updates) {
        const build = byGuid.get(update.buildGuid),
            rows = deductions.get(update.buildGuid)
        ensure(
            build && rows && !replacements.has(build.guid) && Array.isArray(update.foods) && uint(update.food_value),
            'Invalid production food update',
            ErrorCode.GameConfig,
        )
        const canteen = build.pet_canteen ?? emptyCanteen()
        ensure(fingerprint(canteen) === update.preimage, 'Stale production food ledger preimage', ErrorCode.GameConfig)
        const old = new Map(canteen.foods.map((entry) => [entry.itemid, entry.itemnum]))
        let removed = 0n
        for (const [id, transfer] of rows) {
            ensure(
                old.has(id) && old.get(id) >= transfer.count,
                'Production food transfer exceeds original stock',
                ErrorCode.GameConfig,
            )
            old.set(id, old.get(id) - transfer.count)
            removed += BigInt(transfer.count) * BigInt(transfer.score)
        }
        const expected = [...old].filter(([, count]) => count > 0)
        ensure(
            update.foods.length === expected.length &&
                update.foods.every(
                    (entry, i) =>
                        entry.itemtype === 3 && entry.itemid === expected[i][0] && entry.itemnum === expected[i][1],
                ) &&
                BigInt(update.food_value) === BigInt(canteen.food_value ?? 0) - removed,
            'Production food update does not match transfers',
            ErrorCode.GameConfig,
        )
        replacements.set(build.guid, {
            ...build,
            pet_canteen: {
                ...canteen,
                foods: update.foods.map((entry) => ({ ...entry })),
                food_value: update.food_value,
            },
        })
    }
    state.home = { ...state.home, builds: state.home.builds.map((build) => replacements.get(build.guid) ?? build) }
    return true
}
