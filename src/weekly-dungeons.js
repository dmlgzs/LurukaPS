import policy from '../configs/weekly-dungeon-policy.json' with { type: 'json' }
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { taskNodeCompleted } from './tasks.js'

const WEEK = 604800
const uint = (v) => Number.isSafeInteger(v) && v >= 0 && v <= 0xffffffff
const plain = (v) => v && typeof v === 'object' && !Array.isArray(v)
// Persisted uint64 values must have an exact representation. A JSON number
// outside the safe range has already lost its original integer precision.
const u64 = (value) =>
    (typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value))) &&
    String(value).length <= 20 &&
    /^(0|[1-9]\d*)$/.test(String(value)) &&
    BigInt(value) <= 0xffffffffffffffffn
// CBT3 EDungeonEntrustEntranceType.WeeklyBoss = 6; resolve the system and all
// concrete task/commission identities through the actual entrance table.
const WEEKLY_ENTRANCE_TYPE = 6
export function requireWeeklySystem(c) {
    const menu = c.tables.find('dungeon_entrust_type', WEEKLY_ENTRANCE_TYPE)
    ensure(
        menu && uint(menu.systemUnLockId) && menu.systemUnLockId > 0 && [0, 1].includes(menu.ifShow),
        'Weekly entrance system relation unavailable',
        ErrorCode.GameConfig,
    )
    ensure(menu.ifShow === 1, 'Weekly entrance is disabled', ErrorCode.FunctionClosed)
    const system = c.tables.find('system_unlock', menu.systemUnLockId)
    ensure(
        system && [0, 1].includes(system.homeUnlock) && typeof system.unlockCondi === 'string',
        'Weekly system configuration unavailable',
        ErrorCode.GameConfig,
    )
    ensure(system.homeUnlock === 0, 'Weekly home-dependent unlock is not implemented', ErrorCode.FunctionClosed)
    ensure(
        typeof c.activityCatalog?.condition === 'function',
        'Authoritative condition evaluator unavailable',
        ErrorCode.GameConfig,
    )
    const expression = system.unlockCondi.replaceAll(/\s/g, '')
    if (!expression) return
    ensure(
        !expression.includes('||'),
        'Weekly system alternative condition is not implemented',
        ErrorCode.FunctionClosed,
    )
    const clauses = expression.split('&&').map((part) => {
        const text = part.startsWith('(') && part.endsWith(')') ? part.slice(1, -1) : part
        ensure(/^\d+(#\d+)+$/.test(text), 'Malformed weekly system unlock expression', ErrorCode.GameConfig)
        const args = text.split('#').map(Number),
            [kind, a, b] = args
        ensure(
            args.every(Number.isSafeInteger) && args.every((n) => n > 0),
            'Invalid weekly system condition arguments',
            ErrorCode.GameConfig,
        )
        ensure(
            [2004, 2007, 12045, 13044].includes(kind),
            'Weekly system condition is not implemented',
            ErrorCode.FunctionClosed,
        )
        ensure(
            args.length === ([2004, 2007].includes(kind) ? 2 : 3),
            'Invalid weekly system condition shape',
            ErrorCode.GameConfig,
        )
        const value = c.activityCatalog.condition(args.join('|'), c.state)
        const target = kind === 2004 ? a : kind === 13044 ? b : 1
        ensure(Number.isFinite(value), 'Invalid weekly system condition result', ErrorCode.GameConfig)
        return value >= target
    })
    // Server admission follows the verified UI/table gate; this is not proof
    // of the official server's internal branch. No general unlock bypass exists.
    ensure(clauses.every(Boolean), 'Weekly dungeon system is locked', ErrorCode.SystemLock)
}
export function weeklyQuotaView(tables, state, now, config = policy) {
    const q = config?.quota
    ensure(
        config?.schemaVersion === 1 &&
            q &&
            q.currencyId === 104 &&
            q.strategy === 'set-to-limit' &&
            q.firstExistingBalance === 'preserve' &&
            q.firstMissingBalance === 'initialize-limit' &&
            q.clockRollback === 'keep-current-period' &&
            Number.isInteger(q.utcOffsetMinutes) &&
            Math.abs(q.utcOffsetMinutes) <= 840,
        'Invalid LOCAL weekly quota policy',
        ErrorCode.GameConfig,
    )
    const value = (title) => {
        const rows = tables.get('game').filter((r) => r.title === title)
        ensure(
            rows.length === 1 && /^\d+$/.test(String(rows[0].value)),
            'Weekly quota game constant unavailable',
            ErrorCode.GameConfig,
        )
        return Number(rows[0].value)
    }
    const limit = value(q.limitGameTitle),
        weekday = value(q.weekdayGameTitle),
        hour = value(q.hourGameTitle)
    ensure(
        uint(now) && uint(limit) && limit > 0 && weekday >= 0 && weekday <= 6 && hour >= 0 && hour <= 23,
        'Invalid weekly quota clock configuration',
        ErrorCode.GameConfig,
    )
    const anchor = ((weekday + 3) % 7) * 86400 + hour * 3600 - q.utcOffsetMinutes * 60
    const periodStart = Math.floor((now - anchor) / WEEK) * WEEK + anchor
    const attrs = state.player?.attr_infos?.attrs
    ensure(Array.isArray(attrs), 'Weekly quota attributes unavailable', ErrorCode.GameConfig)
    const balances = attrs.filter((r) => r.attr_id === q.currencyId)
    ensure(
        balances.length <= 1 && balances.every((r) => u64(r.attr_val)),
        'Invalid or duplicate weekly quota balance',
        ErrorCode.GameConfig,
    )
    const ledger = state.weeklyDungeonQuota
    if (ledger !== undefined)
        ensure(
            plain(ledger) &&
                ledger.schemaVersion === 1 &&
                ledger.policy === 'set-to-limit-v1' &&
                uint(ledger.periodStart) &&
                (ledger.periodStart - anchor) % WEEK === 0 &&
                uint(ledger.initializedAt) &&
                balances.length === 1,
            'Malformed weekly quota ledger',
            ErrorCode.GameConfig,
        )
    return {
        q,
        limit,
        now,
        periodStart,
        ledger,
        attr: balances[0],
        amount: balances[0] ? BigInt(balances[0].attr_val) : undefined,
    }
}
export function prepareWeeklyQuota(tables, state, now, config = policy) {
    const v = weeklyQuotaView(tables, state, now, config)
    if (v.ledger && v.periodStart <= v.ledger.periodStart) return false
    if (!v.attr) state.player.attr_infos.attrs.push({ attr_id: v.q.currencyId, attr_val: String(v.limit) })
    else if (v.ledger) v.attr.attr_val = String(v.limit)
    // LOCAL: preserve an existing legitimate first balance, including zero or
    // GM overflow. Once initialized, each later epoch sets the table limit.
    state.weeklyDungeonQuota = {
        schemaVersion: 1,
        policy: 'set-to-limit-v1',
        periodStart: v.periodStart,
        initializedAt: v.ledger?.initializedAt ?? now,
    }
    return true
}
export function weeklyQuotaDue(tables, state, now) {
    const v = weeklyQuotaView(tables, state, now)
    return v.ledger === undefined || v.periodStart > v.ledger.periodStart
}
function weeklyRecord(tables, key, r) {
    const row = tables.find('dungeon_weekly', Number(key))
    ensure(
        plain(r) &&
            row &&
            String(row.id) === key &&
            r.weekly_id === row.id &&
            r.dungeon_id === row.dungeonId &&
            uint(r.map_id) &&
            r.map_id > 0 &&
            uint(r.star) &&
            r.star <= 7 &&
            uint(r.success_count) &&
            r.success_count > 0 &&
            u64(r.success_time) &&
            u64(r.clearance_time),
        'Malformed weekly dungeon clear record',
        ErrorCode.GameConfig,
    )
    const boxes = tables.get('stamina_chest_drop').filter((b) => b.worldFilter === `4|${row.dungeonId}`)
    ensure(
        boxes.length === 1 && boxes[0].worldmapcityid === r.map_id,
        'Weekly record scene does not match configuration',
        ErrorCode.GameConfig,
    )
    return r
}
export function weeklyDungeonSnapshot(tables, state) {
    const records = state.weeklyDungeonRecords
    ensure(records === undefined || plain(records), 'Malformed weekly dungeon records', ErrorCode.GameConfig)
    return Object.entries(records ?? {}).map(([key, value]) => {
        const r = weeklyRecord(tables, key, value)
        return {
            dungeon_id: r.dungeon_id,
            star: r.star,
            status: 6,
            map_id: r.map_id,
            dungeon_scene_id: r.map_id,
            clearance_time: r.clearance_time,
            start_time: '0',
            end_time: '0',
            line_id: 1,
        }
    })
}
export function weeklyDungeonUnlocked(rule, state) {
    ensure(
        state.weeklyDungeonRecords === undefined || plain(state.weeklyDungeonRecords),
        'Malformed weekly unlock ledger',
        ErrorCode.GameConfig,
    )
    return String(rule || '')
        .split('|')
        .filter(Boolean)
        .every((token) => {
            const p = token.split('#').map(Number),
                [kind, id, target] = p
            ensure(p.every(Number.isSafeInteger) && id > 0, 'Invalid weekly unlock condition', ErrorCode.GameConfig)
            if (kind === 2004) {
                ensure(p.length === 2, 'Invalid weekly level condition', ErrorCode.GameConfig)
                return state.player.basic_info.lv >= id
            }
            ensure(p.length === 3 && target > 0, 'Invalid weekly condition arguments', ErrorCode.GameConfig)
            if (kind === 12045) return taskNodeCompleted(state, id, target)
            ensure(kind === 13117, 'Weekly unlock condition is not implemented', ErrorCode.FunctionClosed)
            const record = state.weeklyDungeonRecords?.[id]
            if (!record) return false
            ensure(uint(record.star) && record.star <= 7, 'Invalid weekly saved star mask', ErrorCode.GameConfig)
            let mask = record.star,
                count = 0
            while (mask) {
                count += mask & 1
                mask >>>= 1
            }
            return count >= target
        })
}
export function recordWeeklyVictory(tables, state, run, mask) {
    const row = tables.find('dungeon_weekly', run.entrust_id)
    ensure(row?.dungeonId === run.dungeon_id, 'Weekly victory configuration unavailable', ErrorCode.DungeonConfNotExist)
    ensure(uint(mask) && mask <= 7, 'Invalid weekly victory star mask', ErrorCode.GameConfig)
    const previous = state.weeklyDungeonRecords
    ensure(previous === undefined || plain(previous), 'Malformed weekly victory ledger', ErrorCode.GameConfig)
    const old = previous?.[row.id]
    if (old !== undefined) weeklyRecord(tables, String(row.id), old)
    const count = (old?.success_count ?? 0) + 1
    ensure(uint(count), 'Weekly clear count overflow', ErrorCode.GameConfig)
    state.weeklyDungeonRecords = {
        ...previous,
        [row.id]: {
            weekly_id: row.id,
            dungeon_id: run.dungeon_id,
            map_id: run.map_id,
            star: (old?.star ?? 0) | mask,
            success_count: count,
            success_time: String(run.end_time),
            clearance_time: String((run.end_time - run.battle_start_time) * 1000),
        },
    }
}
export const weeklyDungeonPolicy = policy
