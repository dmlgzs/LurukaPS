import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'
import fs from 'node:fs'
import { createHash } from 'node:crypto'

const positive = (n) => Number.isSafeInteger(n) && n > 0 && n <= 0xffffffff
const digest = (value) =>
    createHash('sha256')
        .update(JSON.stringify(value) ?? 'null')
        .digest('hex')
const sourceFingerprint = 'ec9b6f931f868fa41ab5f12d31b45c6082ea1e809dc5cf7b0f04d8fc9eed399d'
const modelFingerprint = '9308130fa4416c0bf6c4c8e7a1f0861f548a817b3e4e4fbaabecb3df22e432ff'
const tableHashes = new WeakMap()
const currentPlans = new WeakMap()
let currentCompiled
const valid = (condition, message) => ensure(condition, message, ErrorCode.GameConfig)
const sameIds = (a, b) => JSON.stringify([...a].sort((x, y) => x - y)) === JSON.stringify([...b].sort((x, y) => x - y))
function currentContract() {
    if (!currentCompiled) {
        const file = new URL('../configs/material-front-execution.json', import.meta.url)
        ensure(
            fs.existsSync(file),
            'Current material front/server execution capability unavailable',
            ErrorCode.FunctionClosed,
        )
        try {
            currentCompiled = JSON.parse(fs.readFileSync(file, 'utf8'))
        } catch {
            ensure(false, 'Current material execution contract is damaged', ErrorCode.GameConfig)
        }
    }
    return currentCompiled
}

// The server-resource alias is an explicit LOCAL binding to one audited current
// resource. It is not a recovered Native alias transformation or an old fallback.
export function currentMaterialBlueprintStages(tables, scene, material, indexed, contract) {
    ensure(
        scene.blueprintId === 300358 && scene.serverBlueprintId === 300351,
        'Unknown material front/server pair',
        ErrorCode.FunctionClosed,
    )
    valid(
        contract?.schemaVersion === 1 &&
            contract.kind === 'current-material-front-server-contracts-v1' &&
            contract.clientVersion === '1.0.0' &&
            contract.packageVersion === '3217420',
        'Unknown current material execution contract',
    )
    valid(
        contract.policy?.origin === 'LOCAL' &&
            contract.policy.id === 'current-material-front-server-serial-tags-v1' &&
            contract.policy.resourceAlias === 'single-current-manifest-resource-candidate; native-alias-not-proven',
        'Unknown current material resource binding policy',
    )
    valid(
        contract.sourceFingerprint === sourceFingerprint &&
            digest(contract.source) === sourceFingerprint &&
            digest(contract.model) === modelFingerprint,
        'Current material graph source or topology changed',
    )
    const front = contract.source.front,
        server = contract.source.server
    valid(
        front.blueprintId === scene.blueprintId &&
            server.blueprintId === scene.serverBlueprintId &&
            front.graphSha256 === 'd262019db7e06aa111183368aff0ade18b26b1cdfdb7a1afb5b2fb84d8413700' &&
            server.graphSha256 === '4cc29c3472c543dcd145f6bc0732a968f5433bec866dc548ee306615242c97e3',
        'Current material front/server source mismatch',
    )
    valid(Array.isArray(contract.scenes), 'Current material scene contracts unavailable')
    const matches = contract.scenes.filter(
        (row) => row?.scene_id === scene.id && row.material_id === material.id && row.dungeon_id === material.dungeonId,
    )
    ensure(matches.length === 1, 'Current material route has no unique execution contract', ErrorCode.FunctionClosed)
    const entry = matches[0]
    valid(Array.isArray(indexed) && Array.isArray(entry.stages), 'Current material stage bindings are damaged')
    valid(
        entry.map_id === scene.mapId &&
            entry.blueprint_id === scene.blueprintId &&
            entry.server_blueprint_id === scene.serverBlueprintId,
        'Current material scene binding changed',
    )
    const get = (name) => {
        const rows = tables.get(name)
        valid(Array.isArray(rows), 'Current material source table is damaged')
        return rows
    }
    const one = (name, id) => get(name).find((row) => row.id === id)
    const source = get('worldmap_' + scene.mapId)
    const spawners = source.map((row) => one('world_spawner', row.spawnerId))
    const groups = source
        .filter((row, index) => [50, 51, 53].includes(spawners[index]?.objectType))
        .map((row) => one('world_enemy_group', row.expandId))
    const packs = groups.flatMap((group) =>
        String(group?.enemyList ?? '')
            .split('|')
            .filter(Boolean)
            .map((id) => one('enemy_pack', Number(id))),
    )
    const snapshot = {
        scene,
        material,
        indexed,
        currentScene: one('dungeon_scene', scene.id),
        currentMaterial: one('dungeon_material', material.id),
        front: one('world_blueprint', front.blueprintId),
        server: one('world_blueprint', server.blueprintId),
        city: one('world_city', scene.mapId),
        dungeon: one('dungeon', material.dungeonId),
        boxes: get('stamina_chest_drop').filter((row) => row.worldFilter === `4|${material.dungeonId}`),
        source,
        spawners,
        groups,
        packs,
    }
    const signature = digest([entry, snapshot])
    let plans = currentPlans.get(tables)
    if (!plans) currentPlans.set(tables, (plans = new Map()))
    const key = material.id + ':' + scene.id
    const previous = plans.get(key)
    if (previous && previous.refs.every(({ name, rows, length }) => get(name) === rows && rows.length === length)) {
        valid(previous.signature === signature, 'Current material selected source changed')
        return previous.stages
    }
    const required = [
        'dungeon',
        'dungeon_material',
        'dungeon_scene',
        'enemy_pack',
        'stamina_chest_drop',
        'world_blueprint',
        'world_city',
        'world_enemy_group',
        'world_spawner',
        'worldmap_' + scene.mapId,
    ]
    valid(
        Array.isArray(entry.tableFingerprints) &&
            entry.tableFingerprints.length === required.length &&
            entry.tableFingerprints.every((row) => row && typeof row.table === 'string') &&
            new Set(entry.tableFingerprints.map((row) => row.table)).size === required.length,
        'Current material table fingerprints unavailable',
    )
    let hashes = tableHashes.get(tables)
    if (!hashes) tableHashes.set(tables, (hashes = new Map()))
    const refs = required.map((name) => {
        const expected = entry.tableFingerprints.find((row) => row.table === name),
            rows = get(name)
        valid(
            expected && expected.rows === rows.length && /^[a-f0-9]{64}$/.test(expected.canonicalSha256),
            'Current material table declaration changed',
        )
        let cached = hashes.get(name)
        if (!cached || cached.rows !== rows) hashes.set(name, (cached = { rows, hash: digest(rows) }))
        valid(cached.hash === expected.canonicalSha256, 'Current material current-table fingerprint changed')
        return { name, rows, length: rows.length }
    })
    valid(
        digest(scene) === digest(snapshot.currentScene) &&
            digest(material) === digest(snapshot.currentMaterial) &&
            snapshot.city?.id === scene.mapId &&
            snapshot.dungeon?.id === material.dungeonId,
        'Current material route definition changed',
    )
    valid(
        snapshot.front?.path === front.declaredPath && snapshot.server?.path === server.declaredPath,
        'Current material declared blueprint path changed',
    )
    valid(
        [snapshot.front, snapshot.server].every(
            (row) =>
                row.paramTemplate === 0 &&
                ['param', 'stringParam', 'intParam', 'boolParam'].every((field) => row[field] === ''),
        ) &&
            ['param', 'listIntParam', 'intParam', 'boolParam', 'extraParam'].every(
                (field) => !String(scene[field] ?? '').trim(),
            ),
        'Current material execution variables are overridden',
    )
    const protectedNames = new Set([
        ...contract.model.waits.map((wait) => wait.variable),
        ...contract.model.guards.map((guard) => guard.variable),
        ...contract.model.sideActions.map((action) => action.variable),
    ])
    valid(
        String(scene.stringParam ?? '')
            .split('|')
            .every((part) => !protectedNames.has(part.split('#')[0])),
        'Current material behavior variables cannot use typed string overrides',
    )
    valid(
        new Set(source.map((row) => row.id)).size === source.length &&
            source.every((row, index) => row.spawnerId === 0 || spawners[index]) &&
            groups.every(Boolean) &&
            packs.every((pack) => pack && positive(pack.enemyId)),
        'Current material enemy references unavailable',
    )
    const victory = String(scene.victoryCondition).split('#').map(Number)
    valid(
        victory.length === 5 &&
            victory[0] === 2500 &&
            positive(victory[1]) &&
            victory[2] === 0 &&
            victory[3] === 0 &&
            positive(victory[4]),
        'Current material victory condition unavailable',
    )
    const objects = source.filter((row) => row.spawnerId === victory[1])
    valid(
        entry.victory?.kind === victory[0] &&
            entry.victory.spawnerId === victory[1] &&
            entry.victory.count === victory[4] &&
            objects.length === victory[4] &&
            Array.isArray(entry.victory.object_ids) &&
            sameIds(
                entry.victory.object_ids,
                objects.map((row) => row.id),
            ),
        'Current material victory object coverage changed',
    )
    const stages = [],
        omitted = []
    for (const wait of contract.model.waits) {
        const rows = source.filter((row) =>
            String(row.commonTag ?? '')
                .split('|')
                .includes(String(wait.tag)),
        )
        if (!rows.length) {
            omitted.push(wait.tag)
            continue
        }
        ensure(rows.length === 1, 'Parallel material wait selection is unsupported', ErrorCode.FunctionClosed)
        const row = rows[0],
            type = one('world_spawner', row.spawnerId)?.objectType
        valid(
            type === (stages.length ? 50 : 13) &&
                !row.initialCompleteState &&
                !stages.some((stage) => stage.row.id === row.id),
            'Current material wait phase is inconsistent',
        )
        const stage = { index: stages.length + 1, type, row: structuredClone(row) }
        const bound = entry.stages?.[stages.length]
        valid(
            bound &&
                bound.index === stage.index &&
                bound.type === type &&
                bound.object_id === row.id &&
                bound.tag === wait.tag &&
                bound.variable === wait.variable &&
                bound.waitNode === wait.waitNode &&
                bound.createNode === wait.createNode,
            'Current material compiled wait binding changed',
        )
        stages.push(stage)
    }
    valid(
        Array.isArray(entry.omittedTags) &&
            sameIds(entry.omittedTags, omitted) &&
            stages.length > 1 &&
            sameIds(
                stages.slice(1).map((stage) => stage.row.id),
                objects.map((row) => row.id),
            ),
        'Current material executable stages do not cover victory objects',
    )
    valid(
        groups.every((group) => {
            const members = String(group.enemyList ?? '')
                .split('|')
                .filter(Boolean)
            return members.length > 0 && members.length <= 24 && members.every((id) => positive(Number(id)))
        }),
        'Current material group slots unavailable',
    )
    const boxes = snapshot.boxes,
        anchors = indexed.filter((stage) => stage.type === 30)
    valid(
        boxes.length === 1 &&
            anchors.length === 1 &&
            boxes[0].id === entry.chest?.drop_id &&
            boxes[0].worldmapcityid === scene.id &&
            boxes[0].worldmapid === entry.chest.object_id &&
            anchors[0].row.id === entry.chest.object_id &&
            anchors[0].index === stages.length + 1,
        'Current material chest anchor changed',
    )
    const last = entry.stages?.[stages.length]
    valid(
        entry.stages?.length === stages.length + 1 &&
            last?.type === 30 &&
            last.index === anchors[0].index &&
            last.object_id === anchors[0].row.id &&
            last.tag === undefined,
        'Current material terminal chest binding changed',
    )
    stages.push({ index: anchors[0].index, type: 30, row: structuredClone(anchors[0].row) })
    valid(
        indexed.length >= 2 &&
            indexed.every((anchor) =>
                stages.some(
                    (stage) =>
                        stage.index === anchor.index && stage.type === anchor.type && stage.row.id === anchor.row.id,
                ),
            ),
        'Current material stage order conflicts with explicit anchors',
    )
    plans.set(key, { signature, refs, stages })
    return stages
}

export function materialBlueprintStages(tables, scene, material, indexed) {
    const source = tables.get(`worldmap_${scene.id}`)
    const victory = String(scene.victoryCondition).split('#').map(Number)
    const objects = source.filter((r) => r.spawnerId === victory[1])
    const indexedIds = new Set(indexed.map((r) => r.row.id))
    if (!objects.some((r) => !indexedIds.has(r.id))) return indexed
    if (scene.blueprintId === 300358 || scene.serverBlueprintId === 300351)
        return currentMaterialBlueprintStages(tables, scene, material, indexed, currentContract())
    ensure(false, 'Material blueprint stage topology is not supported', ErrorCode.FunctionClosed)
}
