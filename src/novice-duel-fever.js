import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { arenaOutcomeTime } from './npc-kibo-outcome-time.js'
import { arenaStageBuffSchedule } from './npc-kibo-stage-buffs.js'
import { secondsToArenaMs } from './npc-kibo-time.js'

const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
const uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff

export function noviceDuelFeverRule(tokens) {
    return Array.isArray(tokens) && tokens.length === 2 && tokens[0] === 13058 && tokens[1] === 1
}

export function noviceDuelFeverValue(state) {
    const ledger = state.noviceDuelFeverWins
    if (ledger === undefined) return 0
    ensure(
        object(ledger) && ledger.version === 1 && uint(ledger.count) && uint(ledger.revision),
        'Invalid novice fever victory ledger',
        ErrorCode.GameConfig,
    )
    return ledger.count
}

// Local table-equivalent interpretation: fever at the real terminal instant,
// not at a delayed settlement tick. Official backend predicate is unrecovered.
export function recordNoviceDuelFeverOutcome(c, duel, outcome) {
    const state = c.state,
        run = state.combat.npcDuel
    ensure(
        !run.result &&
            run.duel_id === duel.id &&
            run.map_id === state.world.map_id &&
            state.multiCampaign?.duel_id === duel.id &&
            duel.type === 1 &&
            duel.duelMode === 1 &&
            Number.isSafeInteger(run.generation) &&
            run.generation > 0,
        'Invalid NPC fever outcome source',
        ErrorCode.GameConfig,
    )
    const phase = state.multiCampaign.arena_status
    // Preserve the existing explicit loss path before the regular clock starts.
    // This observer must not authorize early victories or manufacture facts.
    if ([2, 3, 6].includes(phase) && outcome.result === 2 && outcome.reason === 3) return false
    ensure(phase === 4, 'Invalid NPC fever outcome source', ErrorCode.GameConfig)
    const timing = arenaOutcomeTime(c, outcome)
    const elapsedMs = timing.known ? Math.max(0, timing.atMs - secondsToArenaMs(run.regular_started_at)) : null
    const fever =
        timing.known && arenaStageBuffSchedule(c.tables, duel.id).some((row) => elapsedMs >= secondsToArenaMs(row.at))
    const receipt = {
        version: 1,
        generation: run.generation,
        duelId: duel.id,
        result: outcome.result,
        reason: outcome.reason,
        known: timing.known,
        atMs: timing.atMs,
        elapsedMs,
        fever,
    }
    if (run.noviceFeverReceipt !== undefined) {
        ensure(
            object(run.noviceFeverReceipt) &&
                Object.keys(run.noviceFeverReceipt).length === Object.keys(receipt).length &&
                Object.entries(receipt).every(([key, value]) => run.noviceFeverReceipt[key] === value),
            'Conflicting NPC fever outcome receipt',
            ErrorCode.GameConfig,
        )
        return false
    }
    if (outcome.result === 1 && fever) {
        const count = noviceDuelFeverValue(state) + 1,
            revision = (state.noviceDuelFeverWins?.revision ?? 0) + 1
        ensure(uint(count) && uint(revision), 'Novice fever victory overflow', ErrorCode.GameConfig)
        state.noviceDuelFeverWins = { version: 1, revision, count }
    }
    state.combat = { ...state.combat, npcDuel: { ...run, noviceFeverReceipt: receipt } }
    return true
}
