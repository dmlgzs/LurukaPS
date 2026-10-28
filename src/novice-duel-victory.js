import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
const object = (value) => value && typeof value === 'object' && !Array.isArray(value)

function ledger(state) {
    const value = state.noviceDuelVictory
    if (value === undefined) return null
    ensure(
        object(value) && value.version === 1 && uint(value.revision) && object(value.counts),
        'Invalid novice duel victory ledger',
        ErrorCode.GameConfig,
    )
    for (const [key, count] of Object.entries(value.counts)) {
        const parts = key.split(':')
        ensure(
            parts.length === 2 &&
                parts.every((part) => /^(0|[1-9][0-9]*)$/.test(part)) &&
                uint(Number(parts[0])) &&
                Number(parts[0]) > 0 &&
                uint(Number(parts[1])) &&
                Number(parts[1]) <= 3 &&
                uint(count),
            'Invalid novice duel victory counter',
            ErrorCode.GameConfig,
        )
    }
    return value
}

// Current 2451868 references use a real nonzero area and star selector 0/3.
// Area0 and other selector semantics have no recovered backend contract.
export function noviceDuelVictoryRule(tables, tokens) {
    return (
        Array.isArray(tokens) &&
        tokens.length === 4 &&
        tokens[0] === 13053 &&
        tokens.every(Number.isSafeInteger) &&
        tokens[1] > 0 &&
        tables.get('kibo_duel_area_type').some((row) => row.Id === tokens[1]) &&
        [0, 3].includes(tokens[2]) &&
        tokens[3] > 0 &&
        tokens[3] <= 0xffffffff
    )
}

export function noviceDuelVictoryValue(state, area, stars) {
    const saved = ledger(state)
    let value = 0
    for (const [key, count] of Object.entries(saved?.counts ?? {})) {
        const [recordArea, recordStars] = key.split(':').map(Number)
        if (recordArea === area && recordStars >= stars) value += count
    }
    ensure(uint(value), 'Novice duel victory total overflow', ErrorCode.GameConfig)
    return value
}

// Local configuration-equivalent policy: one genuinely new NPC win counts
// once, including a new replay of the same duel. Never reconstruct old wins
// from first-clear records or the accumulated challenge mask.
export function recordNoviceDuelVictory(c, duel, mask) {
    const state = c.state,
        run = state.combat?.npcDuel
    ensure(
        run &&
            !run.result &&
            run.duel_id === duel.id &&
            run.map_id === state.world.map_id &&
            state.multiCampaign?.duel_id === duel.id &&
            state.multiCampaign?.arena_status === 4 &&
            duel.type === 1 &&
            duel.duelMode === 1 &&
            Number.isSafeInteger(run.generation) &&
            run.generation > 0,
        'Invalid novice NPC victory source',
        ErrorCode.GameConfig,
    )
    ensure(
        uint(duel.areaType) &&
            duel.areaType > 0 &&
            c.tables.get('kibo_duel_area_type').some((row) => row.Id === duel.areaType),
        'Invalid novice NPC victory area',
        ErrorCode.GameConfig,
    )
    const goals = String(duel.challenge || '')
        .split('|')
        .filter(Boolean)
    ensure(
        goals.length <= 3 && uint(mask) && mask < 2 ** goals.length,
        'Invalid novice NPC victory challenge mask',
        ErrorCode.GameConfig,
    )
    const stars = [...mask.toString(2)].filter((bit) => bit === '1').length,
        receipt = { version: 1, generation: run.generation, duelId: duel.id, area: duel.areaType, mask, stars }
    if (run.noviceVictoryReceipt !== undefined) {
        ensure(
            object(run.noviceVictoryReceipt) &&
                Object.keys(run.noviceVictoryReceipt).length === Object.keys(receipt).length &&
                Object.entries(receipt).every(([key, value]) => run.noviceVictoryReceipt[key] === value),
            'Conflicting novice NPC victory receipt',
            ErrorCode.GameConfig,
        )
        return false
    }
    const old = ledger(state),
        counts = { ...old?.counts },
        key = `${duel.areaType}:${stars}`,
        count = (counts[key] ?? 0) + 1,
        revision = (old?.revision ?? 0) + 1
    ensure(uint(count) && uint(revision), 'Novice duel victory counter overflow', ErrorCode.GameConfig)
    counts[key] = count
    state.noviceDuelVictory = { version: 1, revision, counts }
    state.combat = { ...state.combat, npcDuel: { ...run, noviceVictoryReceipt: receipt } }
    return true
}
