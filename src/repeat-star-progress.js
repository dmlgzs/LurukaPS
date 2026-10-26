import policy from '../configs/repeat-star-progress-policy.json' with { type: 'json' }
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
const positive = (value) => uint(value) && value > 0
const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
const warned = new Set()
ensure(
    policy.version === 1 &&
        policy.officiallyVerified === false &&
        policy.newFacts === 'fresh-server-verified-single-victory' &&
        policy.bestResult === 'highest-single-run-star-count' &&
        policy.equalCountMaskTie === 'larger-single-mask-without-or' &&
        policy.legacy === 'preserve-unversioned-star-count-no-trusted-backfill' &&
        policy.wire === 'project-v1-mask-only' &&
        policy.zeroSelector === 'only-single-enabled-normal-route' &&
        typeof policy.consumerEnabled === 'boolean',
    'Invalid repeat star progress policy',
    ErrorCode.GameConfig,
)

export function repeatStarCount(mask) {
    ensure(uint(mask) && mask <= 7, 'Malformed repeat star mask', ErrorCode.GameConfig)
    return (mask & 1) + ((mask >>> 1) & 1) + ((mask >>> 2) & 1)
}

function warnOnce(state, eventId, levelId, mode, reason) {
    const accountId = state.player?.basic_info?.id ?? 0
    const key = [accountId, eventId, levelId, mode, reason].join(':')
    if (warned.has(key)) return
    warned.add(key)
    console.warn(
        '[repeat-star-progress]',
        JSON.stringify({
            event: 'unclassified-star-source',
            accountId,
            eventId,
            levelId,
            mode,
            reason,
            action: 'legacy-values-and-rewards-preserved-no-trusted-backfill',
        }),
    )
}

function trusted(mode) {
    const source = mode?.star_progress
    if (source === undefined || !object(source) || source.version !== 1) return null
    ensure(
        uint(source.best_mask) &&
            source.best_mask <= 7 &&
            uint(source.best_count) &&
            source.best_count <= 3 &&
            repeatStarCount(source.best_mask) === source.best_count,
        'Malformed versioned repeat star progress',
        ErrorCode.GameConfig,
    )
    return source
}

export function repeatStarTrustedCount(mode) {
    return trusted(mode)?.best_count ?? null
}

export function repeatStarWireRecord(state, eventId, levelId, mode) {
    const source = trusted(mode)
    const { star_progress: internal, ...wire } = mode
    if (source) return { ...wire, star_count: source.best_mask }
    if (mode?.star_count !== undefined || mode?.star_progress !== undefined)
        warnOnce(state, eventId, levelId, mode?.mode, 'unversioned-or-unknown-format')
    return internal === undefined ? mode : wire
}

export function sealRepeatStarProgress(tables, state, run, previous, fresh) {
    // This argument is supplied solely by the existing real death-witness chain.
    // Login/load/settlement replay never upgrades a legacy value by inference.
    if (!fresh) return previous?.star_progress
    const data = run?.repeat_event
    const row = tables.find('repeat_event_level', data?.level)
    ensure(row, 'Repeat star level configuration unavailable', ErrorCode.RepeatEventLevelInvalidLevelConf)
    const chapters = tables.get('repeat_event_chapter').filter((chapter) => chapter.levelGroup === row.group)
    ensure(chapters.length === 1 && positive(chapters[0].id), 'Ambiguous repeat star chapter', ErrorCode.GameConfig)
    const activities = tables
        .get('repeat_event_activity')
        .filter((activity) => activity.chapterGroup === chapters[0].group)
    ensure(
        activities.length === 1 && positive(activities[0].gameEventsId),
        'Ambiguous repeat star activity',
        ErrorCode.GameConfig,
    )
    ensure(
        object(data) &&
            run.kind === 'repeat' &&
            data.activity === activities[0].gameEventsId &&
            data.chapter === chapters[0].id &&
            data.level === row.id &&
            [1, 2].includes(data.mode) &&
            run.battle_complete === true &&
            positive(run.instance_id) &&
            Number.isSafeInteger(run.end_time) &&
            Number.isSafeInteger(run.battle_start_time) &&
            run.battle_start_time > 0 &&
            run.end_time >= run.battle_start_time,
        'Repeat star source does not match its completed run',
        ErrorCode.GameConfig,
    )
    const dungeonId = data.mode === 1 ? row.normalDungeonId : row.hardDungeonId
    ensure(
        positive(dungeonId) && run.dungeon_id === dungeonId && run.entrust_id === dungeonId,
        'Repeat star source dungeon mismatch',
        ErrorCode.RepeatEventLevelInvalidLevelConf,
    )
    // A future multi-mode route remains playable, but this unproved selector
    // policy must not silently acquire new semantics or fabricate new facts.
    if (!(data.mode === 1 && positive(row.normalDungeonId) && !(row.isHardOpen === 1 && row.hardDungeonId > 0))) {
        warnOnce(state, data.activity, data.level, data.mode, 'unsupported-multiple-mode-projection')
        return previous?.star_progress
    }
    if (
        previous?.star_progress !== undefined &&
        (!object(previous.star_progress) || previous.star_progress.version !== 1)
    ) {
        warnOnce(state, data.activity, data.level, data.mode, 'unknown-source-version')
        return previous.star_progress
    }
    const count = repeatStarCount(run.star_mask)
    ensure(count === run.star, 'Repeat star scalar and mask disagree', ErrorCode.GameConfig)
    const old = trusted(previous)
    if (old && (old.best_count > count || (old.best_count === count && old.best_mask >= run.star_mask))) return old
    if (previous?.star_count !== undefined && !old)
        warnOnce(state, data.activity, data.level, data.mode, 'unversioned-or-unknown-format')
    return { version: 1, best_count: count, best_mask: run.star_mask }
}
