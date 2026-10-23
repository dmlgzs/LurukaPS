import fs from 'node:fs'
import { WorldObjectCatalog } from './world-objects.js'
import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'

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
export function repeatSnapshot(state) {
    return { finished_level_data: Object.values(state.repeatEvent?.levels ?? {}) }
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
    const previous = (row) =>
        !row.preLevel ||
        !row.preLevelDiff ||
        (repeatModeRecord(c.state, activity, row.preLevel, row.preLevelDiff)?.star_count ?? 0) > 0
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
export function recordRepeatVictory(tables, state, run) {
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
