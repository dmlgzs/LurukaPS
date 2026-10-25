import compiled from '../configs/material-blueprint-stages.json' with { type: 'json' }
import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'

const positive = (n) => Number.isSafeInteger(n) && n > 0 && n <= 0xffffffff
export function materialBlueprintStages(tables, scene, material, indexed) {
    const source = tables.get(`worldmap_${scene.id}`)
    const victory = String(scene.victoryCondition).split('#').map(Number)
    const objects = source.filter((r) => r.spawnerId === victory[1])
    const indexedIds = new Set(indexed.map((r) => r.row.id))
    if (!objects.some((r) => !indexedIds.has(r.id))) return indexed
    const blueprint = tables.find('world_blueprint', scene.blueprintId)
    ensure(
        compiled.version === 1 &&
            compiled.projection === 'serial-present-wait-tags-with-explicit-auto-anchors' &&
            scene.blueprintId === compiled.blueprintId &&
            blueprint?.path === compiled.path,
        'Material blueprint stage topology is not supported',
        ErrorCode.FunctionClosed,
    )
    ensure(
        ['param', 'listIntParam', 'intParam', 'boolParam'].every((field) => !String(scene[field] ?? '').trim()) &&
            !scene.serverBlueprintId &&
            ['param', 'stringParam', 'intParam', 'boolParam'].every(
                (field) => !String(blueprint[field] ?? '').trim(),
            ) &&
            !blueprint.paramTemplate,
        'Material blueprint variable overrides need a verified projection',
        ErrorCode.FunctionClosed,
    )
    ensure(
        victory.length === 5 &&
            victory[0] === 2500 &&
            positive(victory[1]) &&
            victory[2] === 0 &&
            victory[3] === 0 &&
            positive(victory[4]) &&
            objects.length === victory[4],
        'Material blueprint victory objects are inconsistent',
        ErrorCode.GameConfig,
    )
    ensure(
        Array.isArray(compiled.waits) &&
            compiled.waits.length > 1 &&
            compiled.waits.every((r) => positive(r?.tag)) &&
            new Set(compiled.waits.map((r) => r.tag)).size === compiled.waits.length &&
            Array.isArray(compiled.conditions) &&
            compiled.conditions.every((r) => r?.value === 0),
        'Invalid compiled material blueprint stages',
        ErrorCode.GameConfig,
    )
    const protectedNames = new Set([
        ...compiled.waits.map((r) => r.variable),
        ...compiled.conditions.map((r) => r.name),
    ])
    ensure(
        String(scene.stringParam ?? '')
            .split('|')
            .every((r) => !protectedNames.has(r.split('#')[0])),
        'Material blueprint typed variables cannot be overridden through string parameters',
        ErrorCode.FunctionClosed,
    )
    const rows = [],
        used = new Set()
    for (const wait of compiled.waits) {
        const matches = source.filter((row) =>
            String(row.commonTag ?? '')
                .split('|')
                .includes(String(wait.tag)),
        )
        if (!matches.length) continue // Exact WaitByTag body completes an absent tag immediately.
        ensure(
            matches.length === 1,
            'Parallel or duplicate material blueprint wait objects are not supported',
            ErrorCode.FunctionClosed,
        )
        const row = matches[0],
            type = tables.find('world_spawner', row.spawnerId)?.objectType
        ensure(
            positive(row.id) && !used.has(row.id) && (rows.length === 0 ? type === 13 : type === 50),
            'Material blueprint wait object does not match a serial marker or enemy phase',
            ErrorCode.GameConfig,
        )
        ensure(!row.initialCompleteState, 'Material blueprint phase starts already completed', ErrorCode.FunctionClosed)
        used.add(row.id)
        rows.push({ index: rows.length + 1, type, row })
    }
    ensure(rows.length > 1 && rows[0].type === 13, 'Material blueprint has no real enemy phases', ErrorCode.GameConfig)
    const enemies = rows.slice(1)
    ensure(
        enemies.length === objects.length && enemies.every((r) => objects.some((o) => o.id === r.row.id)),
        'Material blueprint phases do not cover every configured victory object',
        ErrorCode.GameConfig,
    )
    for (const phase of enemies) {
        const group = tables.find('world_enemy_group', phase.row.expandId)
        const members = String(group?.enemyList ?? '')
            .split('|')
            .filter(Boolean)
        ensure(
            group && members.length > 0 && members.length <= 24,
            'Material blueprint enemy group unavailable',
            ErrorCode.GameConfig,
        )
    }
    // The graph terminal creates victory music and runs Finish, not the chest.
    // Bind that final phase to the separately configured existing box anchor.
    const anchors = indexed.filter((r) => r.type === 30)
    const boxes = tables.get('stamina_chest_drop').filter((r) => r.worldFilter === `4|${material.dungeonId}`)
    ensure(
        anchors.length === 1 &&
            boxes.length === 1 &&
            boxes[0].worldmapcityid === scene.id &&
            boxes[0].worldmapid === anchors[0].row.id,
        'Material blueprint chest anchor is ambiguous',
        ErrorCode.GameConfig,
    )
    rows.push({ ...anchors[0], index: rows.length + 1 })
    ensure(
        indexed.length >= 2 &&
            indexed.some((r) => r.type === 13) &&
            indexed.every((anchor) =>
                rows.some((r) => r.row.id === anchor.row.id && r.type === anchor.type && r.index === anchor.index),
            ),
        'Material blueprint order conflicts with explicit automatic stage anchors',
        ErrorCode.GameConfig,
    )
    return rows
}
