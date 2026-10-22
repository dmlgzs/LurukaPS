import { taskNodeCompleted } from './tasks.js'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { battlePassModel, battlePassRow, prepareBattlePass, requireBattlePass } from './battle-pass.js'
import { battlePassLevelInfo } from './battle-pass-buy-level.js'
import { grantRewards, parseRewards } from './rewards.js'
import { rewardSource } from './reward-source.js'
const catalogues = new WeakMap(),
    eventShapes = new Map([
        [12001, 1],
        [11006, 1],
        [13109, 3],
        [15004, 3],
        [15007, 3],
        [15071, 2],
        [15011, 1],
        [12072, 2],
        [15014, 1],
        [15006, 3],
    ])
function showRules(tables, text) {
    if (!text) return []
    const result = []
    for (const token of String(text).split('|')) {
        const [kind, id, ...extra] = token.split('#').map(Number)
        if (kind !== 12042 || !id || extra.length) return null
        const system = tables.find('system_unlock', id)
        if (!system || system.homeUnlock) return null
        for (const gate of String(system.unlockCondi || '')
            .split('|')
            .filter(Boolean)) {
            const rule = gate.split('#').map(Number)
            if (!(
                (rule[0] === 12045 && rule.length === 3) ||
                (rule[0] === 2007 && rule.length === 2) ||
                (rule[0] === 2004 && rule.length === 2)
            ))
                return null
            result.push(rule)
        }
    }
    return result
}
function showReady(row, state) {
    return (
        row.showRules?.every(([kind, a, b]) =>
            kind === 12045
                ? taskNodeCompleted(state, a, b)
                : kind === 2007
                  ? (state.taskRecords ?? []).some((r) => r.task_id === a && r.count > 0)
                  : state.player.basic_info.lv >= a,
        ) ?? false
    )
}
export function battlePassTaskModel(tables) {
    if (!catalogues.has(tables)) {
        const game = new Map(tables.get('game').map((r) => [r.title, r.value])),
            hour = Number(game.get('DAILY_REFRESH_TIME')),
            weekday = Number(game.get('WEEKLY_REFRESH_TIME'))
        ensure(
            Number.isInteger(hour) &&
                hour >= 0 &&
                hour < 24 &&
                Number.isInteger(weekday) &&
                weekday >= 1 &&
                weekday <= 7,
            'Invalid battle pass refresh calendar',
            ErrorCode.BattlePassConfInvalid,
        )
        const rows = tables.get('battle_pass_task').map((original) => {
            const row = battlePassRow('battle_pass_task', original),
                tokens = String(row.condition).split('|').map(Number),
                [kind, ...args] = tokens
            ensure(
                tokens.every((n) => Number.isSafeInteger(n) && n >= 0) && row.param > 0 && [1, 2, 3].includes(row.type),
                'Invalid battle pass task configuration',
                ErrorCode.BattlePassConfInvalid,
            )
            const event =
                eventShapes.get(kind) === args.length &&
                args.at(-1) === row.param &&
                args.slice(0, -1).every((n) => n === 0)
            const visibility = showRules(tables, row.showCondition)
            const supported =
                event ||
                ([15008, 15009].includes(kind) && args.length === 1 && args[0] === row.param) ||
                (kind === 2007 && args.length === 1 && args[0] > 0) ||
                (kind === 80003 && args.length === 2 && args[1] === row.param) ||
                (kind === 12029 && args.length === 3 && args[0] === 10 && args[1] > 0 && args[2] === row.param)
            return {
                ...row,
                kind,
                args,
                event,
                supported: supported && visibility !== null,
                showRules: visibility,
                expRewards: parseRewards(row.exp),
            }
        })
        const byEventKind = new Map(),
            resourceKeys = new Set(),
            taskIds = [],
            growupIds = [],
            nodeRules = []
        for (const row of rows) {
            for (const rule of row.showRules ?? []) if (rule[0] === 12045) nodeRules.push(rule.slice(1))
            if (row.event) {
                if (!byEventKind.has(row.kind)) byEventKind.set(row.kind, [])
                byEventKind.get(row.kind).push(row)
            }
            if (row.kind === 12029 && row.supported) resourceKeys.add(row.args[0] + ':' + row.args[1])
            if (row.kind === 2007 && row.supported) taskIds.push(row.args[0])
            if (row.kind === 80003 && row.supported) {
                const event = tables.get('game_events').find((r) => r.type === 60 && r.systemId === row.args[0])
                if (event) growupIds.push(event.id)
            }
        }
        catalogues.set(tables, {
            rows,
            hour,
            weekday,
            byEventKind,
            resourceKeys,
            taskIds,
            growupIds,
            nodeRules,
            visibilityTimes: rows
                .flatMap((r) => [r.showTime, r.endTime])
                .filter(Boolean)
                .map(DateTime),
        })
    }
    return catalogues.get(tables)
}
function seasonTasks(model, season) {
    const teams = [season.row.taskIdDay, season.row.taskIdWeek, season.row.taskIdForever]
    return model.rows.filter((r) => teams[r.type - 1] === r.teamId)
}
function periods(tables, prepared, now) {
    const model = battlePassTaskModel(tables),
        day = Math.floor((now + (8 - model.hour) * 3600) / 86400),
        week = Math.floor((day + 4 - model.weekday) / 7),
        tasks = (prepared.ledger.tasks ??= {})
    if (tasks.week?.key !== week) prepared.ledger.curr_week_exp = 0
    for (const [name, key] of [
        ['day', day],
        ['week', week],
        ['forever', prepared.key],
    ])
        if (tasks[name]?.key !== key) tasks[name] = { key, counts: {}, claimed: [] }
    for (const task of Object.values(tasks))
        ensure(
            task &&
                task.counts &&
                !Array.isArray(task.counts) &&
                Object.values(task.counts).every((n) => Number.isSafeInteger(n) && n >= 0) &&
                Array.isArray(task.claimed) &&
                task.claimed.every((n) => Number.isSafeInteger(n) && n > 0),
            'Invalid saved battle pass task counters',
            ErrorCode.GameConfig,
        )
    // An authenticated request establishes this day's online/login condition.
    tasks.day.counts[12001] = 1
    return {
        model,
        tasks,
        dayEnd: (day + 1) * 86400 - (8 - model.hour) * 3600,
        weekEnd: ((week + 1) * 7 - 4 + model.weekday) * 86400 - (8 - model.hour) * 3600,
    }
}
export function prepareBattlePassTaskPeriods(tables, state, now, prepared = prepareBattlePass(tables, state, now)) {
    if (!prepared) return null
    const model = battlePassTaskModel(tables),
        day = Math.floor((now + (8 - model.hour) * 3600) / 86400),
        week = Math.floor((day + 4 - model.weekday) / 7),
        tasks = prepared.ledger.tasks
    if (tasks?.day?.key !== day || tasks?.week?.key !== week || tasks?.forever?.key !== prepared.key)
        periods(tables, prepared, now)
    return prepared
}
function period(tasks, type) {
    return tasks[['day', 'week', 'forever'][type - 1]]
}
function value(tables, state, row, taskPeriod) {
    if (!row.supported) return 0
    if (row.event) return taskPeriod.counts[row.kind] ?? 0
    if (row.kind === 15008) return state.dailyActive?.day?.active ?? 0
    if (row.kind === 15009) return state.dailyActive?.week?.active ?? 0
    if (row.kind === 2007)
        return Number((state.taskRecords ?? []).some((r) => r.task_id === row.args[0] && r.count > 0))
    if (row.kind === 80003) {
        const activity = tables.get('game_events').find((r) => r.type === 60 && r.systemId === row.args[0])
        return new Set((state.activities?.[activity?.id]?.growup?.end_data?.complete_end ?? []).map((x) => x.id)).size
    }
    if (row.kind === 12029)
        return state.battlePassResources?.[state.battlePass?.activeKey]?.[row.args[0] + ':' + row.args[1]] ?? 0
    return 0
}
export function battlePassTaskSnapshot(tables, state, now, prepared = prepareBattlePass(tables, state, now)) {
    if (!prepared) return { day_task: [], week_task: [], forever_task: [], weekEnd: 0 }
    const p = periods(tables, prepared, now),
        out = { day_task: [], week_task: [], forever_task: [], weekEnd: p.weekEnd }
    for (const row of seasonTasks(p.model, prepared.season)) {
        if (row.showRules && !showReady(row, state)) continue
        const shown = row.showTime ? DateTime(row.showTime) : 0
        if (shown > now) continue
        const t = period(p.tasks, row.type),
            end = row.endTime
                ? DateTime(row.endTime)
                : row.type === 1
                  ? p.dayEnd
                  : row.type === 2
                    ? p.weekEnd
                    : prepared.season.effectiveEnd
        const count = Math.min(row.param, value(tables, state, row, t)),
            status = t.claimed.includes(row.id) ? 2 : end <= now ? 3 : count >= row.param ? 1 : 0
        out[['day_task', 'week_task', 'forever_task'][row.type - 1]].push({
            task_id: row.id,
            curr_count: count,
            state: status,
            end_time: String(end),
        })
    }
    return out
}
// Avoid a dependency on the broad activity catalogue while sharing the exact +8 time parser.
import { configTime as DateTime } from './shops.js'
function draft(tables, state, now) {
    if (!state.battlePass?.activeKey) return null
    const root = state.battlePass,
        next = { ...root, seasons: { ...root.seasons } }
    state.battlePass = next
    const prepared = prepareBattlePass(tables, state, now)
    if (!prepared) return null
    prepared.ledger = next.seasons[prepared.key] = { ...prepared.ledger, tasks: { ...prepared.ledger.tasks } }
    for (const name of ['day', 'week', 'forever'])
        if (prepared.ledger.tasks[name])
            prepared.ledger.tasks[name] = {
                ...prepared.ledger.tasks[name],
                counts: { ...prepared.ledger.tasks[name].counts },
            }
    return prepared
}
export function recordBattlePassProgress(tables, state, kind, amount, now) {
    if (!state.battlePass?.activeKey) return false
    const model = battlePassTaskModel(tables),
        rows = model.byEventKind.get(kind)
    if (!rows) return false
    const prepared = draft(tables, state, now)
    if (!prepared) return false
    const p = periods(tables, prepared, now),
        teams = [prepared.season.row.taskIdDay, prepared.season.row.taskIdWeek, prepared.season.row.taskIdForever]
    let changed = false
    const caps = new Map()
    for (const row of rows) {
        if (teams[row.type - 1] !== row.teamId || !showReady(row, state)) continue
        caps.set(row.type, Math.max(caps.get(row.type) ?? 0, row.param))
    }
    // One event increments each period+kind once, even when future tables
    // define several targets for the same condition kind in that period.
    for (const [type, cap] of caps) {
        const target = period(p.tasks, type),
            previous = target.counts[kind] ?? 0,
            count = Math.min(cap, previous + amount)
        if (count !== previous) {
            target.counts[kind] = count
            changed = true
        }
    }
    if (changed) prepared.ledger.taskRevision = (prepared.ledger.taskRevision ?? 0) + 1
    return changed
}
export function recordBattlePassAcquisition(tables, state, type, id, amount) {
    if (type !== 10 || !state.battlePass?.activeKey) return
    const model = battlePassTaskModel(tables)
    if (!model.resourceKeys.has(type + ':' + id)) return
    const season = state.battlePass.activeKey,
        root = state.battlePassResources ?? {},
        counts = root[season] ?? {},
        key = type + ':' + id
    state.battlePassResources = {
        ...root,
        [season]: { ...counts, [key]: Math.min(0xffffffff, (counts[key] ?? 0) + amount) },
    }
}
export function publishBattlePassTasks(c, prepared) {
    const data = battlePassTaskSnapshot(c.tables, c.state, c.now, prepared)
    prepared.ledger.taskSignature = JSON.stringify([
        prepared.key,
        prepared.ledger.level,
        prepared.ledger.exp,
        prepared.ledger.curr_week_exp,
        data,
    ])
    c.pushBefore('SCProtoBattlePassBatchTaskSync', {
        one_task: [...data.day_task, ...data.week_task, ...data.forever_task],
        info: battlePassLevelInfo(prepared.season, prepared.ledger),
    })
}
export function notifyBattlePassTasks(c) {
    const p = prepareBattlePass(c.tables, c.state, c.now)
    if (!p) return
    const model = battlePassTaskModel(c.tables),
        day = Math.floor((c.now + (8 - model.hour) * 3600) / 86400),
        week = Math.floor((day + 4 - model.weekday) / 7)
    const source = [
        p.key,
        day,
        week,
        p.ledger.taskRevision ?? 0,
        p.ledger.level,
        p.ledger.exp,
        p.ledger.curr_week_exp,
        c.state.dailyActive?.day?.active ?? 0,
        c.state.dailyActive?.week?.active ?? 0,
        model.visibilityTimes.filter((time) => time <= c.now).length,
        ...model.nodeRules.map(([id, node]) => Number(taskNodeCompleted(c.state, id, node))),
        ...model.taskIds.map((id) => Number((c.state.taskRecords ?? []).some((r) => r.task_id === id && r.count > 0))),
        ...model.growupIds.map(
            (id) => new Set((c.state.activities?.[id]?.growup?.end_data?.complete_end ?? []).map((x) => x.id)).size,
        ),
        ...[...model.resourceKeys].map((key) => c.state.battlePassResources?.[p.key]?.[key] ?? 0),
    ].join(':')
    if (source === p.ledger.observedSources) return
    const data = battlePassTaskSnapshot(c.tables, c.state, c.now, p),
        signature = JSON.stringify([p.key, p.ledger.level, p.ledger.exp, p.ledger.curr_week_exp, data])
    p.ledger.observedSources = source
    if (signature === p.ledger.taskSignature) return
    p.ledger.taskSignature = signature
    publishBattlePassTasks(c, p)
}
function grantTaskExp(c, prepared, row) {
    const { ledger, season } = prepared,
        model = battlePassModel(c.tables),
        curve = Number(
            model.constants.get(
                season.row.shorttermTip === 1 ? 'BATTLE_PASS_LEVEL_UP_SHORTTERM_EXP' : 'BATTLE_PASS_LEVEL_UP_EXP',
            ),
        ),
        cap = Number(model.constants.get('BATTLE_PASS_WEEKLY_LIMIT'))
    ensure(
        Number.isSafeInteger(curve) && curve > 0 && Number.isSafeInteger(cap) && cap > 0,
        'Invalid battle pass XP configuration',
        ErrorCode.BattlePassConfInvalid,
    )
    const weekly = row.type !== 3,
        available = weekly ? Math.max(0, cap - ledger.curr_week_exp) : 0xffffffff
    ensure(ledger.level < season.maxLevel, 'Battle pass maximum level reached', ErrorCode.BattlePassLevelExceeded)
    if (!available) {
        // Client explicitly confirms claiming without XP at the weekly cap.
        // Close the receipt; keeping FINISH would leave an endless clickable task.
        period(ledger.tasks, row.type).claimed.push(row.id)
        ledger.taskRevision = (ledger.taskRevision ?? 0) + 1
        return []
    }
    ensure(
        row.expRewards.length === 1 && row.expRewards[0].itemtype === 10 && row.expRewards[0].itemid === 50,
        'Invalid battle pass task XP reward',
        ErrorCode.BattlePassConfInvalid,
    )
    const rewards = grantRewards(c.tables, c.state, row.expRewards, 0, {
        battlePassExp: (n) => {
            const amount = Math.min(n, available)
            let total = ledger.exp + amount
            while (ledger.level < season.maxLevel && total >= curve) {
                total -= curve
                ledger.level++
            }
            ledger.exp = total
            if (weekly) ledger.curr_week_exp += amount
            return amount
        },
    })
    period(ledger.tasks, row.type).claimed.push(row.id)
    ledger.taskRevision = (ledger.taskRevision ?? 0) + 1
    return rewards
}
export function claimBattlePassTask(c, r) {
    const p = requireBattlePass(c),
        model = battlePassTaskModel(c.tables),
        row = seasonTasks(model, p.season).find((x) => x.id === r.task_id)
    ensure(row, 'Battle pass task not found', ErrorCode.BattlePassTaskNotFound)
    const data = battlePassTaskSnapshot(c.tables, c.state, c.now, p),
        info = [...data.day_task, ...data.week_task, ...data.forever_task].find((x) => x.task_id === row.id)
    ensure(info, 'Battle pass task is not available', ErrorCode.BattlePassTaskNotFound)
    if (info.state === 2) {
        publishBattlePassTasks(c, p)
        return { rewards: [] }
    }
    ensure(row.supported, 'Battle pass task condition not implemented', ErrorCode.FunctionClosed)
    ensure(info.state === 1, 'Battle pass task is not finished', ErrorCode.BattlePassTaskNotFinished)
    const rewards = grantTaskExp(c, p, row)
    publishBattlePassTasks(c, p)
    return { rewards, ...(rewards.length ? { src: rewardSource(c.tables, 'battlePassTask') } : {}) }
}

