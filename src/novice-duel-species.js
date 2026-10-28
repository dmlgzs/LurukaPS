import { readFileSync } from 'node:fs'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { arenaOutcomeTime } from './npc-kibo-outcome-time.js'
import { noviceNpcDeploymentFacts, noviceNpcFactQualifies } from './novice-duel-events.js'

const policy = JSON.parse(readFileSync(new URL('../configs/novice-duel-species-policy.json', import.meta.url), 'utf8'))
const uint = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff
const positive = (n) => uint(n) && n > 0
const object = (v) => v && typeof v === 'object' && !Array.isArray(v)

function validatePolicy() {
    ensure(
        policy.version === 1 &&
            policy.enabled === true &&
            policy.conditionKind === 13057 &&
            policy.distinctBy === 'accepted-config-id' &&
            policy.requiredSpecies === 8 &&
            policy.requiredWins === 1 &&
            policy.ownedAndLegalTrial === true &&
            policy.sameSpeciesMerged === true &&
            policy.officiallyVerified === false,
        'Unsupported novice distinct-species policy',
        ErrorCode.GameConfig,
    )
}

function ledger(state) {
    const saved = state.noviceDuelSpeciesWins
    if (saved === undefined) return null
    ensure(
        object(saved) && saved.version === 1 && uint(saved.revision) && object(saved.counts),
        'Invalid novice distinct-species wins',
        ErrorCode.GameConfig,
    )
    for (const [key, count] of Object.entries(saved.counts))
        ensure(
            /^[1-9][0-9]*$/.test(key) && positive(Number(key)) && uint(count),
            'Invalid novice distinct-species counter',
            ErrorCode.GameConfig,
        )
    return saved
}

export function noviceDuelSpeciesRule(tokens) {
    validatePolicy()
    return (
        Array.isArray(tokens) &&
        tokens.length === 3 &&
        tokens[0] === policy.conditionKind &&
        tokens[1] === policy.requiredSpecies &&
        tokens[2] === policy.requiredWins
    )
}

export function noviceDuelSpeciesValue(state, required) {
    validatePolicy()
    ensure(required === policy.requiredSpecies, 'Unsupported novice species threshold', ErrorCode.GameConfig)
    let value = 0
    for (const [species, wins] of Object.entries(ledger(state)?.counts ?? {}))
        if (Number(species) >= required) value += wins
    ensure(uint(value), 'Novice distinct-species total overflow', ErrorCode.GameConfig)
    return value
}

// Human-approved local policy, not a recovered official backend predicate.
// Reuse the same accepted-time/first-outcome gate as tag and skill wins.
export function recordNoviceNpcSpeciesWin(c, duel, outcome) {
    validatePolicy()
    const state = c.state,
        run = state.combat?.npcDuel
    ensure(
        run &&
            !run.result &&
            outcome.result === 1 &&
            run.duel_id === duel.id &&
            run.map_id === state.world.map_id &&
            state.multiCampaign?.duel_id === duel.id &&
            state.multiCampaign?.arena_status === 4 &&
            duel.type === 1 &&
            duel.duelMode === 1 &&
            positive(run.generation),
        'Invalid novice distinct-species victory source',
        ErrorCode.GameConfig,
    )
    const timing = arenaOutcomeTime(c, outcome),
        species = new Set()
    for (const row of noviceNpcDeploymentFacts(run)) {
        const actor = run.actors[row.uuid]
        ensure(
            actor?.camp === 1 && actor.source_guid === row.sourceGuid && actor.config_id === row.configId,
            'Novice species deployment no longer matches its roster',
            ErrorCode.GameConfig,
        )
        if (noviceNpcFactQualifies(run, timing, row)) species.add(row.configId)
    }
    const configIds = [...species].sort((a, b) => a - b),
        receipt = { version: 1, generation: run.generation, duelId: duel.id, configIds, qualificationTime: timing }
    if (run.noviceSpeciesVictoryReceipt !== undefined) {
        ensure(
            JSON.stringify(run.noviceSpeciesVictoryReceipt) === JSON.stringify(receipt),
            'Conflicting novice distinct-species victory receipt',
            ErrorCode.GameConfig,
        )
        return false
    }
    const saved = ledger(state)
    if (configIds.length) {
        const count = (saved?.counts[configIds.length] ?? 0) + 1,
            revision = (saved?.revision ?? 0) + 1
        ensure(uint(count) && uint(revision), 'Novice distinct-species win overflow', ErrorCode.GameConfig)
        state.noviceDuelSpeciesWins = { version: 1, revision, counts: { ...saved?.counts, [configIds.length]: count } }
    }
    state.combat = { ...state.combat, npcDuel: { ...run, noviceSpeciesVictoryReceipt: receipt } }
    return true
}
