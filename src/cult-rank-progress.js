import fs from 'node:fs'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { configTime } from './shops.js'
import { activityTables } from './activity-tables.js'

const policy = JSON.parse(fs.readFileSync(new URL('../configs/cult-rank-policy.json', import.meta.url)))
const uint = (v) => Number.isSafeInteger(v) && v >= 0 && v <= 0xffffffff
const positive = (v) => Number.isSafeInteger(v) && v > 0
const plain = (v) => v && typeof v === 'object' && !Array.isArray(v)
const fail = (ok, text) => ensure(ok, text, ErrorCode.GameConfig)
const score = (v) => {
    fail(typeof v === 'string' && /^(0|[1-9]\d*)$/.test(v), 'Invalid cultivation rank score')
    const n = BigInt(v)
    fail(n <= 0x7fffffffffffffffn, 'Cultivation rank score exceeds Int64')
    return n
}
fail(
    policy.version === 1 && policy.officiallyVerified === false && Array.isArray(policy.periods),
    'Invalid cultivation rank policy',
)
const periods = policy.periods.map((p) => {
    fail(
        uint(p.activityId) && p.activityId > 0 && typeof p.key === 'string' && /^[a-z0-9-]{1,80}$/.test(p.key),
        'Invalid cultivation rank period',
    )
    const start = configTime(p.start),
        end = configTime(p.end)
    fail(uint(start) && uint(end) && end > start, 'Invalid cultivation rank period window')
    return { activity_id: p.activityId, period_key: p.key, start_time: start, end_time: end }
})
fail(new Set(periods.map((p) => p.period_key)).size === periods.length, 'Duplicate cultivation rank period')
for (const a of periods)
    for (const b of periods)
        if (a !== b && a.activity_id === b.activity_id)
            fail(a.end_time < b.start_time || b.end_time < a.start_time, 'Overlapping cultivation rank periods')

export function cultRankPeriod(activityId, now) {
    fail(uint(now), 'Invalid cultivation rank clock')
    return periods.find((p) => p.activity_id === activityId && now >= p.start_time && now <= p.end_time) ?? null
}
export function cultRankLedger(value) {
    if (value === undefined) return null
    fail(plain(value) && value.version === 1 && plain(value.periods), 'Invalid cultivation rank ledger')
    for (const [key, row] of Object.entries(value.periods)) {
        const p = periods.find((p) => p.period_key === key)
        fail(
            p &&
                plain(row) &&
                row.activity_id === p.activity_id &&
                row.period_key === key &&
                row.start_time === p.start_time &&
                row.end_time === p.end_time,
            'Cultivation rank period migration required',
        )
        fail(
            positive(row.last_instance) &&
                uint(row.last_time) &&
                row.last_time >= p.start_time &&
                row.last_time <= p.end_time,
            'Invalid cultivation rank settlement identity',
        )
        fail(score(row.best_score) >= score(row.last_score), 'Invalid cultivation rank best score')
    }
    return value
}
export function nextCultRankInstance(state) {
    const ledger = cultRankLedger(state.cultRankProgress),
        next = state.nextCultTrialInstanceId
    fail(next === undefined || positive(next), 'Invalid cultivation trial instance sequence')
    const live = state.cultTrial?.instance_id
    fail(live === undefined || positive(live), 'Invalid cultivation trial live instance')
    const n = Math.max(
        next ?? 1,
        (live ?? 0) + 1,
        ...Object.values(ledger?.periods ?? {}).map((p) => p.last_instance + 1),
    )
    fail(positive(n) && n < Number.MAX_SAFE_INTEGER, 'Cultivation trial instance exhausted')
    return n
}
export function acceptCultRankRun(catalog, row, trial, run, now) {
    const period = cultRankPeriod(row.id, now)
    if (!run.archive_id || trial.phase !== 4 || !period) return undefined
    const window = catalog.window(row, now)
    fail(
        window.start_time === period.start_time && window.end_time === period.end_time,
        'Cultivation rank calendar migration required',
    )
    fail(positive(run.instance_id) && uint(now), 'Invalid cultivation rank acceptance')
    return { version: 1, ...period, trial_id: trial.trialId, instance_id: run.instance_id, accepted_at: now }
}
export function recordCultRankResult(tables, state, run, now) {
    if (run.rank_acceptance === undefined) return false // No retrospective participation from an old run or best score.
    const a = run.rank_acceptance,
        p = periods.find((p) => p.period_key === a?.period_key)
    fail(
        plain(a) &&
            a.version === 1 &&
            p &&
            a.activity_id === p.activity_id &&
            a.start_time === p.start_time &&
            a.end_time === p.end_time &&
            a.instance_id === run.instance_id &&
            a.trial_id === run.trial_id &&
            uint(a.accepted_at) &&
            a.accepted_at >= p.start_time &&
            a.accepted_at <= p.end_time,
        'Invalid cultivation rank accepted context',
    )
    const current = activityTables(tables),
        event = current.get('game_events').find((x) => x.id === run.activity_id && x.type === 60)
    const trial =
        event &&
        current.get('game_events_cul_trial').find((x) => x.trialId === run.trial_id && x.systemId === event.systemId)
    fail(
        run.archive_id &&
            run.battle_complete &&
            run.activity_id === p.activity_id &&
            trial?.phase === 4 &&
            positive(run.instance_id),
        'Cultivation rank result has no accepted archive trial',
    )
    fail(uint(now) && now >= a.accepted_at, 'Invalid cultivation rank result time')
    const ledger = cultRankLedger(state.cultRankProgress)
    if (now > p.end_time) return false // Keep original score/reward; a closed period grants no new ranking fact.
    fail(Number.isSafeInteger(run.score ?? 0) && (run.score ?? 0) >= 0, 'Invalid actual cultivation rank score')
    const value = String(run.score ?? 0),
        n = score(value),
        old = ledger?.periods[p.period_key]
    if (old?.last_instance === run.instance_id) {
        fail(old.last_score === value, 'Cultivation rank instance score changed')
        return false
    }
    fail(!old || run.instance_id > old.last_instance, 'Cultivation rank instance regressed')
    const row = {
        ...p,
        best_score: String(old && score(old.best_score) > n ? old.best_score : value),
        last_instance: run.instance_id,
        last_score: value,
        last_time: now,
    }
    state.cultRankProgress = { version: 1, periods: { ...ledger?.periods, [p.period_key]: row } }
    fail(state.cultRankRevision === undefined || uint(state.cultRankRevision), 'Invalid cultivation rank revision')
    fail((state.cultRankRevision ?? 0) < 0xffffffff, 'Cultivation rank revision exhausted')
    state.cultRankRevision = (state.cultRankRevision ?? 0) + 1
    return true
}

const models = new WeakMap()
export function cultRankModel(tables, activityId) {
    let cache = models.get(tables)
    if (!cache) models.set(tables, (cache = new Map()))
    if (cache.has(activityId)) return cache.get(activityId)
    const current = activityTables(tables),
        activity = current.get('game_events').find((x) => x.id === activityId && x.type === 60)
    ensure(activity, 'No cultivation ranking activity', ErrorCode.NoActivityConf)
    const rows = current
        .get('game_events_cul_serverrank')
        .filter((x) => x.gameeventid === activity.systemId)
        .sort((a, b) => a.needscore - b.needscore)
    fail(
        rows.length >= 2 &&
            rows.every(
                (x, i) =>
                    uint(x.needscore) &&
                    uint(x.predictpercent) &&
                    x.predictpercent > 0 &&
                    x.predictpercent <= 10000 &&
                    [0, 1].includes(x.isrank) &&
                    (!i || (x.needscore > rows[i - 1].needscore && x.predictpercent <= rows[i - 1].predictpercent)),
            ) &&
            rows.at(-1).isrank === 1 &&
            rows.slice(0, -1).every((x) => x.isrank === 0),
        'Invalid cultivation ranking interpolation table',
    )
    const model = { activity, rows, boundary: rows.at(-1) }
    cache.set(activityId, model)
    return model
}
const ceil = (a, b) => (a + b - 1n) / b
export function cultRankSnapshot(store, tables, state, id, activityId, now) {
    const period = cultRankPeriod(activityId, now),
        model = cultRankModel(tables, activityId)
    if (!period) return null
    const ownRow = cultRankLedger(state.cultRankProgress)?.periods[period.period_key]
    const own = ownRow ? { score: score(ownRow.best_score) } : null
    if (!own || own.score < BigInt(model.rows[0].needscore)) return null
    if (own.score < BigInt(model.boundary.needscore)) {
        const i = model.rows.findLastIndex((x) => own.score >= BigInt(x.needscore)),
            a = model.rows[i],
            b = model.rows[i + 1],
            delta = BigInt(b.needscore - a.needscore)
        const g = ceil(
            BigInt(a.predictpercent) * delta -
                (own.score - BigInt(a.needscore)) * BigInt(a.predictpercent - b.predictpercent),
            delta,
        )
        return { ...period, score: String(own.score), ranked: false, qualification: Number(g) }
    }
    const participants = store.cultRankSnapshot(
        (value) => {
            const row = cultRankLedger(value)?.periods[period.period_key]
            return row ? { score: score(row.best_score) } : null
        },
        { id, state },
    )
    const ranked = [...participants.values()].filter((p) => p.score >= BigInt(model.boundary.needscore))
    const rank = 1 + ranked.filter((p) => p.score > own.score).length,
        count = ranked.length
    fail(count > 0, 'Cultivation rank population unavailable')
    const p = ceil(BigInt(rank) * 10000n, BigInt(count)),
        g = ceil(BigInt(model.boundary.predictpercent) * p, 10000n)
    return {
        ...period,
        score: String(own.score),
        ranked: true,
        rank,
        count,
        permyriad: Number(p),
        qualification: Number(g),
    }
}
