import { createHash } from 'node:crypto'
import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'

// Audited3217420 finite graph and its complete current table-source projection.
// These are evidence identities, not per-trial or per-scene behavior rules.
const sourceFingerprint = 'e192aa5ec21c7c55ccc11e5fd8f699beb8c1b96a4076db002803995b154e82f0'
const graphFingerprint = '442b189e99e5f5b1468bad735de741b17bef59505da79c0147d52764b19cf0f7'
const cache = new WeakMap()
const tableHashes = new WeakMap()
const rowIndices = new WeakMap()
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const positive = (value) => Number.isSafeInteger(value) && value > 0
const ordered = (values) => [...values].sort((a, b) => a - b)
const equalIds = (a, b) => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b))
const valid = (condition, message) => ensure(condition, message, ErrorCode.GameConfig)
const ids = (values, message) => {
    valid(
        Array.isArray(values) && values.length > 0 && values.every(positive) && new Set(values).size === values.length,
        message,
    )
    return ordered(values)
}
const rowIds = (text) => {
    valid(typeof text === 'string' && /^\d+(?:\|\d+)*$/.test(text), 'Invalid cultivation scoring object IDs')
    return ids(text.split('|').map(Number), 'Invalid cultivation scoring object IDs')
}
function find(tables, name, id) {
    const rows = tables.get(name)
    let index = rowIndices.get(rows)
    if (!index) rowIndices.set(rows, (index = new Map(rows.map((row, position) => [row.id, position]))))
    const position = index.get(id)
    return rows[position]?.id === id ? rows[position] : rows.find((row) => row.id === id)
}
function freeze(value) {
    if (value && typeof value === 'object') {
        for (const child of Object.values(value)) freeze(child)
        Object.freeze(value)
    }
    return value
}
function guard(tables, route) {
    const world = tables.get('worldmap_' + route.scene_id)
    const spawners = world.map((row) => find(tables, 'world_spawner', row.spawnerId))
    const enemies = world.filter((row, index) => [50, 51, 53].includes(spawners[index]?.objectType))
    const groups = enemies.map((row) => find(tables, 'world_enemy_group', row.expandId))
    const packs = groups.flatMap((row) =>
        String(row?.enemyList ?? '')
            .split('|')
            .filter(Boolean)
            .map((id) => find(tables, 'enemy_pack', Number(id))),
    )
    return {
        scene: find(tables, 'dungeon_scene', route.scene_id),
        city: find(tables, 'world_city', route.scene_id),
        blueprint: find(tables, 'world_blueprint', route.execution.blueprint_id),
        dungeon: find(tables, 'dungeon', route.dungeon_id),
        trial: tables.get('game_events_cul_trial').find((row) => row.trialId === route.trial_id),
        scores: tables.get('game_events_cul_trial_wave').filter((row) => row.trialId === route.trial_id),
        world,
        spawners,
        enemies,
        groups,
        packs,
    }
}
function validateTables(tables, execution, mapId) {
    const required = [
        'dungeon_scene',
        'world_city',
        'world_blueprint',
        'worldmap_' + mapId,
        'world_spawner',
        'world_enemy_group',
        'enemy_pack',
        'game_events_cul_trial',
        'game_events_cul_trial_wave',
        'dungeon',
    ]
    valid(
        Array.isArray(execution.tableFingerprints) &&
            execution.tableFingerprints.length === required.length &&
            execution.tableFingerprints.every((row) => row && typeof row.table === 'string') &&
            new Set(execution.tableFingerprints.map((row) => row.table)).size === required.length,
        'Cultivation execution table fingerprints unavailable',
    )
    let hashes = tableHashes.get(tables)
    if (!hashes) tableHashes.set(tables, (hashes = new Map()))
    return required.map((name) => {
        const expected = execution.tableFingerprints.find((row) => row.table === name)
        const rows = tables.get(name)
        valid(
            expected &&
                Array.isArray(rows) &&
                rows.length === expected.rows &&
                /^[a-f0-9]{64}$/.test(expected.canonicalSha256),
            'Cultivation execution table declaration changed',
        )
        let stored = hashes.get(name)
        if (!stored || stored.rows !== rows) hashes.set(name, (stored = { rows, hash: digest(rows) }))
        valid(stored.hash === expected.canonicalSha256, 'Cultivation execution current table fingerprint changed')
        return { name, rows, lengthAtValidation: rows.length }
    })
}

export function cultExecutionPlan(tables, route) {
    if (route?.execution === undefined) return undefined
    valid(
        route && typeof route.execution === 'object' && route.execution !== null,
        'Cultivation execution contract is damaged',
    )
    const e = route.execution
    valid(
        e.schemaVersion === 1 &&
            e.kind === 'current-cult-route-execution-v1' &&
            e.clientVersion === '1.0.0' &&
            e.packageVersion === '3217420',
        'Unknown cultivation execution contract version',
    )
    valid(
        e.sourceFingerprint === sourceFingerprint &&
            e.graphSha256 === graphFingerprint &&
            e.nativeActivationOrderRecovered === false &&
            e.policy?.id === 'current-cult-static-visible-score-join-v1' &&
            e.policy.origin === 'LOCAL' &&
            e.policy.modeIsCreator === false &&
            e.policy.waveOrder === 'current score wave_id exact join, not Native activation order',
        'Unknown cultivation execution source or policy',
    )
    valid(
        [route.trial_id, route.dungeon_id, route.scene_id].every(positive) &&
            e.trial_id === route.trial_id &&
            e.dungeon_id === route.dungeon_id &&
            e.scene_id === route.scene_id &&
            e.map_id === route.scene_id &&
            e.blueprint_id === 300310,
        'Cultivation execution route binding changed',
    )
    let plans = cache.get(tables)
    if (!plans) cache.set(tables, (plans = new WeakMap()))
    const signature = digest(route)
    const prior = plans.get(route)
    const current = guard(tables, route)
    const currentSignature = digest(current)
    if (
        prior &&
        prior.signature === signature &&
        prior.refs.every(
            ({ name, rows, lengthAtValidation }) => tables.get(name) === rows && rows.length === lengthAtValidation,
        )
    ) {
        valid(prior.currentSignature === currentSignature, 'Cultivation execution enemy or scoring source changed')
        return prior.plan
    }
    const refs = validateTables(tables, e, route.scene_id)
    valid(
        current.scene?.id === e.scene_id &&
            current.scene.mapId === e.map_id &&
            current.scene.blueprintId === e.blueprint_id &&
            current.city?.type === 27 &&
            current.trial?.dungeonId === e.dungeon_id &&
            current.dungeon?.id === e.dungeon_id,
        'Cultivation execution scene or trial configuration changed',
    )
    valid(
        current.blueprint?.path === 'Config/World/Graph/Blueprint/ast_xiaoyu_dungeon_ai_common.asset' &&
            current.blueprint.paramTemplate === 0 &&
            ['param', 'stringParam', 'intParam', 'boolParam'].every((key) => current.blueprint[key] === ''),
        'Cultivation execution blueprint defaults changed',
    )
    valid(
        new Set(current.world.map((row) => row.id)).size === current.world.length &&
            current.spawners.every((spawner, index) => current.world[index].spawnerId === 0 || spawner) &&
            current.groups.every(Boolean) &&
            current.packs.every(Boolean),
        'Cultivation execution world or enemy reference unavailable',
    )
    const objectIds = ids(e.enemyObjectIds, 'Cultivation execution enemy IDs are damaged')
    valid(
        equalIds(objectIds, ids(route.object_ids, 'Cultivation route object IDs damaged')) &&
            equalIds(
                objectIds,
                current.enemies.map((row) => row.id),
            ),
        'Cultivation execution actual enemy roster changed',
    )
    valid(
        current.enemies.every((row) => row.initStatus === 1 && row.cityId === e.map_id),
        'Cultivation execution current enemy initialization changed',
    )
    valid(
        current.dungeon.victoryCondition === current.scene.victoryCondition,
        'Cultivation execution victory condition changed',
    )
    const actualRoster = new Map()
    for (const pack of current.packs) {
        valid(positive(pack.enemyId), 'Cultivation execution enemy pack is damaged')
        actualRoster.set(pack.enemyId, (actualRoster.get(pack.enemyId) ?? 0) + 1)
    }
    const expectedRoster = String(current.dungeon.enemy)
        .split('|')
        .map((part) => part.split('#').map(Number))
    valid(
        expectedRoster.every((part) => part.length === 2 && part.every(positive)) &&
            new Set(expectedRoster.map(([id]) => id)).size === expectedRoster.length &&
            digest([...actualRoster].sort((a, b) => a[0] - b[0])) ===
                digest(expectedRoster.sort((a, b) => a[0] - b[0])),
        'Cultivation execution dungeon roster changed',
    )
    const tagGroups = new Map()
    for (const object of current.enemies) {
        valid(/^[1-4]$/.test(object.commonTag), 'Cultivation execution dynamic or overlapping enemy tag is unsupported')
        if (!tagGroups.has(object.commonTag)) tagGroups.set(object.commonTag, [])
        tagGroups.get(object.commonTag).push(object.id)
    }
    valid(
        Array.isArray(e.waveBindings) && e.waveBindings.length > 0 && Array.isArray(e.metadataOnlyWaves),
        'Cultivation execution wave partition unavailable',
    )
    const declared = [...e.waveBindings, ...e.metadataOnlyWaves]
    valid(
        declared.length === current.scores.length &&
            declared.every((wave) => wave && positive(wave.wave_id)) &&
            new Set(declared.map((wave) => wave.wave_id)).size === declared.length,
        'Cultivation scoring wave partition changed',
    )
    const usedObjects = new Set()
    const rowsFor = (bindings, executable) =>
        bindings.map((binding) => {
            const object_ids = ids(binding.object_ids, 'Cultivation execution wave IDs damaged')
            const matches = current.scores.filter(
                (row) => row.waveId === binding.wave_id && (row.Id ?? row.id) === binding.row_id,
            )
            valid(
                matches.length === 1 && equalIds(object_ids, rowIds(matches[0].worldMapId)),
                'Cultivation scoring wave binding changed',
            )
            valid(
                object_ids.every((id) => !usedObjects.has(id)),
                'Duplicate cultivation scoring object',
            )
            object_ids.forEach((id) => usedObjects.add(id))
            valid(
                object_ids.every((id) => (executable ? objectIds.includes(id) : !objectIds.includes(id))),
                'Cultivation execution and metadata overlap',
            )
            if (executable)
                valid(
                    [...tagGroups.values()].filter((group) => equalIds(group, object_ids)).length === 1,
                    'Cultivation scoring wave must equal a complete current tag selection',
                )
            return { wave_id: binding.wave_id, object_ids, score: structuredClone(matches[0]) }
        })
    const waves = rowsFor(e.waveBindings, true).sort((a, b) => a.wave_id - b.wave_id)
    const metadata = rowsFor(e.metadataOnlyWaves, false)
    valid(
        equalIds(
            waves.flatMap((wave) => wave.object_ids),
            objectIds,
        ),
        'Cultivation executable waves do not cover current enemies',
    )
    const plan = freeze({
        trialId: route.trial_id,
        dungeonId: route.dungeon_id,
        mapId: route.scene_id,
        sourceFingerprint: e.sourceFingerprint,
        fingerprint: digest(e),
        objectIds,
        waves,
        metadataOnlyWaves: metadata,
        scoreRows: waves.map((wave) => wave.score),
    })
    plans.set(route, { signature, currentSignature, refs, plan })
    return plan
}

export function validateCultExecutionRun(plan, run) {
    if (!plan) return
    valid(
        run.trial_id === plan.trialId && run.dungeon_id === plan.dungeonId && run.map_id === plan.mapId,
        'Cultivation saved execution route changed',
    )
    const owned = ids(run.object_ids, 'Cultivation saved object IDs damaged')
    const metadataIds = plan.metadataOnlyWaves.flatMap((wave) => wave.object_ids)
    valid(
        plan.objectIds.every((id) => owned.includes(id)) &&
            owned.every((id) => plan.objectIds.includes(id) || metadataIds.includes(id)),
        'Unknown cultivation saved execution objects',
    )
    valid(
        run.execution_fingerprint === undefined || run.execution_fingerprint === plan.fingerprint,
        'Cultivation saved execution source changed',
    )
    const current = run.current_wave ?? 0,
        complete = run.completed_waves ?? 0
    valid(
        Number.isSafeInteger(current) && current >= 0 && Number.isSafeInteger(complete) && complete >= 0,
        'Cultivation saved wave progress damaged',
    )
    const position = plan.waves.findIndex((wave) => wave.wave_id === current)
    const completed = plan.waves.findIndex((wave) => wave.wave_id === complete)
    valid(
        (current === 0 || position >= 0) && (complete === 0 || completed >= 0),
        'Cultivation saved wave is outside current execution',
    )
    if (run.battle_complete)
        valid(
            position === plan.waves.length - 1 && completed === position,
            'Cultivation completion does not match current execution',
        )
    else valid(current === 0 ? complete === 0 : position === completed + 1, 'Cultivation saved wave order changed')
}
