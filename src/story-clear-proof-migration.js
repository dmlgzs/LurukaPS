import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const policy = JSON.parse(
    readFileSync(new URL('../configs/story-clear-proof-compatibility.json', import.meta.url), 'utf8'),
)
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const positive = (value) => Number.isSafeInteger(value) && value > 0
const canonical = (value) =>
    JSON.stringify(value, (_, entry) =>
        object(entry)
            ? Object.fromEntries(
                  Object.keys(entry)
                      .sort()
                      .map((key) => [key, entry[key]]),
              )
            : entry,
    )
const hash = (value) => createHash('sha256').update(value).digest('hex')
const digest = (value) => hash(JSON.stringify(value))
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)
const valid = (condition, message) => ensure(condition, message, ErrorCode.GameConfig)

export function storyClearMappingFingerprint(dungeonId, victoryCondition, taskIds) {
    return hash(canonical({ dungeonId, victoryCondition, taskIds }))
}

export function validateStoryClearProofPolicy(value) {
    valid(
        object(value) && value.version === 1 && value.local === true && value.officiallyVerified === false,
        'Historical story-clear policy is damaged',
    )
    valid(
        Array.isArray(value.entries) && value.entries.length === 1,
        'Historical story-clear policy entries are damaged',
    )
    const ids = new Set()
    for (const entry of value.entries) {
        valid(
            object(entry) &&
                positive(entry.dungeonId) &&
                !ids.has(entry.dungeonId) &&
                entry.purpose === 'historical-parent-resume-only',
            'Historical story-clear policy scope is damaged',
        )
        ids.add(entry.dungeonId)
        const source = entry.historical
        valid(
            object(source) &&
                Array.isArray(source.taskIds) &&
                source.taskIds.length === 10 &&
                source.taskIds.every(positive) &&
                new Set(source.taskIds).size === source.taskIds.length,
            'Historical story-clear source mapping is damaged',
        )
        valid(
            source.victoryCondition === `2007#${source.taskIds.at(-1)}` &&
                source.mappingFingerprint ===
                    storyClearMappingFingerprint(entry.dungeonId, source.victoryCondition, source.taskIds),
            'Historical story-clear source fingerprint changed',
        )
        valid(
            object(entry.current) && /^[a-f0-9]{64}$/.test(entry.current.mappingFingerprint),
            'Historical story-clear target fingerprint is damaged',
        )
    }
    return hash(canonical(value))
}
const policyFingerprint = validateStoryClearProofPolicy(policy)

function owner(state) {
    const id = state.player?.basic_info?.id
    valid(positive(id) && id <= 0xffffffff, 'Historical story-clear owner is damaged')
    return id
}
function currentMapping(tables, entry) {
    const dungeon = tables.find('dungeon', entry.dungeonId)
    const mapping = tables.get('dungeon_task').find((row) => row.dungeonId === entry.dungeonId)
    const taskIds = String(mapping?.taskIds ?? '')
        .split('|')
        .map(Number)
    valid(
        dungeon &&
            mapping &&
            taskIds.every(positive) &&
            new Set(taskIds).size === taskIds.length &&
            storyClearMappingFingerprint(entry.dungeonId, dungeon.victoryCondition, taskIds) ===
                entry.current.mappingFingerprint,
        'Historical story-clear target mapping changed',
    )
}
function historicalProof(clear, entry) {
    const proof = clear?.task_proof
    return (
        object(clear) &&
        positive(clear.count) &&
        Number.isSafeInteger(clear.time) &&
        clear.time >= 0 &&
        object(proof) &&
        same(Object.keys(proof).sort(), ['task_ids', 'victory_task_id']) &&
        proof.victory_task_id === entry.historical.taskIds.at(-1) &&
        same(proof.task_ids, entry.historical.taskIds)
    )
}
function checkMarker(tables, state) {
    const marker = state.storyClearProofMigration
    valid(
        object(marker) &&
            marker.version === 1 &&
            marker.policy_fingerprint === policyFingerprint &&
            marker.owner_id === owner(state) &&
            ['fresh', 'bootstrap'].includes(marker.origin) &&
            object(marker.bridges),
        'Historical story-clear migration marker is damaged',
    )
    valid(
        marker.origin !== 'fresh' || Object.keys(marker.bridges).length === 0,
        'Fresh story-clear marker contains historical imports',
    )
    for (const [id, bridge] of Object.entries(marker.bridges)) {
        const entry = policy.entries.find((row) => String(row.dungeonId) === id)
        valid(
            entry &&
                object(bridge) &&
                bridge.version === 1 &&
                bridge.owner_id === marker.owner_id &&
                bridge.purpose === entry.purpose &&
                bridge.source_mapping_fingerprint === entry.historical.mappingFingerprint &&
                bridge.target_mapping_fingerprint === entry.current.mappingFingerprint,
            'Historical story-clear bridge scope is damaged',
        )
        valid(
            historicalProof(bridge.raw_clear, entry) &&
                bridge.raw_clear_sha256 === digest(bridge.raw_clear) &&
                bridge.raw_proof_sha256 === digest(bridge.raw_clear.task_proof),
            'Historical story-clear archived proof is damaged',
        )
        currentMapping(tables, entry)
    }
    return marker
}

export function initializeFreshStoryClearProofState(state) {
    valid(!Object.hasOwn(state, 'storyClearProofMigration'), 'Fresh story-clear migration marker already exists')
    valid(
        state.storyCampaignClears === undefined ||
            (object(state.storyCampaignClears) && Object.keys(state.storyCampaignClears).length === 0),
        'Fresh story-clear state contains historical clears',
    )
    state.storyClearProofMigration = {
        version: 1,
        policy_fingerprint: policyFingerprint,
        owner_id: owner(state),
        origin: 'fresh',
        bridges: {},
    }
    return state
}

// LOCAL one-time bootstrap for trusted, unversioned local-server saves. The old
// writer had no authentication/version field: identical privately forged bytes
// cannot be distinguished. TODO: no general historical proof-format migration.
// This sidecar never changes the clear, task records, run status or rewards.
export function bootstrapStoryClearProofs(tables, state) {
    if (Object.hasOwn(state, 'storyClearProofMigration')) {
        checkMarker(tables, state)
        return { changed: false, imported: [] }
    }
    valid(
        state.storyCampaignClears === undefined || object(state.storyCampaignClears),
        'Historical story-clear storage is damaged',
    )
    const bridges = {},
        imported = []
    for (const entry of policy.entries) {
        const clear = state.storyCampaignClears?.[entry.dungeonId]
        if (!historicalProof(clear, entry)) continue
        currentMapping(tables, entry)
        bridges[entry.dungeonId] = {
            version: 1,
            owner_id: owner(state),
            purpose: entry.purpose,
            source_mapping_fingerprint: entry.historical.mappingFingerprint,
            target_mapping_fingerprint: entry.current.mappingFingerprint,
            raw_clear: structuredClone(clear),
            raw_clear_sha256: digest(clear),
            raw_proof_sha256: digest(clear.task_proof),
        }
        imported.push(entry.dungeonId)
    }
    state.storyClearProofMigration = {
        version: 1,
        policy_fingerprint: policyFingerprint,
        owner_id: owner(state),
        origin: 'bootstrap',
        bridges,
    }
    return { changed: true, imported }
}

export function hasHistoricalParentDungeonClear(tables, state, dungeonId) {
    if (!Object.hasOwn(state, 'storyClearProofMigration')) return false
    const marker = checkMarker(tables, state),
        bridge = marker.bridges[dungeonId]
    if (!bridge) return false
    const run = state.storyCampaign
    if (run?.dungeon_id === dungeonId && run.status !== 3) return false
    // A later legitimate current clear supersedes the archived bytes; its normal
    // fifteen-task verifier remains authoritative and is not relaxed here.
    const clear = state.storyCampaignClears?.[dungeonId]
    return object(clear) && digest(clear) === bridge.raw_clear_sha256
}
