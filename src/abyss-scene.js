import { abyssTables, abyssRoute } from './abyss-catalog.js'
import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'
import { combatState } from './combat-state.js'
import { enemyDefinition } from './enemy-state.js'
import { visibleEnemySlots } from './enemy-group-visibility.js'

// CBT3 AbyssGraphComponent.OnGraphInitSuccess (0602b4df) sends empty9509
// after graph initialization. It confirms the admitted room, not battle start.
export function acknowledgeAbyssSceneLoaded(external, state) {
    const run = state.abyssRun,
        positive = (value) => Number.isSafeInteger(value) && value > 0,
        object = (value) => value && typeof value === 'object' && !Array.isArray(value)
    ensure(
        object(run) &&
            [1, 2, 3].includes(run.mode) &&
            positive(run.level_id) &&
            positive(run.map_id) &&
            positive(run.dungeon_id) &&
            positive(run.instance_id) &&
            Number.isSafeInteger(run.part_index) &&
            run.part_index >= 0 &&
            Array.isArray(run.rooms) &&
            run.part_index < run.rooms.length &&
            ['ready', 'intro', 'running', 'won', 'lost'].includes(run.phase),
        'Malformed abyss scene acknowledgment context',
        ErrorCode.GameConfig,
    )
    ensure(state.world?.map_id === run.map_id, 'Abyss scene is not active', ErrorCode.NotInDungeonMap)
    const tables = abyssTables(external),
        level = tables.find('abbys_level', run.level_id),
        ids = String(level?.dungeonId ?? '')
            .split('|')
            .map(Number),
        room = run.rooms[run.part_index]
    ensure(
        level?.mode === run.mode &&
            ids.every(positive) &&
            run.rooms.length === ids.length &&
            object(room) &&
            room.dungeon_id === ids[run.part_index] &&
            room.dungeon_id === run.dungeon_id &&
            room.map_id === run.map_id &&
            positive(room.point_id),
        'Abyss scene acknowledgment does not match its admitted level room',
        ErrorCode.GameConfig,
    )
    const { route } = abyssRoute(tables, run.dungeon_id)
    ensure(
        route.map_id === run.map_id && route.point_id === room.point_id,
        'Abyss scene acknowledgment route differs from its admitted room',
        ErrorCode.GameConfig,
    )
    // Do not use requireAbyssRun here: its mode3 refresh writes rotation_end.
    // Actual game actions retain their existing time/rotation guards.
    return {}
}

export function ensureAbyssScene(external, state, now) {
    const run = state.abyssRun
    if (!run || run.map_id !== state.world.map_id) return false
    const tables = abyssTables(external),
        { route } = abyssRoute(tables, run.dungeon_id),
        rows = tables.get('worldmap_' + run.map_id),
        records = (state.worldObjects ??= {})
    if (run.initialized_map !== run.map_id) {
        for (const key of Object.keys(records)) if (key.startsWith(run.map_id + ':')) delete records[key]
        delete state.combat
        run.initialized_map = run.map_id
    }
    const battle = combatState(state, now),
        battleIds = new Set(route.object_ids),
        activeWave = run.wave_objects ?? [],
        deadIds = new Set(run.completed_objects ?? [])
    for (const row of rows) {
        const key = run.map_id + ':' + row.id,
            position = String(row.position)
                .split('|')
                .map((x) => Math.round(Number(x) * 100))
        ensure(
            position.length === 3 && position.every(Number.isFinite),
            'Invalid abyss object position',
            ErrorCode.GameConfig,
        )
        const record = (records[key] ??= {
            obj_id: row.id,
            active: row.initStatus !== 1,
            complete: false,
            pos: { x: position[0], y: position[1], z: position[2] },
            state_data: { step: 0, complete: false },
            time: run.start_time,
            next_time: 0,
        })
        if (row.spawnerId === 6021401) {
            record.active = run.phase === 'ready'
            record.complete = run.phase !== 'ready'
            record.state_data = { step: 0, complete: record.complete }
        }
        if (!battleIds.has(row.id)) continue
        record.complete = deadIds.has(row.id)
        record.active = ['running', 'intro'].includes(run.phase) && activeWave.includes(row.id) && !record.complete
        record.state_data = { step: 0, complete: record.complete }
        const group = tables.find('world_enemy_group', row.expandId),
            packs = String(group?.enemyList ?? '')
                .split('|')
                .filter(Boolean)
        ensure(packs.length, 'Missing abyss enemy group', ErrorCode.NoEnemyConf)
        const monsters = packs.map((_, slot) => {
            const uid = ((3n << 56n) | (BigInt(slot) << 32n) | BigInt(row.id)).toString(),
                base = enemyDefinition(tables, state, uid)
            ensure(base?.level > 0, 'Missing abyss enemy level/attributes', ErrorCode.NoEnemyConf)
            const max_hp = base.max_hp
            ensure(
                Number.isSafeInteger(max_hp) && max_hp > 0 && max_hp <= 0xffffffff,
                'Invalid abyss enemy HP scale',
                ErrorCode.GameConfig,
            )
            const entity = (battle.entities[uid] ??= {
                uuid: uid,
                ...base,
                max_hp,
                hp: max_hp,
                sp: 0,
                alive_state: 0,
                updated_at: now,
            })
            return {
                uid,
                obj_type: 3,
                id: base.config_id,
                enemy_pack: base.pack_id,
                level: base.level,
                hp: entity.hp,
                obj_key: { obj_id: row.id, obj_index: slot, group_id: row.expandId },
                move: { pos: record.pos, move_status: 1, area_id: state.world.area_id },
            }
        })
        record.expand_data = { battle_group: { monsters, world_indexes: visibleEnemySlots(monsters, battle.entities) } }
    }
    run.scene_objects = rows.map((x) => {
        const { claims, ...wire } = records[run.map_id + ':' + x.id]
        return wire
    })
    return true
}
