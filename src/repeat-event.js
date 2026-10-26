import fs from 'node:fs'
import { WorldObjectCatalog } from './world-objects.js'
import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'
import { repeatStarTrustedCount, repeatStarWireRecord, sealRepeatStarProgress } from './repeat-star-progress.js'

const names = [
    'repeat_event_activity',
    'repeat_event_chapter',
    'repeat_event_level',
    'repeat_event_task',
    'dungeon',
    'dungeon_scene',
    'world_city',
    'stamina_chest_drop',
]
const rows = Object.fromEntries(
    names.map((name) => [
        name,
        JSON.parse(fs.readFileSync(new URL('../configs/repeat-event-tables/' + name + '.json', import.meta.url))),
    ]),
)
const adapters = new WeakMap()
export function repeatEventTables(external) {
    if (!adapters.has(external)) {
        const world = new WorldObjectCatalog(external)
        const get = (name) => (name.startsWith('worldmap_') ? world.get(name) : (rows[name] ?? external.get(name)))
        adapters.set(external, { get, find: (name, id) => get(name).find((row) => row.id === Number(id)) })
    }
    return adapters.get(external)
}
export function repeatDungeon(tables, dungeonId) {
    const current = repeatEventTables(tables)
    const level = current
        .get('repeat_event_level')
        .find((row) => row.normalDungeonId === dungeonId || row.hardDungeonId === dungeonId)
    if (!level) return null
    const dungeon = current.find('dungeon', dungeonId)
    ensure(dungeon, 'Repeat dungeon configuration unavailable', ErrorCode.DungeonConfNotExist)
    return { level, dungeon, tables: current }
}
export function repeatSnapshot(state, calendar, now) {
    return {
        finished_level_data: Object.values(state.repeatEvent?.levels ?? {}).map((record) => ({
            ...record,
            mode_save_data: record.mode_save_data.map((mode) =>
                repeatStarWireRecord(
                    state,
                    record.event_id,
                    record.level_id,
                    calendar &&
                        now !== undefined &&
                        mode.bonus_reward_fetch_time !== undefined &&
                        calendar.day(mode.bonus_reward_fetch_time) !== calendar.day(now)
                        ? { ...mode, bonus_reward_daily_count: 0 }
                        : mode,
                ),
            ),
        })),
    }
}
export function repeatModeRecord(state, eventId, levelId, mode) {
    return state.repeatEvent?.levels?.[eventId + ':' + levelId]?.mode_save_data?.find((row) => row.mode === mode)
}
export function repeatEntryPlan(c, request) {
    const tables = repeatEventTables(c.tables),
        { activity, chapter, level, mode } = request
    const activityRow = tables.get('repeat_event_activity').find((row) => row.gameEventsId === activity)
    ensure(activityRow, 'Repeat activity configuration unavailable', ErrorCode.RepeatEventLevelInvalidActivityConf)
    const event = c.activityCatalog.rows.find((row) => row.id === activity)
    ensure(event?.type === 100, 'Repeat event configuration unavailable', ErrorCode.RepeatEventLevelInvalidEventConf)
    const window = c.activityCatalog.window(event, c.now)
    ensure(
        c.now >= window.start_time && c.now <= window.end_time,
        'Repeat event is outside its schedule',
        ErrorCode.RepeatEventLevelTimeLimited,
    )
    ensure(c.activityCatalog.unlocked(event, c.state), 'Repeat event is locked', ErrorCode.RepeatEventLevelLocked)
    const chapterRow = tables.find('repeat_event_chapter', chapter)
    ensure(
        chapterRow?.group === activityRow.chapterGroup,
        'Repeat chapter configuration unavailable',
        ErrorCode.RepeatEventLevelInvalidChapterConf,
    )
    const levelRow = tables.find('repeat_event_level', level)
    ensure(
        levelRow?.group === chapterRow.levelGroup,
        'Repeat level configuration unavailable',
        ErrorCode.RepeatEventLevelInvalidLevelConf,
    )
    ensure(mode === 1 || mode === 2, 'Invalid repeat event mode', ErrorCode.RepeatEventLevelInvalidMode)
    ensure(mode !== 2 || levelRow.isHardOpen === 1, 'Repeat hard mode is disabled', ErrorCode.RepeatEventLevelDisabled)
    const previous = (row) => {
        if (!row.preLevel || !row.preLevelDiff) return true
        const saved = repeatModeRecord(c.state, activity, row.preLevel, row.preLevelDiff)
        // Validate typed integrity before either branch. Entry preserves any
        // legacy positive unlock while also accepting a new typed improvement.
        const trusted = repeatStarTrustedCount(saved)
        return (trusted ?? 0) > 0 || (saved?.star_count ?? 0) > 0
    }
    ensure(
        previous(chapterRow) && previous(levelRow),
        'Previous repeat level is incomplete',
        ErrorCode.RepeatEventLevelLocked,
    )
    const dungeonId = mode === 1 ? levelRow.normalDungeonId : levelRow.hardDungeonId
    ensure(
        Number.isSafeInteger(dungeonId) && dungeonId > 0,
        'Repeat dungeon configuration unavailable',
        ErrorCode.RepeatEventLevelInvalidMode,
    )
    return { dungeonId, activity, chapter, level, mode }
}
export function recordRepeatVictory(tables, state, run, { freshRepeatVictory = false } = {}) {
    const route = repeatDungeon(tables, run.dungeon_id),
        data = run.repeat_event
    ensure(
        route && data?.level === route.level.id,
        'Repeat run configuration mismatch',
        ErrorCode.RepeatEventLevelInvalidLevelConf,
    )
    const elapsed = run.end_time - run.battle_start_time
    const conditions = String(route.dungeon.challenge || '')
        .split('|')
        .filter(Boolean)
    let mask = 0
    conditions.forEach((condition, index) => {
        const parts = condition.split('#').map(Number),
            [kind, a, b] = parts
        const met =
            kind === 3006 && parts.length === 2
                ? elapsed <= a
                : kind === 60007 && parts.length === 3 && a === 0 && run.hero_deaths !== undefined
                  ? run.hero_deaths < b
                  : false
        if (met) mask |= 1 << index
    })
    run.star_mask = mask
    run.star = conditions.reduce((n, _, index) => n + ((mask >>> index) & 1), 0)
    const ledger = (state.repeatEvent = { ...state.repeatEvent, levels: { ...state.repeatEvent?.levels } })
    const key = data.activity + ':' + data.level,
        old = ledger.levels[key]
    const modes = structuredClone(old?.mode_save_data ?? []),
        previous = modes.find((row) => row.mode === data.mode)
    const next = {
        ...previous,
        mode: data.mode,
        star_count: Math.max(run.star, previous?.star_count ?? 0),
        pass_time: previous?.win_count ? Math.min(elapsed, previous.pass_time) : elapsed,
        win_count: (previous?.win_count ?? 0) + 1,
    }
    const progress = sealRepeatStarProgress(route.tables, state, run, previous, freshRepeatVictory)
    if (progress !== undefined) next.star_progress = progress
    // Unversioned data may have been a scalar or a wire mask. Preserve its exact
    // original field; only typed v1 data can affect the outgoing star mask.
    if (previous?.star_count !== undefined) next.star_count = previous.star_count
    else if (progress?.version === 1) next.star_count = progress.best_mask
    ensure(
        Number.isSafeInteger(next.win_count) && next.win_count <= 0xffffffff,
        'Repeat clear counter overflow',
        ErrorCode.GameConfig,
    )
    ledger.levels[key] = {
        event_id: data.activity,
        level_id: data.level,
        mode_save_data: [...modes.filter((row) => row.mode !== data.mode), next],
        public_data: { ...old?.public_data },
    }
}

function repeatTaskRows(tables, eventId) {
    const current = repeatEventTables(tables)
    const activity = current.get('repeat_event_activity').find((row) => row.gameEventsId === eventId)
    ensure(activity, 'Repeat task activity configuration unavailable', ErrorCode.RepeatEventLevelInvalidActivityConf)
    return current.get('repeat_event_task').filter((row) => row.group === activity.taskGroup)
}
export function repeatTaskSnapshot(tables, state) {
    const finished_task_data = []
    for (const event of repeatEventTables(tables).get('repeat_event_activity')) {
        const data = state.repeatEvent?.events?.[event.gameEventsId],
            stamina = data?.total_cost_stamina ?? 0
        ensure(
            Number.isSafeInteger(stamina) && stamina >= 0 && stamina <= 0xffffffff,
            'Invalid repeat stamina ledger',
            ErrorCode.GameConfig,
        )
        for (const task of repeatTaskRows(tables, event.gameEventsId)) {
            const parts = String(task.finishCondition).split('#').map(Number)
            const [kind, first, second, third] = parts
            const dungeon = kind === 12017 ? repeatEventTables(tables).find('dungeon', second) : null
            const target = kind === 11006 ? first : third
            ensure(
                ((kind === 11006 && parts.length === 2) ||
                    (kind === 12017 && parts.length === 4 && dungeon?.groupId === first)) &&
                    target > 0 &&
                    Number.isSafeInteger(target),
                'Unsupported repeat task condition',
                ErrorCode.RepeatEventLevelTaskConfigError,
            )
            // Same 12017 DungeonClear proof used by the task system: an actual
            // authoritative campaign receipt, never a client victory flag.
            const value = kind === 11006 ? stamina : (state.storyCampaignClears?.[second]?.count ?? 0)
            ensure(
                Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff,
                'Invalid repeat dungeon clear receipt',
                ErrorCode.GameConfig,
            )
            const claimed = data?.claimed_tasks?.includes(task.id) ?? false
            finished_task_data.push({
                event_id: event.gameEventsId,
                task_id: task.id,
                value,
                status: claimed ? 2 : value >= target ? 1 : 0,
            })
        }
    }
    return { finished_task_data }
}
// 11006 is the shared actual stamina-spend event. Count only its positive delta
// while this event is active, never a user's pre-existing aggregate at login.
export function observeRepeatStamina(c, before) {
    const delta = (c.state.noviceCounters?.staminaSpent ?? 0) - before.stamina
    if (delta <= 0) return
    ensure(Number.isSafeInteger(delta), 'Invalid repeat stamina event', ErrorCode.GameConfig)
    let changed = false
    for (const event of repeatEventTables(c.tables).get('repeat_event_activity')) {
        const configured = c.activityCatalog.rows.find((row) => row.id === event.gameEventsId)
        if (!configured || !c.activityCatalog.active(configured, c.state, c.now)) continue
        const ledger = (c.state.repeatEvent = { ...c.state.repeatEvent, events: { ...c.state.repeatEvent?.events } })
        const old = ledger.events[event.gameEventsId],
            total = (old?.total_cost_stamina ?? 0) + delta
        ensure(
            Number.isSafeInteger(total) && total <= 0xffffffff,
            'Repeat stamina counter overflow',
            ErrorCode.GameConfig,
        )
        ledger.events[event.gameEventsId] = { ...old, total_cost_stamina: total }
        changed = true
    }
    if (changed) c.pushBefore('CSProtoRepeatEventTaskModify', repeatTaskSnapshot(c.tables, c.state))
}
export function repeatClaimableTasks(c, requested) {
    ensure(
        Array.isArray(requested) &&
            requested.length <= 100 &&
            new Set(requested).size === requested.length &&
            requested.every((id) => Number.isSafeInteger(id) && id > 0),
        'Invalid repeat task selection',
        ErrorCode.RepeatEventLevelTaskConfigError,
    )
    const all = repeatTaskSnapshot(c.tables, c.state).finished_task_data
    const active = all.filter((row) => {
        const event = c.activityCatalog.rows.find((event) => event.id === row.event_id)
        return event && c.activityCatalog.active(event, c.state, c.now)
    })
    const selected = requested.length
        ? requested.map((id) => {
              const found = active.filter((row) => row.task_id === id)
              ensure(
                  found.length === 1,
                  'Repeat task configuration unavailable',
                  ErrorCode.RepeatEventLevelTaskConfigError,
              )
              ensure(found[0].status !== 0, 'Repeat task is incomplete', ErrorCode.RepeatEventLevelTaskNotDone)
              return found[0]
          })
        : active.filter((row) => row.status === 1)
    return selected
        .filter((row) => row.status === 1)
        .map((row) => ({
            ...row,
            config: repeatTaskRows(c.tables, row.event_id).find((task) => task.id === row.task_id),
        }))
}
