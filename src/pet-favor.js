import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
const constants = new WeakMap()

export function petFavorConstant(tables, title) {
    if (!constants.has(tables)) constants.set(tables, new Map(tables.get('game').map((row) => [row.title, row])))
    const value = Number(constants.get(tables).get(title)?.value)
    ensure(Number.isSafeInteger(value) && value >= 0, 'Invalid ' + title, ErrorCode.GameConfig)
    return value
}
function period(tables, now) {
    const hour = petFavorConstant(tables, 'DAILY_REFRESH_TIME')
    ensure(hour <= 23 && Number.isSafeInteger(now) && now >= 0, 'Invalid pet favor clock', ErrorCode.GameConfig)
    return Math.floor((now + (8 - hour) * 3600) / 86400)
}
function daily(tables, state, pet, now) {
    const day = period(tables, now),
        saved = state.petCaressPeriods?.[pet.guid]
    ensure(saved === undefined || Number.isSafeInteger(saved), 'Invalid pet favor period', ErrorCode.GameConfig)
    const timestamp = pet.daily_favor_time ?? 0
    ensure(Number.isSafeInteger(timestamp) && timestamp >= 0, 'Invalid pet favor timestamp', ErrorCode.GameConfig)
    const previous = saved ?? (timestamp ? period(tables, timestamp) : day),
        reset = previous !== day
    const rows = new Map()
    for (const row of reset ? [] : (pet.daily_favor_val ?? [])) {
        ensure(
            Number.isSafeInteger(row.source_type) &&
                row.source_type > 0 &&
                row.source_type <= 0xffffffff &&
                Number.isSafeInteger(row.favor_val) &&
                row.favor_val >= 0,
            'Invalid pet daily favor record',
            ErrorCode.GameConfig,
        )
        const sum = (rows.get(row.source_type)?.favor_val ?? 0) + row.favor_val
        ensure(sum <= 0xffffffff, 'Pet daily favor overflow', ErrorCode.GameConfig)
        rows.set(row.source_type, { source_type: row.source_type, favor_val: sum })
    }
    const old = reset ? 0 : (pet.daily_favor_count ?? 0)
    ensure(
        Number.isSafeInteger(old) && old >= 0 && old <= 0xffffffff,
        'Invalid pet daily favor total',
        ErrorCode.GameConfig,
    )
    const total = [...rows.values()].reduce((n, row) => n + row.favor_val, 0)
    ensure(total <= 0xffffffff, 'Pet daily favor overflow', ErrorCode.GameConfig)
    // Old local saves counted caress interactions. Recorded favor is the
    // known lower bound; preserve a larger historical total when ambiguous.
    const count = Math.max(old, total)
    return { day, reset, rows, count, known: saved !== undefined || timestamp > 0 || rows.size > 0 || count > 0 }
}
export function refreshPetFavorPeriod(tables, state, pet, now) {
    const data = daily(tables, state, pet, now)
    if (!data.known && !data.reset) return false
    const updates = {
        daily_favor_count: data.count,
        daily_favor_val: [...data.rows.values()],
        daily_favor_time: data.reset ? now : pet.daily_favor_time || now,
    }
    const changed =
        Object.entries(updates).some(([key, value]) => JSON.stringify(pet[key]) !== JSON.stringify(value)) ||
        state.petCaressPeriods?.[pet.guid] !== data.day
    if (changed) {
        Object.assign(pet, updates)
        ;(state.petCaressPeriods ??= {})[pet.guid] = data.day
    }
    return changed
}
export function petFavorPlan(tables, state, pet, requested, sourceId, now, sourceMaximum = Infinity) {
    ensure(
        Number.isSafeInteger(requested) && requested >= 0 && requested <= 0xffffffff,
        'Invalid favor gain',
        ErrorCode.GameConfig,
    )
    ensure(
        Number.isSafeInteger(sourceId) && sourceId > 0 && sourceId <= 0xffffffff,
        'Invalid pet favor source',
        ErrorCode.GameConfig,
    )
    const data = daily(tables, state, pet, now),
        maximum = petFavorConstant(tables, 'PET_FAVORABILITY_MAX')
    const source = data.rows.get(sourceId) ?? { source_type: sourceId, favor_val: 0 }
    let left = Math.min(requested, Math.max(0, maximum - data.count), Math.max(0, sourceMaximum - source.favor_val))
    const budget = left,
        levels = new Map(tables.get('pet_favorability').map((row) => [row.level, row.exp]))
    let level = pet.favor_lv === undefined || pet.favor_lv === 0 ? 1 : pet.favor_lv,
        value = pet.favor_val ?? 0
    const oldLevel = level
    ensure(
        Number.isSafeInteger(level) && levels.has(level) && Number.isSafeInteger(value) && value >= 0,
        'Invalid pet favor progress',
        ErrorCode.GameConfig,
    )
    if (levels.has(level + 1))
        ensure(
            Number.isSafeInteger(levels.get(level)) && levels.get(level) > 0 && value <= levels.get(level),
            'Invalid pet favor curve/progress',
            ErrorCode.GameConfig,
        )
    while (left > 0 && levels.has(level + 1)) {
        const threshold = levels.get(level)
        ensure(
            Number.isSafeInteger(threshold) && threshold > 0 && value <= threshold,
            'Invalid pet favor curve',
            ErrorCode.GameConfig,
        )
        const applied = Math.min(left, threshold - value)
        value += applied
        left -= applied
        if (value === threshold) {
            level++
            value = 0
        }
    }
    const gained = budget - left
    source.favor_val += gained
    data.rows.set(sourceId, source)
    const updates = {
        favor_lv: level,
        favor_val: value,
        daily_favor_count: data.count + gained,
        daily_favor_val: [...data.rows.values()],
        daily_favor_time: data.reset || gained || !pet.daily_favor_time ? now : pet.daily_favor_time,
    }
    return {
        updates,
        day: data.day,
        gained,
        levels: level - oldLevel,
        changed:
            state.petCaressPeriods?.[pet.guid] !== data.day ||
            Object.entries(updates).some(([key, next]) => JSON.stringify(pet[key]) !== JSON.stringify(next)),
    }
}
export function applyPetFavorPlan(state, pet, plan) {
    Object.assign(pet, plan.updates)
    ;(state.petCaressPeriods ??= {})[pet.guid] = plan.day
}
