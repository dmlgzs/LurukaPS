import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { weeklyDungeonPolicy } from './weekly-dungeons.js'

// Explicit LOCAL capability binding to the audited current3217420 compiler
// output; it is not a Native resource-alias transformation or a zeroGuard model.
const SOURCE_FINGERPRINT = '8b810b1e486f81139f7e00d88774b87d1a91a0ba5eb78ba9a6b60117a34b2c5c'
const MODEL_FINGERPRINT = 'a4ba708d0399fcad93b6cb32be71d39c2e004db223cdc773006cf0f18b93222c'
const PROFILES_FINGERPRINT = '7b032d389e217f7afec19e7d7f97b609d3d6749a3f532f8d41b0ab8096c96bc7'
const digest = (value) =>
    createHash('sha256')
        .update(JSON.stringify(value) ?? 'null')
        .digest('hex')
const valid = (condition, message) => ensure(condition, message, ErrorCode.GameConfig)
const positive = (value) => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff
const plain = (value) => value && typeof value === 'object' && !Array.isArray(value)
const tableChecks = new WeakMap()
let compiled

function currentContract() {
    if (compiled) return compiled
    const url = new URL('../configs/current-weekly-intro.json', import.meta.url)
    ensure(fs.existsSync(url), 'Current weekly intro capability is unavailable', ErrorCode.FunctionClosed)
    try {
        compiled = JSON.parse(fs.readFileSync(url, 'utf8'))
    } catch {
        valid(false, 'Current weekly intro contract is damaged')
    }
    return compiled
}

function fields(text) {
    valid(typeof text === 'string', 'Weekly scene parameter source is invalid')
    const result = {}
    for (const token of text.split('|').filter(Boolean)) {
        const [key, ...value] = token.split('#')
        valid(
            key.length > 0 && value.length > 0 && !Object.hasOwn(result, key),
            'Weekly scene parameter identity is ambiguous',
        )
        result[key] = value.join('#')
    }
    return result
}

function validateTables(tables, profile) {
    valid(plain(profile.tableFingerprints), 'Weekly table fingerprint catalogue is unavailable')
    let cache = tableChecks.get(tables)
    if (!cache) tableChecks.set(tables, (cache = new Map()))
    const checked = new Map()
    for (const [name, expected] of Object.entries(profile.tableFingerprints)) {
        valid(
            plain(expected) &&
                Number.isSafeInteger(expected.rows) &&
                expected.rows >= 0 &&
                /^[a-f0-9]{64}$/.test(expected.canonicalSha256),
            'Weekly table fingerprint is damaged',
        )
        const rows = tables.get(name)
        valid(Array.isArray(rows) && rows.length === expected.rows, 'Current weekly table cardinality changed')
        const old = cache.get(name)
        if (!old || old.rows !== rows || old.length !== rows.length || old.hash !== expected.canonicalSha256) {
            valid(digest(rows) === expected.canonicalSha256, 'Current weekly table fingerprint changed')
            const identities = new Set()
            for (const row of rows) {
                valid(
                    plain(row) && positive(row.id) && !identities.has(row.id),
                    'Weekly current table identity is invalid or duplicated',
                )
                identities.add(row.id)
            }
            cache.set(name, { rows, length: rows.length, hash: expected.canonicalSha256 })
        }
        checked.set(name, rows)
    }
    valid(
        Array.isArray(profile.rowBindings) && profile.rowBindings.length > 0,
        'Weekly source row bindings are unavailable',
    )
    const seen = new Set()
    for (const binding of profile.rowBindings) {
        valid(
            plain(binding) &&
                typeof binding.table === 'string' &&
                positive(binding.id) &&
                /^[a-f0-9]{64}$/.test(binding.rowSha256),
            'Weekly source row binding is damaged',
        )
        const rows = checked.get(binding.table)
        valid(
            rows && !seen.has(binding.table + ':' + binding.id),
            'Weekly source binding is duplicated or outside its table catalogue',
        )
        seen.add(binding.table + ':' + binding.id)
        const matches = rows.filter((row) => row.id === binding.id)
        valid(matches.length === 1 && digest(matches[0]) === binding.rowSha256, 'Current weekly source row changed')
    }
}

function one(tables, name, id) {
    const rows = tables.get(name)
    valid(Array.isArray(rows), 'Weekly source table is unavailable')
    const matches = rows.filter((row) => row.id === id)
    valid(matches.length === 1, 'Weekly source row is missing or ambiguous')
    return matches[0]
}

function derivePlan(tables, run, profile) {
    const weekly = one(tables, 'dungeon_weekly', run.entrust_id),
        dungeon = one(tables, 'dungeon', run.dungeon_id),
        scene = one(tables, 'dungeon_scene', run.map_id),
        city = one(tables, 'world_city', run.map_id)
    valid(
        weekly.dungeonId === dungeon.id && scene.mapId === city.id && city.type === 12,
        'Weekly dungeon scene relation changed',
    )
    valid(
        scene.blueprintId === profile.blueprint_id && scene.serverBlueprintId === profile.server_blueprint_id,
        'Weekly front/server blueprint identity changed',
    )
    one(tables, 'world_blueprint', scene.blueprintId)
    one(tables, 'world_blueprint', scene.serverBlueprintId)
    const bool = fields(scene.boolParam),
        params = fields(scene.intParam)
    valid(
        bool.isBossOnly === 'true' && Number(params.bossTag) === 10000,
        'Weekly nonzero boss branch is unavailable or changed',
    )
    const storyId = Number(params.bossStoryID),
        bossId = Number(params.bossID),
        pointId = Number(params.bossTransferID)
    valid([storyId, bossId, pointId].every(positive), 'Weekly boss intro parameters are invalid')
    const rows = tables.get('worldmap_' + run.map_id)
    valid(Array.isArray(rows), 'Weekly worldmap is unavailable')
    const stages = rows
        .flatMap((row) => {
            const tokens = String(row.expandParams ?? '')
                .split('|')
                .filter((token) => /^autoBattleIndex#/i.test(token))
            valid(tokens.length <= 1, 'Weekly automatic stage index is duplicated')
            if (!tokens.length) return []
            const index = Number(tokens[0].split('#')[1]),
                type = one(tables, 'world_spawner', row.spawnerId).objectType
            valid(positive(index), 'Weekly automatic stage index is invalid')
            return [{ index, type, row }]
        })
        .sort((a, b) => a.index - b.index)
    valid(
        stages.length === 3 &&
            stages[0].type === 13 &&
            stages[1].type === 50 &&
            stages[1].row.id === bossId &&
            stages[2].type === 30 &&
            stages.every((stage, i) => i === 0 || stage.index > stages[i - 1].index),
        'Weekly intro stage order is invalid',
    )
    const boss = one(tables, 'worldmap_' + run.map_id, bossId),
        point = one(tables, 'world_borthpos', pointId)
    valid(point.cityId === run.map_id, 'Weekly boss intro transfer belongs to another scene')
    one(tables, 'story', storyId)
    const group = one(tables, 'world_enemy_group', boss.expandId),
        packs = String(group.enemyList ?? '')
            .split('|')
            .filter(Boolean)
            .map(Number)
    valid(packs.length > 0 && packs.every(positive), 'Weekly boss roster is invalid')
    for (const pack of packs) one(tables, 'enemy_pack', pack)
    let triggerId = Number(params.bossTriggerID),
        localTriggerSource
    if (params.bossTriggerID === undefined) {
        valid(
            typeof weeklyDungeonPolicy.intro?.enabled === 'boolean' &&
                weeklyDungeonPolicy.intro.missingBossTrigger === 'unique-initial-interaction-marker',
            'LOCAL weekly missing-trigger policy is invalid',
        )
        ensure(
            weeklyDungeonPolicy.intro.enabled,
            'LOCAL weekly missing-trigger compatibility is disabled',
            ErrorCode.FunctionClosed,
        )
        valid(stages[0].index === 1, 'Weekly initial interaction marker is unavailable')
        triggerId = stages[0].row.id
        localTriggerSource = {
            mode: 'local-inferred',
            table: 'worldmap_' + run.map_id,
            row_id: triggerId,
            spawner_id: stages[0].row.spawnerId,
            field: 'autoBattleIndex#1',
            policy: 'unique-initial-interaction-marker',
        }
    }
    valid(positive(triggerId), 'Weekly boss trigger identity is invalid')
    const trigger = one(tables, 'worldmap_' + run.map_id, triggerId),
        spawner = one(tables, 'world_spawner', trigger.spawnerId)
    const options = (String(trigger.interactOptions ?? '').trim() || String(spawner.interactOps ?? ''))
        .split('|')
        .filter(Boolean)
        .map(Number)
    valid(options.length > 0 && options.every(positive), 'Weekly trigger interaction source is invalid')
    const ops = options.map((id) => one(tables, 'world_interact', id))
    const op = ops.find(
        (row) => row.interactAction === 75 || (spawner.objectType === 13 && row.interactAction === 10019),
    )
    valid(
        op && (spawner.objectType === 306 || spawner.objectType === 13),
        'Weekly trigger interaction capability is invalid',
    )
    valid(Number.isFinite(op.interactRange) && op.interactRange > 0, 'Weekly story interaction range is invalid')
    const xyz = String(trigger.position).split('|').map(Number)
    valid(xyz.length === 3 && xyz.every(Number.isFinite), 'Weekly story trigger position is invalid')
    const boxes = tables.get('stamina_chest_drop').filter((row) => row.worldFilter === '4|' + dungeon.id)
    valid(
        boxes.length === 1 &&
            boxes[0].type === 6 &&
            boxes[0].worldmapcityid === run.map_id &&
            boxes[0].worldmapid === stages[2].row.id,
        'Weekly chest mapping is invalid',
    )
    const [kind, spawnerId, a, b, count, ...extra] = String(scene.victoryCondition).split('#').map(Number)
    valid(
        kind === 2500 &&
            positive(spawnerId) &&
            a === 0 &&
            b === 0 &&
            count === 1 &&
            !extra.length &&
            boss.spawnerId === spawnerId,
        'Weekly victory target is invalid',
    )
    const plan = {
        map_id: run.map_id,
        story_id: storyId,
        boss_id: bossId,
        trigger_id: triggerId,
        point_id: pointId,
        marker_id: stages[0].row.id,
        marker_index: stages[0].index,
        boss_index: stages[1].index,
        range: op.interactRange * 100,
        pos: { x: Math.round(xyz[0] * 100), y: Math.round(xyz[1] * 100), z: Math.round(xyz[2] * 100) },
        ...(localTriggerSource
            ? {
                  local_trigger_source: {
                      ...localTriggerSource,
                      interact_id: op.id,
                      interact_options_source: String(trigger.interactOptions || '').trim()
                          ? 'worldmap'
                          : 'world_spawner',
                      override_params: String(trigger.interactOptions || '').trim()
                          ? String(trigger.interactOverrideParams || '')
                          : '',
                  },
              }
            : {}),
    }
    valid(digest(plan) === digest(profile.plan), 'Compiled weekly intro plan differs from its current source')
    return plan
}

export function currentWeeklyStoryPlan(tables, run, contract = currentContract()) {
    valid(
        plain(run) && run.kind === 'weekly' && [run.entrust_id, run.dungeon_id, run.map_id].every(positive),
        'Weekly intro run identity is invalid',
    )
    valid(plain(contract), 'Current weekly intro contract is invalid')
    ensure(
        contract.schemaVersion === 1 &&
            contract.kind === 'current-weekly-intro-contracts-v1' &&
            contract.clientVersion === '1.0.0' &&
            contract.packageVersion === '3217420',
        'Current weekly intro contract version is unsupported',
        ErrorCode.FunctionClosed,
    )
    valid(
        contract.sourceFingerprint === SOURCE_FINGERPRINT &&
            digest(contract.source) === SOURCE_FINGERPRINT &&
            digest(contract.model) === MODEL_FINGERPRINT &&
            digest(contract.profiles) === PROFILES_FINGERPRINT,
        'Current weekly intro source or capability model changed',
    )
    valid(
        contract.policy?.origin === 'LOCAL' &&
            contract.policy.id === 'current-weekly-server-boss-intro-v1' &&
            contract.policy.missingBossTrigger === 'unique-initial-interaction-marker' &&
            contract.policy.serverResourceAlias === 'single-current-vstring-asset-candidate; native-alias-not-proven',
        'Current weekly intro LOCAL policy changed',
    )
    valid(
        Array.isArray(contract.profiles) && contract.profiles.length === 18,
        'Current weekly intro profile catalogue is invalid',
    )
    const matches = contract.profiles.filter(
        (profile) =>
            profile.weekly_id === run.entrust_id &&
            profile.dungeon_id === run.dungeon_id &&
            profile.scene_id === run.map_id &&
            profile.map_id === run.map_id,
    )
    ensure(matches.length === 1, 'Current weekly route has no unique intro capability', ErrorCode.FunctionClosed)
    const profile = matches[0]
    const front = contract.source.fronts.find((row) => row.blueprintId === profile.blueprint_id),
        server = contract.source.server
    valid(
        front &&
            server.blueprintId === profile.server_blueprint_id &&
            profile.graph_sources.front === front.graphSha256 &&
            profile.graph_sources.server === server.graphSha256,
        'Weekly intro graph source binding changed',
    )
    validateTables(tables, profile)
    valid(
        one(tables, 'world_blueprint', front.blueprintId).path === front.declaredPath &&
            one(tables, 'world_blueprint', server.blueprintId).path === server.declaredPath,
        'Weekly intro declared source path changed',
    )
    return derivePlan(tables, run, profile)
}
