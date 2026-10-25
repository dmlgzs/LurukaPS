import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'
import policy from '../configs/login-day-progress-policy.json' with { type: 'json' }
const uint = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff
const positive = (n) => uint(n) && n > 0
const catalogues = new WeakMap(),
    warnings = new WeakMap()
function diagnostic(tables, state, reason, day) {
    if (!warnings.has(tables)) warnings.set(tables, new Map())
    const account = state.player?.basic_info?.id ?? null,
        map = warnings.get(tables)
    if (!map.has(account)) map.set(account, new Set())
    if (map.get(account).has(reason)) return
    map.get(account).add(reason)
    console.warn(
        '[login-day-progress]',
        JSON.stringify({ accountId: account, reason, day, action: 'facts-preserved-no-new-day' }),
    )
}
function calendar(tables) {
    if (catalogues.has(tables)) return catalogues.get(tables)
    const rows = tables.get('game').filter((row) => row.title === 'DAILY_REFRESH_TIME'),
        hour = Number(rows[0]?.value)
    ensure(
        policy.version === 1 &&
            policy.officiallyVerified === false &&
            policy.timezoneHours === 8 &&
            policy.event === 'successful-5001-main-entry-transaction' &&
            policy.continuousProgress === 'maximum-observed-consecutive-entry-days' &&
            rows.length === 1 &&
            /^(?:\d|1\d|2[0-3])$/.test(String(rows[0]?.value)) &&
            Number.isInteger(hour) &&
            hour >= 0 &&
            hour < 24,
        'Invalid login day calendar policy',
        ErrorCode.GameConfig,
    )
    const result = { hour, timezoneHours: policy.timezoneHours }
    catalogues.set(tables, result)
    return result
}
export function loginDayFacts(tables, state) {
    const data = calendar(tables),
        saved = state.loginDayProgress
    if (saved === undefined) return { totalDays: 0, streakDays: 0, longestStreak: 0, revision: 0 }
    ensure(
        saved &&
            typeof saved === 'object' &&
            !Array.isArray(saved) &&
            saved.version === 1 &&
            Number.isInteger(saved.resetHour) &&
            saved.resetHour >= 0 &&
            saved.resetHour < 24 &&
            saved.timezoneHours === data.timezoneHours &&
            uint(saved.firstDay) &&
            uint(saved.lastDay) &&
            saved.firstDay <= saved.lastDay &&
            positive(saved.totalDays) &&
            positive(saved.streakDays) &&
            positive(saved.longestStreak) &&
            positive(saved.revision) &&
            saved.revision === saved.totalDays &&
            saved.totalDays <= saved.lastDay - saved.firstDay + 1 &&
            saved.streakDays <= saved.longestStreak &&
            saved.longestStreak <= saved.totalDays,
        'Invalid saved login day facts',
        ErrorCode.GameConfig,
    )
    return saved
}
export function recordLoginDay(tables, state, now) {
    ensure(Number.isSafeInteger(now) && now >= 0, 'Invalid login day clock', ErrorCode.GameConfig)
    const data = calendar(tables),
        day = Math.floor((now + (data.timezoneHours - data.hour) * 3600) / 86400),
        previous = loginDayFacts(tables, state)
    ensure(uint(day), 'Login day bucket overflow', ErrorCode.GameConfig)
    if (previous.totalDays) {
        // A valid sealed calendar needs explicit migration before new dates
        // can be combined with a different configured daily boundary.
        if (previous.resetHour !== data.hour) {
            diagnostic(tables, state, 'calendar-migration-required', day)
            return false
        }
        if (day < previous.lastDay) {
            diagnostic(tables, state, 'server-day-moved-backwards', day)
            return false
        }
        warnings.get(tables)?.delete(state.player?.basic_info?.id ?? null)
        if (day === previous.lastDay) return false
    }
    const totalDays = previous.totalDays + 1,
        streakDays = previous.totalDays && day === previous.lastDay + 1 ? previous.streakDays + 1 : 1,
        revision = previous.revision + 1
    ensure(
        positive(totalDays) && positive(streakDays) && positive(revision),
        'Login day counter overflow',
        ErrorCode.GameConfig,
    )
    state.loginDayProgress = {
        version: 1,
        timezoneHours: data.timezoneHours,
        resetHour: data.hour,
        firstDay: previous.totalDays ? previous.firstDay : day,
        lastDay: day,
        totalDays,
        streakDays,
        longestStreak: Math.max(previous.longestStreak, streakDays),
        revision,
    }
    return true
}
export function loginDayProgressRule(tables, tokens) {
    if (!Array.isArray(tokens) || tokens.length !== 2 || ![15048, 20003].includes(tokens[0]) || !positive(tokens[1]))
        return false
    calendar(tables)
    return true
}
export function loginDayProgressValue(tables, state, tokens, facts = new Map()) {
    if (!loginDayProgressRule(tables, tokens)) return 0
    const key = 'login-day-progress'
    if (!facts.has(key)) facts.set(key, loginDayFacts(tables, state))
    const saved = facts.get(key)
    return Math.min(tokens[1], tokens[0] === 15048 ? saved.longestStreak : saved.totalDays)
}
