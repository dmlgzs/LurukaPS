import policy from '../configs/repeat-event-progress-policy.json' with { type: 'json' }
import { repeatEventTables } from './repeat-event.js'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
const positive = (value) => uint(value) && value > 0
const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
const catalogues = new WeakMap()

export function repeatClearModeSupported(row) {
    return (
        object(row) &&
        positive(row.normalDungeonId) &&
        uint(row.hardDungeonId) &&
        [0, 1].includes(row.isHardOpen) &&
        !(row.isHardOpen === 1 && row.hardDungeonId > 0)
    )
}

function catalogue(tables) {
    if (!catalogues.has(tables)) {
        ensure(
            policy.version === 1 &&
                policy.condition === 81000 &&
                policy.unit === 'one-actual-victory' &&
                policy.period === 'active-season-forever' &&
                policy.zeroSelector === 'only-single-enabled-normal-route' &&
                policy.nonzeroSelectorSupported === false &&
                policy.claimIndependent === true &&
                policy.oldSeasonBackfill === false &&
                policy.prefix === 'repeat-clear:' &&
                policy.officiallyVerified === false,
            'Invalid repeat clear progress policy',
            ErrorCode.GameConfig,
        )
        const current = repeatEventTables(tables)
        const activities = current.get('repeat_event_activity'),
            chapters = current.get('repeat_event_chapter')
        const rows = new Map()
        for (const row of current.get('repeat_event_level')) {
            ensure(
                positive(row.id) && positive(row.group) && !rows.has(row.id),
                'Invalid repeat clear level identity',
                ErrorCode.GameConfig,
            )
            const parents = chapters.filter((chapter) => chapter.levelGroup === row.group)
            ensure(
                parents.length === 1 && positive(parents[0].id) && positive(parents[0].group),
                'Ambiguous repeat clear chapter',
                ErrorCode.GameConfig,
            )
            const events = activities.filter((activity) => activity.chapterGroup === parents[0].group)
            ensure(
                events.length === 1 && positive(events[0].gameEventsId),
                'Ambiguous repeat clear activity',
                ErrorCode.GameConfig,
            )
            const event = tables.find('game_events', events[0].gameEventsId)
            ensure(
                event?.type === 100,
                'Repeat clear event configuration unavailable',
                ErrorCode.RepeatEventLevelInvalidEventConf,
            )
            const modes = []
            ensure(
                uint(row.normalDungeonId) && uint(row.hardDungeonId) && [0, 1].includes(row.isHardOpen),
                'Invalid repeat clear mode definitions',
                ErrorCode.GameConfig,
            )
            if (row.normalDungeonId > 0) modes.push(1)
            if (row.isHardOpen === 1 && row.hardDungeonId > 0) modes.push(2)
            ensure(modes.length > 0, 'Missing repeat clear route', ErrorCode.GameConfig)
            rows.set(row.id, {
                row,
                chapter: parents[0].id,
                event: events[0].gameEventsId,
                modes,
                singleNormal: repeatClearModeSupported(row),
            })
        }
        ensure(rows.size > 0, 'Missing repeat clear levels', ErrorCode.GameConfig)
        catalogues.set(tables, rows)
    }
    return catalogues.get(tables)
}

export function repeatClearRule(tables, tokens) {
    if (
        !Array.isArray(tokens) ||
        tokens.length !== 4 ||
        tokens[0] !== 81000 ||
        !positive(tokens[1]) ||
        tokens[2] !== 0 ||
        !positive(tokens[3])
    )
        return false
    return catalogue(tables).get(tokens[1])?.singleNormal ?? false
}

export function repeatClearRevision(state) {
    const value = state.repeatClearRevision === undefined ? 0 : state.repeatClearRevision
    ensure(uint(value), 'Invalid repeat clear revision', ErrorCode.GameConfig)
    return value
}

function validTuple(tables, tuple) {
    const row = catalogue(tables).get(tuple?.level)
    ensure(
        row && tuple.event === row.event && row.modes.includes(tuple.mode),
        'Invalid repeat clear source tuple',
        ErrorCode.GameConfig,
    )
    return row
}

export function repeatClearKey(tables, tuple) {
    validTuple(tables, tuple)
    return policy.prefix + [tuple.event, tuple.level, tuple.mode].join(':')
}

export function repeatClearMatches(tables, tokens, tuple) {
    if (!repeatClearRule(tables, tokens)) return false
    return validTuple(tables, tuple).singleNormal && tuple.level === tokens[1] && tuple.mode === 1
}

export function repeatClearPeriodValue(tables, counts, tokens) {
    if (!repeatClearRule(tables, tokens)) return null
    ensure(object(counts), 'Invalid repeat clear period counts', ErrorCode.GameConfig)
    let value = 0
    for (const [key, count] of Object.entries(counts)) {
        if (!key.startsWith(policy.prefix)) continue
        const raw = key.slice(policy.prefix.length).split(':'),
            numbers = raw.map(Number)
        ensure(
            raw.length === 3 && numbers.every((number, index) => positive(number) && String(number) === raw[index]),
            'Malformed repeat clear period key',
            ErrorCode.GameConfig,
        )
        const [event, level, mode] = numbers
        validTuple(tables, { event, level, mode })
        ensure(uint(count), 'Invalid repeat clear period count', ErrorCode.GameConfig)
        if (level !== tokens[1] || mode !== 1) continue
        ensure(value + count <= 0xffffffff, 'Repeat clear period overflow', ErrorCode.GameConfig)
        value += count
    }
    // Old scalar81000 and all lifetime win_count/first-pass records are not
    // season-qualified sources and must never be projected into this value.
    return Math.min(tokens[3], value)
}

export function recordRepeatClear(tables, state, run, route, now, fresh) {
    if (!fresh) return null
    const data = run?.repeat_event,
        member = catalogue(tables).get(data?.level)
    const dungeon = data?.mode === 1 ? member?.row.normalDungeonId : member?.row.hardDungeonId
    ensure(
        member &&
            object(data) &&
            run.kind === 'repeat' &&
            member.modes.includes(data.mode) &&
            data.activity === member.event &&
            data.chapter === member.chapter &&
            (data.dungeonId === undefined || data.dungeonId === dungeon) &&
            route?.repeat?.level.id === data.level &&
            route.repeat.dungeon.id === dungeon &&
            run.entrust_id === dungeon &&
            run.dungeon_id === dungeon &&
            route.dungeon.id === dungeon &&
            run.map_id === route.scene.id &&
            state.world.map_id === run.map_id &&
            positive(run.instance_id) &&
            run.battle_complete === true &&
            Number.isSafeInteger(now) &&
            now >= 0 &&
            run.end_time === now &&
            Number.isSafeInteger(run.battle_start_time) &&
            run.battle_start_time > 0 &&
            run.battle_start_time <= now,
        'Repeat clear source does not match its run',
        ErrorCode.GameConfig,
    )
    // Future multi-mode routes remain playable through their original source,
    // but this unproved zero-selector projection stays explicitly closed.
    if (!member.singleNormal) return null
    const revision = repeatClearRevision(state)
    ensure(revision < 0xffffffff, 'Repeat clear revision overflow', ErrorCode.GameConfig)
    state.repeatClearRevision = revision + 1
    return { event: data.activity, level: data.level, mode: data.mode }
}
