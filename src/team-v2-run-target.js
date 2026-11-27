import { createHash } from 'node:crypto'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { getEntrustCatalog } from './entrust.js'
import { legacyMatchTarget } from './legacy-match-teams.js'

const families = new Map([
    [101, ['material', 'dungeon_material']],
    [500, ['weekly', 'dungeon_weekly']],
    [1, ['crisis', 'dungeon_crisiscrusade']],
])
const positive = (value) => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff

// TeamV2 uses campaign type + system-row ID. Dungeon IDs are only the proven
// internal route/gate bridge; neither old room IDs nor wire targets are reused.
export function sharedTeamTargetDefinition(tables, room) {
    ensure(
        room && families.has(room.typ) && positive(room.target?.dungeon_system_id),
        'Malformed shared team target',
        ErrorCode.GameConfig,
    )
    const [kind, table] = families.get(room.typ),
        row = tables.find(table, room.target.dungeon_system_id)
    ensure(
        row && positive(row.dungeonId) && tables.find('dungeon', row.dungeonId),
        'Shared team target configuration unavailable',
        ErrorCode.DungeonConfNotExist,
    )
    return { typ: room.typ, kind, table, configId: row.id, dungeonId: row.dungeonId, row }
}

export function requireSharedTeamTargetEligibility(c, room, id, state) {
    const definition = sharedTeamTargetDefinition(c.tables, room)
    const actual = legacyMatchTarget(
        { ...c, id, state },
        { dungeon_id: definition.dungeonId, scene_type: 12, dungeon_site: 0 },
    )
    ensure(
        actual.kind === definition.kind && actual.config_id === definition.configId,
        'Shared team target is ambiguous or changed',
        ErrorCode.GameConfig,
    )
    return definition
}

export function compileSharedTeamTarget(tables, room) {
    const definition = sharedTeamTargetDefinition(tables, room)
    // Crisis has a distinct current source, chest and victory grammar. It is
    // not a material/commission alias. Its entry producer remains a next block.
    ensure(
        definition.kind !== 'crisis',
        'Shared crisis encounter producer is not implemented',
        ErrorCode.FunctionClosed,
    )
    const catalog = getEntrustCatalog(tables),
        route = catalog.get(definition.configId, definition.kind)
    const objects = catalog.victoryObjects(definition.configId, definition.kind),
        stages = catalog.stages(definition.configId, definition.kind)
    ensure(
        route.dungeon.id === definition.dungeonId && objects.length > 0 && stages.length > 0,
        'Shared dungeon route is incomplete',
        ErrorCode.GameConfig,
    )
    const source = {
        typ: definition.typ,
        configId: definition.configId,
        dungeonId: definition.dungeonId,
        mapId: route.scene.id,
        point: route.point,
        dungeon: route.dungeon,
        scene: route.scene,
        target: definition.row,
        chest: route.chest,
        objects,
        stages,
    }
    return {
        definition,
        route,
        objects,
        stages,
        fingerprint: createHash('sha256').update(JSON.stringify(source)).digest('hex'),
    }
}
