import policy from '../configs/activity-repeat-star-policy.json' with { type: 'json' }
import { repeatEventTables } from './repeat-event.js'
import { repeatStarTrustedCount, repeatStarWireRecord } from './repeat-star-progress.js'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
const positive = (value) => uint(value) && value > 0
const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
const caches = new WeakMap()
ensure(
    policy.version === 1 &&
        policy.condition === 81002 &&
        policy.enabled === true &&
        policy.officiallyVerified === false &&
        policy.unit === 'distinct-configured-levels-at-highest-single-run-three-stars' &&
        policy.requiredStarCount === 3 &&
        policy.zeroSelector === 'only-single-enabled-normal-route' &&
        policy.sourceSchemaVersion === 1 &&
        policy.legacyBackfill === false &&
        policy.loopEventsSupported === false,
    'Invalid activity repeat star policy',
    ErrorCode.GameConfig,
)

export function activityRepeatNormalRoute(row) {
    return (
        object(row) &&
        positive(row.normalDungeonId) &&
        uint(row.hardDungeonId) &&
        [0, 1].includes(row.isHardOpen) &&
        !(row.isHardOpen === 1 && row.hardDungeonId > 0)
    )
}

function levelsFor(tables, activityId) {
    let events = caches.get(tables)
    if (!events) caches.set(tables, (events = new Map()))
    if (events.has(activityId)) return events.get(activityId)
    const event = tables.find('game_events', activityId)
    if (event?.type !== 100 || event.loopType !== 0) return null
    const current = repeatEventTables(tables)
    const activities = current.get('repeat_event_activity').filter((row) => row.gameEventsId === activityId)
    ensure(
        activities.length === 1 && positive(activities[0].chapterGroup),
        'Invalid repeat star activity membership',
        ErrorCode.GameConfig,
    )
    const chapters = current.get('repeat_event_chapter').filter((row) => row.group === activities[0].chapterGroup)
    ensure(
        chapters.length > 0 &&
            chapters.every((row) => positive(row.id) && positive(row.levelGroup)) &&
            new Set(chapters.map((row) => row.id)).size === chapters.length &&
            new Set(chapters.map((row) => row.levelGroup)).size === chapters.length,
        'Invalid repeat star chapter membership',
        ErrorCode.GameConfig,
    )
    const groups = new Set(chapters.map((row) => row.levelGroup))
    const levels = current.get('repeat_event_level').filter((row) => groups.has(row.group))
    ensure(
        levels.length > 0 &&
            levels.every(
                (row) =>
                    positive(row.id) &&
                    positive(row.group) &&
                    uint(row.normalDungeonId) &&
                    uint(row.hardDungeonId) &&
                    [0, 1].includes(row.isHardOpen),
            ) &&
            new Set(levels.map((row) => row.id)).size === levels.length,
        'Invalid repeat star level membership',
        ErrorCode.GameConfig,
    )
    if (!levels.every(activityRepeatNormalRoute)) return null
    for (const row of levels)
        ensure(
            current.find('dungeon', row.normalDungeonId),
            'Missing repeat star normal dungeon configuration',
            ErrorCode.GameConfig,
        )
    events.set(activityId, levels)
    return levels
}

export function activityRepeatStarValue(tables, state, tokens, activityId) {
    if (
        !Array.isArray(tokens) ||
        tokens.length !== 3 ||
        tokens[0] !== 81002 ||
        tokens[1] !== 0 ||
        !positive(tokens[2]) ||
        !positive(activityId)
    )
        return null
    const levels = levelsFor(tables, activityId)
    if (!levels) return null
    const saved = state.repeatEvent
    ensure(saved === undefined || object(saved), 'Malformed repeat activity progress', ErrorCode.GameConfig)
    const records = saved?.levels
    ensure(records === undefined || object(records), 'Malformed repeat activity level records', ErrorCode.GameConfig)
    if (records === undefined) return 0
    let count = 0
    for (const level of levels) {
        const record = records[activityId + ':' + level.id]
        if (record === undefined) continue
        ensure(
            object(record) &&
                record.event_id === activityId &&
                record.level_id === level.id &&
                Array.isArray(record.mode_save_data),
            'Repeat activity level record identity mismatch',
            ErrorCode.GameConfig,
        )
        const modes = record.mode_save_data
        ensure(
            modes.every((row) => object(row) && positive(row.mode)) &&
                new Set(modes.map((row) => row.mode)).size === modes.length,
            'Malformed or duplicate repeat activity modes',
            ErrorCode.GameConfig,
        )
        const normal = modes.find((row) => row.mode === 1)
        if (!normal) continue
        const stars = repeatStarTrustedCount(normal)
        if (stars === null) {
            // Reuses the source's once-per-process diagnostic without trusting
            // or rewriting its unversioned raw value or unknown version.
            repeatStarWireRecord(state, activityId, level.id, normal)
            continue
        }
        ensure(positive(normal.win_count), 'Versioned repeat stars have no victory receipt', ErrorCode.GameConfig)
        if (stars === policy.requiredStarCount) count++
    }
    return count
}
