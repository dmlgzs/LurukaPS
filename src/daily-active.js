import { recordBattlePassProgress } from './battle-pass-tasks.js'
import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'

const catalogues = new WeakMap()
// 12072 is produced only by a validated, newly completed field chest claim.
// Generic Item(3), collection and puzzle-solved stages never supply this event.
// All preceding filters in the current table are wildcard zeroes.
const shapes = new Map([
    [12001, 1],
    [11006, 1],
    [15000, 2],
    [15001, 2],
    [15002, 2],
    [13109, 3],
    [12002, 5],
    [15007, 3],
    [15071, 2],
    [15011, 1],
    [15014, 1],
    [15003, 3],
    [15004, 3],
    [12072, 2],
])
export function activeCatalogue(tables) {
    if (catalogues.has(tables)) return catalogues.get(tables)
    const rows = tables.get('activity').map((row) => {
        const [kind, ...args] = String(row.finishCondition).split('#').map(Number)
        ensure(
            [row.id, row.para, row.reward, kind, ...args].every(Number.isSafeInteger) &&
                row.id > 0 &&
                row.para > 0 &&
                row.reward >= 0 &&
                [1, 2].includes(row.taskType),
            'Invalid active task configuration',
            ErrorCode.GameConfig,
        )
        ensure(
            shapes.get(kind) === args.length && args.slice(0, -1).every((n) => n === 0),
            'Active task condition shape is not implemented',
            ErrorCode.FunctionClosed,
        )
        ensure(
            args.at(-1) === row.para && tables.find('common_condition', kind),
            'Active task condition target is inconsistent',
            ErrorCode.GameConfig,
        )
        ensure(!row.system, 'Active task system gate is not implemented', ErrorCode.FunctionClosed)
        return { ...row, kind }
    })
    ensure(new Set(rows.map((r) => r.id)).size === rows.length, 'Duplicate active task IDs', ErrorCode.GameConfig)
    const hour = Number(tables.get('game').find((r) => r.title === 'DAILY_REFRESH_TIME')?.value)
    const weekday = Number(tables.get('game').find((r) => r.title === 'WEEKLY_REFRESH_TIME')?.value)
    ensure(
        Number.isInteger(hour) && hour >= 0 && hour < 24 && Number.isInteger(weekday) && weekday >= 1 && weekday <= 7,
        'Invalid activity refresh calendar',
        ErrorCode.GameConfig,
    )
    const data = { rows, byId: new Map(rows.map((r) => [r.id, r])), hour, weekday }
    catalogues.set(tables, data)
    return data
}
function keys(data, now) {
    // Arena contexts retain millisecond precision; calendar buckets use whole
    // wall-clock seconds and must not reject otherwise valid battle events.
    ensure(
        Number.isFinite(now) && now >= 0 && now <= Number.MAX_SAFE_INTEGER,
        'Invalid activity server time',
        ErrorCode.GameConfig,
    )
    const day = Math.floor((Math.floor(now) + (8 - data.hour) * 3600) / 86400)
    return { day, week: Math.floor((day + 4 - data.weekday) / 7) }
}
const fresh = (key) => ({ key, counts: {}, claimed: [], rewardIds: [], active: 0, notices: [] })
export function activePeriodDue(tables, state, now) {
    const current = keys(activeCatalogue(tables), now)
    return state.dailyActive?.day?.key !== current.day || state.dailyActive?.week?.key !== current.week
}
export function ensureActivePeriods(tables, state, now) {
    const key = keys(activeCatalogue(tables), now),
        old = state.dailyActive ?? {}
    ensure(
        typeof old === 'object' &&
            !Array.isArray(old) &&
            (old.resetTypes === undefined ||
                (Array.isArray(old.resetTypes) && old.resetTypes.every((n) => [1, 2].includes(n)))),
        'Invalid saved activity state',
        ErrorCode.GameConfig,
    )
    for (const name of ['day', 'week'])
        if (old[name]) {
            const p = old[name]
            ensure(
                Number.isSafeInteger(p.key) &&
                    p.counts &&
                    !Array.isArray(p.counts) &&
                    Object.values(p.counts).every((n) => Number.isSafeInteger(n) && n >= 0) &&
                    ['claimed', 'rewardIds', 'notices'].every(
                        (k) => Array.isArray(p[k]) && p[k].every(Number.isSafeInteger),
                    ) &&
                    Number.isSafeInteger(p.active) &&
                    p.active >= 0,
                'Invalid saved activity period',
                ErrorCode.GameConfig,
            )
        }
    if (old.day?.key !== key.day || old.week?.key !== key.week)
        state.dailyActive = {
            ...old,
            resetTypes: [
                ...new Set([
                    ...(old.resetTypes ?? []),
                    ...(old.day && old.day.key !== key.day ? [1] : []),
                    ...(old.week && old.week.key !== key.week ? [2] : []),
                ]),
            ],
            day: old.day?.key === key.day ? old.day : fresh(key.day),
            week: old.week?.key === key.week ? old.week : { ...fresh(key.week), loginDays: [] },
        }
    return state.dailyActive
}
export function recordActiveProgress(tables, state, kind, amount, now) {
    ensure(Number.isSafeInteger(amount) && amount > 0, 'Invalid active progress increment', ErrorCode.GameConfig)
    const data = activeCatalogue(tables),
        ledger = ensureActivePeriods(tables, state, now)
    recordBattlePassProgress(tables, state, kind, amount, now)
    let next = ledger
    for (const [name, type] of [
        ['day', 1],
        ['week', 2],
    ]) {
        const cap = Math.max(0, ...data.rows.filter((r) => r.taskType === type && r.kind === kind).map((r) => r.para))
        if (!cap) continue
        const old = ledger[name],
            count = Math.min(cap, (old.counts[kind] ?? 0) + amount)
        if (count === old.counts[kind]) continue
        next = { ...next, [name]: { ...old, counts: { ...old.counts, [kind]: count } } }
    }
    if (next === ledger) return false
    state.dailyActive = next
    return true
}
export function observeActiveSession(tables, state, now) {
    const ledger = ensureActivePeriods(tables, state, now),
        days = ledger.week.loginDays ?? []
    ensure(
        Array.isArray(days) && days.every(Number.isSafeInteger) && days.length <= 7,
        'Invalid activity login days',
        ErrorCode.GameConfig,
    )
    if (days.includes(ledger.day.key)) return
    recordActiveProgress(tables, state, 12001, 1, now)
    state.dailyActive = {
        ...state.dailyActive,
        week: { ...state.dailyActive.week, loginDays: [...days, ledger.day.key] },
    }
}
export function activeSnapshot(tables, state, now) {
    const data = activeCatalogue(tables),
        ledger = ensureActivePeriods(tables, state, now)
    return {
        group_infos: [1, 2].map((type) => {
            const period = ledger[type === 1 ? 'day' : 'week']
            return {
                task_type: type,
                active_value: period.active,
                reward_ids: [...period.rewardIds],
                task_infos: data.rows
                    .filter((r) => r.taskType === type)
                    .map((r) => {
                        const value = Math.min(r.para, period.counts[r.kind] ?? 0)
                        return {
                            task_id: r.id,
                            task_value: value,
                            task_status: period.claimed.includes(r.id) ? 2 : value >= r.para ? 1 : 0,
                        }
                    }),
            }
        }),
    }
}
export function initialActiveSnapshot(tables, state, now) {
    observeActiveSession(tables, state, now)
    const value = activeSnapshot(tables, state, now)
    state.dailyActive = { ...state.dailyActive, signature: JSON.stringify(value), resetTypes: [] }
    return value
}
export function notifyActive(c) {
    const data = activeSnapshot(c.tables, c.state, c.now),
        signature = JSON.stringify(data)
    const resets = c.state.dailyActive.resetTypes ?? []
    if (c.state.dailyActive.signature === signature && !resets.length) return
    let ledger = { ...c.state.dailyActive, signature, resetTypes: [] }
    const completed = []
    for (const g of data.group_infos) {
        const name = g.task_type === 1 ? 'day' : 'week',
            old = ledger[name]
        const current = g.task_infos.filter((t) => t.task_status === 1 && !old.notices.includes(t.task_id))
        if (current.length) {
            completed.push(...current)
            ledger = { ...ledger, [name]: { ...old, notices: [...old.notices, ...current.map((t) => t.task_id)] } }
        }
    }
    c.state.dailyActive = ledger
    // The current Lua clears old chest flags only on active_value == 0.
    // A direct first claim after rollover can already be 20; clear then apply.
    if (resets.length)
        c.pushBefore('CSProtoDailyActiveInfoSync', {
            group_infos: resets.map((task_type) => ({ task_type, active_value: 0, reward_ids: [], task_infos: [] })),
        })
    c.pushBefore('CSProtoDailyActiveInfoSync', data)
    if (completed.length) c.pushBefore('CSProtoActiveTaskComplete', { task_infos: completed })
}
// Read two scalar authoritative ledgers; never clone/scan the whole bag per request.
export const activeCounterSample = (state) => ({
    captures: state.noviceCounters?.captures ?? 0,
    stamina: state.noviceCounters?.staminaSpent ?? 0,
})
export function observeActiveCounters(c, before) {
    const after = activeCounterSample(c.state)
    if (after.captures > before.captures)
        recordActiveProgress(c.tables, c.state, 13109, after.captures - before.captures, c.now)
    if (after.stamina > before.stamina)
        recordActiveProgress(c.tables, c.state, 11006, after.stamina - before.stamina, c.now)
}

// Call at an authoritative run completion, not on a client success flag or on
// each wave. Future weekly/crisis entry implementations can use the same hook.
export function recordActiveDungeonFinish(tables, state, dungeonId, now) {
    if (tables.get('dungeon_crisiscrusade').some((r) => r.dungeonId === dungeonId))
        recordActiveProgress(tables, state, 15007, 1, now)
    if (tables.get('dungeon_weekly').some((r) => r.dungeonId === dungeonId))
        recordActiveProgress(tables, state, 15004, 1, now)
}
