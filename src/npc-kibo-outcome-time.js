import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { arenaMillis, secondsToArenaMs } from './npc-kibo-time.js'

const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
const uint = (value) => Number.isSafeInteger(value) && value >= 0

export function arenaScoreOutcome(run) {
    const saved = run?.scoreOutcome
    if (saved === undefined) return null
    ensure(
        object(saved) &&
            saved.version === 1 &&
            uint(saved.atMs) &&
            [1, 2, 3].includes(saved.result) &&
            saved.reason === 1 &&
            ['passive', 'death'].includes(saved.source) &&
            object(saved.scores) &&
            [1, 2].every((camp) => uint(saved.scores[camp])),
        'Invalid NPC score outcome time',
        ErrorCode.GameConfig,
    )
    const expected = saved.scores[1] === 0 ? (saved.scores[2] === 0 ? 3 : 2) : saved.scores[2] === 0 ? 1 : 0
    ensure(
        expected === saved.result &&
            saved.atMs >= secondsToArenaMs(run.regular_started_at) &&
            saved.atMs <= secondsToArenaMs(run.end_at),
        'NPC score outcome contradicts its clock or scores',
        ErrorCode.GameConfig,
    )
    return saved
}

// First accepted terminal event wins. A late request cannot rewrite it.
export function sealArenaScoreOutcome(run, atMs, scores, source) {
    if (arenaScoreOutcome(run)) return run
    if (scores[1] > 0 && scores[2] > 0) return run
    const result = scores[1] === 0 ? (scores[2] === 0 ? 3 : 2) : 1
    const next = { ...run, scoreOutcome: { version: 1, atMs, result, reason: 1, scores: { ...scores }, source } }
    arenaScoreOutcome(next)
    return next
}

export function arenaOutcomeTime(c, outcome) {
    const run = c.state.combat.npcDuel
    const saved = arenaScoreOutcome(run)
    if (saved && outcome.reason === 1 && outcome.result === saved.result) return { known: true, atMs: saved.atMs }
    if (outcome.reason === 2 && !run.pause && c.now >= run.end_at)
        return { known: true, atMs: secondsToArenaMs(run.end_at) }
    if (outcome.reason === 3)
        return { known: true, atMs: run.pause ? secondsToArenaMs(run.pause.server_at) : arenaMillis(c) }
    // Legacy zero scores have no evidence of when they first became zero.
    return { known: false, atMs: null }
}
