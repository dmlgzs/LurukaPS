import fs from 'node:fs'
import { configTime, staticTimeRow } from './time-definitions.js'
import { taskNodeCompleted } from './tasks.js'
import { homeCondition } from './home-grid.js'
import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'

const policy = JSON.parse(fs.readFileSync(new URL('../configs/activity-policy.json', import.meta.url)))

// Shared with condition 32005. These windows retain the user's explicit offline
// scheduling policy; they are not recovered official server calendar values.
export function activityWindow(tables, row, now) {
    const limit = staticTimeRow(tables, row.timelimit)
    const start = limit ? configTime(limit.startTime) : 0
    let end = limit ? configTime(limit.endTime) : configTime(policy.missingTimeEndTime)
    if (end && end < now) end = configTime(policy.expiredEndTime)
    return { activity_id: row.id, start_time: start, end_time: end }
}

export function activityConditionUnlocked(condition, state) {
    return String(condition || '')
        .split('|')
        .filter(Boolean)
        .every((text) => {
            const [kind, a, b] = text.split('#').map(Number)
            if (kind === 2004) return state.player.basic_info.lv >= a
            if (kind === 2007) return (state.taskRecords ?? []).some((r) => r.task_id === a && r.count > 0)
            if (kind === 12045) return taskNodeCompleted(state, a, b)
            return false
        })
}

export function activityUnlocked(row, state, tables) {
    const system = tables.find('system_unlock', 34)
    ensure(system, 'Activity system unlock configuration unavailable', ErrorCode.GameConfig)
    if (!homeCondition(system.unlockCondi, state)) return false
    const quick = state.activities?.[row.id]?.quick_unlock_status
    ensure(
        quick === undefined || quick === 0 || quick === 1,
        'Invalid saved activity quick unlock status',
        ErrorCode.GameConfig,
    )
    return quick === 1 || activityConditionUnlocked(row.condition, state)
}

// GameEventData.IsValid (1.0.0 IL 0601b89f) checks unlock and time;
// IsGuideTaskFinished is a separate gate and must not replace this condition.
export function activityValid(tables, row, state, now) {
    if (!row) return false
    // OnSocket_10400 creates the event store solely from published confs. An
    // unavailable guide is omitted there, so ActivityOpenCond.TryGet also fails.
    if (activityGuideIssues(tables, row).length) return false
    const window = activityWindow(tables, row, now)
    return now >= window.start_time && now <= window.end_time && activityUnlocked(row, state, tables)
}

export function cultivationGuideDungeon(tables, groupId) {
    ensure(
        Number.isSafeInteger(groupId) && groupId > 0,
        'Invalid cultivation guide dungeon group',
        ErrorCode.GameConfig,
    )
    // Current ModuleGameEvent_Scenario060167a1 calls CreateDungeon(group, 1).
    // DungeonManager0602bfe8 sends CSCampaignStart.groupId/difficulty, not a row ID.
    const rows = tables.get('dungeon').filter((row) => row.groupId === groupId && row.dungeonGroupOrder === 1)
    ensure(rows.length <= 1, 'Ambiguous cultivation guide dungeon group', ErrorCode.GameConfig)
    const row = rows[0]
    ensure(
        !row || (Number.isSafeInteger(row.id) && row.id > 0),
        'Invalid cultivation guide dungeon identity',
        ErrorCode.GameConfig,
    )
    return row
}

// A graph asset alone is not a task definition. The client also dereferences
// TDTask and TDGameEventsCul.taskDungeon for the cultivation guide entry.
export function activityGuideIssues(tables, row) {
    if (!row.guideTaskId) return []
    const issues = []
    if (!tables.find('task', row.guideTaskId)) issues.push({ table: 'task', id: row.guideTaskId })
    if (row.type === 60) {
        const config = tables.get('game_events_cul').find((x) => x.Id === row.systemId)
        if (!config) issues.push({ table: 'game_events_cul', id: row.systemId })
        else if (config.taskDungeon && !cultivationGuideDungeon(tables, config.taskDungeon))
            issues.push({ table: 'dungeon', group_id: config.taskDungeon, difficulty: 1 })
    }
    return issues
}
