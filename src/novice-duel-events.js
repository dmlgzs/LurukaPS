import { ErrorCode } from './error-codes.js'
import { arenaOutcomeTime, arenaScoreOutcome } from './npc-kibo-outcome-time.js'
import { ensure } from './handlers/common.js'

const uint = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff
const positive = (n) => uint(n) && n > 0
const safePositive = (n) => Number.isSafeInteger(n) && n > 0
const object = (v) => v && typeof v === 'object' && !Array.isArray(v)
const uuid = (v) => typeof v === 'string' && /^[1-9][0-9]*$/.test(v) && BigInt(v) <= 0xffffffffffffffffn
const numericKey = (v) => typeof v === 'string' && /^[1-9][0-9]*$/.test(v) && positive(Number(v))

// Untimed legacy facts remain readable but cannot mint new qualified wins.
function timedFact(row) {
    return (
        (row.acceptedAtMs === undefined && row.terminalAlreadyKnown === undefined) ||
        (Number.isSafeInteger(row.acceptedAtMs) &&
            row.acceptedAtMs >= 0 &&
            typeof row.terminalAlreadyKnown === 'boolean')
    )
}

function facts(run) {
    const saved = run.noviceEventFacts
    if (saved === undefined) return { version: 1, deployments: {}, casts: {} }
    ensure(
        object(saved) && saved.version === 1 && object(saved.deployments) && object(saved.casts),
        'Invalid novice NPC event facts',
        ErrorCode.GameConfig,
    )
    for (const [key, row] of Object.entries(saved.deployments))
        ensure(
            uuid(key) &&
                object(row) &&
                row.uuid === key &&
                uuid(row.sourceGuid) &&
                positive(row.configId) &&
                Array.isArray(row.tags) &&
                row.tags.every(positive) &&
                new Set(row.tags).size === row.tags.length &&
                timedFact(row),
            'Invalid novice NPC deployment fact',
            ErrorCode.GameConfig,
        )
    for (const [key, row] of Object.entries(saved.casts))
        ensure(
            /^[1-9][0-9]*$/.test(key) &&
                safePositive(Number(key)) &&
                object(row) &&
                row.serial === Number(key) &&
                positive(row.skillId) &&
                timedFact(row),
            'Invalid novice NPC skill fact',
            ErrorCode.GameConfig,
        )
    return saved
}

export function recordNoviceNpcDeployment(tables, run, actor, acceptedAtMs) {
    if (actor.camp !== 1) return run
    ensure(
        run.actors?.[actor.uuid] === actor && uuid(actor.uuid) && uuid(actor.source_guid) && positive(actor.config_id),
        'Invalid novice NPC deployed actor',
        ErrorCode.GameConfig,
    )
    ensure(
        Number.isSafeInteger(acceptedAtMs) && acceptedAtMs >= 0,
        'Invalid NPC deployment acceptance time',
        ErrorCode.GameConfig,
    )
    const saved = facts(run),
        old = saved.deployments[actor.uuid]
    if (old) {
        ensure(
            old.sourceGuid === actor.source_guid && old.configId === actor.config_id,
            'Conflicting novice NPC deployment identity',
            ErrorCode.GameConfig,
        )
        return run
    }
    const pet = tables.find('pet', actor.config_id)
    ensure(pet, 'Novice NPC deployment template missing', ErrorCode.GameConfig)
    const tags = [
        ...new Set(
            String(pet.kiboDuelTag ?? '')
                .split('|')
                .filter(Boolean)
                .map(Number),
        ),
    ].sort((a, b) => a - b)
    ensure(tags.every(positive), 'Invalid novice NPC deployment tags', ErrorCode.GameConfig)
    // Runtime UUID is stable for recall/redeploy. Preserve the full source
    // UInt64 separately: two legal trial slots must not collapse by trial key.
    return {
        ...run,
        noviceEventFacts: {
            ...saved,
            deployments: {
                ...saved.deployments,
                [actor.uuid]: {
                    uuid: actor.uuid,
                    sourceGuid: actor.source_guid,
                    configId: actor.config_id,
                    tags,
                    acceptedAtMs,
                    terminalAlreadyKnown: !!arenaScoreOutcome(run),
                },
            },
        },
    }
}

export function recordNoviceNpcAcceptedSkill(run, skillId, serial, acceptedAtMs) {
    ensure(
        positive(skillId) &&
            safePositive(serial) &&
            run.trainer_cast_serial === serial &&
            Number.isSafeInteger(acceptedAtMs) &&
            acceptedAtMs >= 0,
        'Invalid novice NPC accepted skill',
        ErrorCode.GameConfig,
    )
    const saved = facts(run),
        old = saved.casts[serial]
    if (old) {
        ensure(old.skillId === skillId, 'Conflicting novice NPC cast serial', ErrorCode.GameConfig)
        return run
    }
    return {
        ...run,
        noviceEventFacts: {
            ...saved,
            casts: {
                ...saved.casts,
                [serial]: { skillId, serial, acceptedAtMs, terminalAlreadyKnown: !!arenaScoreOutcome(run) },
            },
        },
    }
}

function ledger(state) {
    const saved = state.noviceDuelEventWins
    if (saved === undefined) return null
    ensure(
        object(saved) && saved.version === 1 && uint(saved.revision) && object(saved.counts),
        'Invalid novice NPC event wins',
        ErrorCode.GameConfig,
    )
    for (const [key, count] of Object.entries(saved.counts)) {
        const p = key.split(':')
        ensure(
            p.length === 3 && ['13055', '13056'].includes(p[0]) && numericKey(p[1]) && numericKey(p[2]) && uint(count),
            'Invalid novice NPC event win counter',
            ErrorCode.GameConfig,
        )
    }
    return saved
}

export function noviceNpcEventRule(tables, tokens) {
    if (
        !Array.isArray(tokens) ||
        tokens.length !== 4 ||
        ![13055, 13056].includes(tokens[0]) ||
        !tokens.slice(1).every(positive)
    )
        return false
    return tokens[0] === 13055
        ? tables.get('pet').some((pet) =>
              String(pet.kiboDuelTag ?? '')
                  .split('|')
                  .map(Number)
                  .includes(tokens[1]),
          )
        : tables.get('kibo_duel_skill').some((skill) => skill.skillId === tokens[1])
}

export function noviceNpcEventValue(state, kind, selector, required) {
    const saved = ledger(state)
    let value = 0
    for (const [key, count] of Object.entries(saved?.counts ?? {})) {
        const [recordKind, recordSelector, achieved] = key.split(':').map(Number)
        if (recordKind === kind && recordSelector === selector && achieved >= required) value += count
    }
    ensure(uint(value), 'Novice NPC event win total overflow', ErrorCode.GameConfig)
    return value
}

// Local reader-equivalent policy: distinct actually deployed runtime actors
// and accepted trainer casts qualify a new victorious run. No old match,
// roster, recent trace or first-clear record is backfilled into these facts.
export function recordNoviceNpcEventWin(c, duel, outcome) {
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
            positive(run.generation),
        'Invalid novice NPC event victory source',
        ErrorCode.GameConfig,
    )
    const savedFacts = facts(run),
        timing = arenaOutcomeTime(c, outcome),
        terminal = arenaScoreOutcome(run),
        tags = {},
        skills = {}
    // Continuous score loss and timeout terminate before an action at that
    // millisecond. A cast accepted before a same-ms HP death may qualify;
    // anything observed after an already sealed terminal event cannot.
    const qualifies = (row) =>
        timing.known &&
        row.terminalAlreadyKnown === false &&
        Number.isSafeInteger(row.acceptedAtMs) &&
        (row.acceptedAtMs < timing.atMs || (row.acceptedAtMs === timing.atMs && terminal?.source === 'death'))
    for (const row of Object.values(savedFacts.deployments)) {
        const actor = run.actors[row.uuid]
        ensure(
            actor?.camp === 1 && actor.source_guid === row.sourceGuid && actor.config_id === row.configId,
            'Novice NPC deployment no longer matches its roster',
            ErrorCode.GameConfig,
        )
        if (qualifies(row)) for (const tag of row.tags) tags[tag] = (tags[tag] ?? 0) + 1
    }
    for (const row of Object.values(savedFacts.casts))
        if (qualifies(row)) skills[row.skillId] = (skills[row.skillId] ?? 0) + 1
    const receipt = { version: 1, generation: run.generation, duelId: duel.id, tags, skills, qualificationTime: timing }
    if (run.noviceEventVictoryReceipt !== undefined) {
        ensure(
            JSON.stringify(run.noviceEventVictoryReceipt) === JSON.stringify(receipt),
            'Conflicting novice NPC event victory receipt',
            ErrorCode.GameConfig,
        )
        return false
    }
    const saved = ledger(state),
        counts = { ...saved?.counts },
        revision = (saved?.revision ?? 0) + 1
    ensure(uint(revision), 'Novice NPC event win revision overflow', ErrorCode.GameConfig)
    for (const [kind, quantities] of [
        [13055, tags],
        [13056, skills],
    ])
        for (const [selector, quantity] of Object.entries(quantities)) {
            const key = `${kind}:${selector}:${quantity}`,
                count = (counts[key] ?? 0) + 1
            ensure(positive(quantity) && uint(count), 'Novice NPC event win overflow', ErrorCode.GameConfig)
            counts[key] = count
        }
    state.noviceDuelEventWins = { version: 1, revision, counts }
    state.combat = { ...state.combat, npcDuel: { ...run, noviceEventVictoryReceipt: receipt } }
    return true
}
