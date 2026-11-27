import { createHash } from 'node:crypto'
import { enemyDefinition, enemyBaseHpValue } from './enemy-state.js'
import { dungeonEnemyScales, scaledEnemyHp } from './dungeon-enemy-scale.js'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const caches = new WeakMap(),
    uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
export function sharedEncounterBlueprint(tables, compiled, participants) {
    let cache = caches.get(tables)
    if (!cache) caches.set(tables, (cache = new Map()))
    const key = `${compiled.fingerprint}:${participants}`
    if (cache.has(key)) return cache.get(key)
    const { definition, route } = compiled,
        stages = compiled.stages.map((stage) => ({ index: stage.index, object_id: stage.row.id, type: stage.type })),
        groups = {},
        entities = {},
        view = {
            world: tables.position(route.point),
            tasks: [],
            worldObjects: {},
            entrust: { run: { kind: definition.kind, dungeon_id: definition.dungeonId, map_id: route.scene.id } },
        }
    for (const row of tables.get(`worldmap_${route.scene.id}`)) {
        if (tables.find('world_spawner', row.spawnerId)?.objectType !== 50) continue
        const source = tables.find('world_enemy_group', row.expandId),
            packs = String(source?.enemyList ?? '')
                .split('|')
                .filter(Boolean)
                .map(Number),
            scales = dungeonEnemyScales(tables, definition.dungeonId, route.scene.id, row.expandId, participants),
            stage = stages.find((value) => value.object_id === row.id)
        ensure(
            packs.length > 0 && packs.length <= 24 && packs.every((id) => uint(id) && id > 0),
            'Shared static enemy roster is unavailable',
            ErrorCode.NoEnemyConf,
        )
        const ids = []
        for (let slot = 0; slot < packs.length; slot++) {
            const pack = tables.find('enemy_pack', packs[slot])
            ensure(pack, 'Shared enemy pack is unavailable', ErrorCode.NoEnemyConf)
            ensure(
                [2, 3].includes(pack.levelPolicy) && pack.specialCreateType !== 1,
                'Shared variable-level or AI-hero encounter is not implemented',
                ErrorCode.FunctionClosed,
            )
            const id = ((3n << 56n) | (BigInt(slot) << 32n) | BigInt(row.id)).toString(),
                base = enemyDefinition(tables, view, id)
            ensure(base, 'Shared enemy attributes are unavailable', ErrorCode.NoEnemyConf)
            const enemy = tables.find('enemy', base.config_id),
                hpIndex = enemy?.hpIndex
            ensure(
                !(Array.isArray(hpIndex) ? hpIndex.length : String(hpIndex ?? '').length),
                'Shared multiple-HP-phase encounter is not implemented',
                ErrorCode.FunctionClosed,
            )
            const rawHp = enemyBaseHpValue(tables, base)
            ensure(
                rawHp !== null && Number.isFinite(rawHp) && rawHp > 0,
                'Shared base enemy HP is malformed',
                ErrorCode.GameConfig,
            )
            entities[id] = { ...base, uuid: id, base_max_hp: base.max_hp, max_hp: scaledEnemyHp(rawHp, scales) }
            ids.push(id)
        }
        groups[row.id] = {
            object_id: row.id,
            group_id: row.expandId,
            stage_index: stage?.index ?? null,
            ids,
            scales: [...scales],
            source: row,
        }
    }
    ensure(
        Object.keys(groups).length > 0 &&
            compiled.objects.every((object) => groups[object.objectId]?.ids.length === object.count),
        'Shared victory roster is incomplete',
        ErrorCode.GameConfig,
    )
    const data = {
        version: '1.0.0/3217420',
        target: compiled.fingerprint,
        participants,
        map_id: route.scene.id,
        dungeon_id: definition.dungeonId,
        initial_stage: stages[0].index,
        stages,
        groups,
        entities,
    }
    const blueprint = { ...data, fingerprint: createHash('sha256').update(JSON.stringify(data)).digest('hex') }
    cache.set(key, blueprint)
    return blueprint
}
export function newSharedEncounter(blueprint, now) {
    ensure(uint(now), 'Shared encounter clock is malformed', ErrorCode.GameConfig)
    return {
        schema_version: 1,
        source_fingerprint: blueprint.fingerprint,
        created_at: now,
        stage_index: blueprint.initial_stage,
        proxy_reports: {},
        entities: Object.fromEntries(
            Object.entries(blueprint.entities).map(([id, definition]) => [
                id,
                {
                    uuid: id,
                    pack_id: definition.pack_id,
                    config_id: definition.config_id,
                    level: definition.level,
                    max_hp: definition.max_hp,
                    hp: definition.max_hp,
                    sp: 0,
                    alive_state: 0,
                },
            ]),
        ),
    }
}
export function validateSharedEncounter(run, blueprint) {
    const value = run.encounter
    ensure(
        value &&
            value.schema_version === 1 &&
            value.source_fingerprint === blueprint.fingerprint &&
            uint(value.created_at) &&
            blueprint.stages.some((stage) => stage.index === value.stage_index) &&
            value.proxy_reports &&
            typeof value.proxy_reports === 'object' &&
            !Array.isArray(value.proxy_reports) &&
            value.entities &&
            typeof value.entities === 'object' &&
            Object.keys(value.entities).length === Object.keys(blueprint.entities).length,
        'Shared encounter header/source is malformed',
        ErrorCode.GameConfig,
    )
    for (const [id, definition] of Object.entries(blueprint.entities)) {
        const entity = value.entities[id]
        ensure(
            entity &&
                entity.uuid === id &&
                entity.pack_id === definition.pack_id &&
                entity.config_id === definition.config_id &&
                entity.level === definition.level &&
                entity.max_hp === definition.max_hp &&
                uint(entity.hp) &&
                entity.hp <= entity.max_hp &&
                uint(entity.sp) &&
                entity.alive_state === (entity.hp === 0 ? 1 : 0),
            'Shared enemy state is malformed',
            ErrorCode.GameConfig,
        )
    }
    for (const [id, report] of Object.entries(value.proxy_reports)) {
        const member = run.members.find((candidate) => String(candidate.id) === id)
        ensure(
            member &&
                report?.generation === run.generation &&
                report.lease === member.lease &&
                report.connection_hash === member.admission_connection_hash &&
                uint(report.at),
            'Shared proxy report is malformed or detached',
            ErrorCode.GameConfig,
        )
    }
    if (value.battle_start_time !== undefined)
        ensure(
            uint(value.battle_start_time) && value.battle_start_time > 0,
            'Shared battle start clock is malformed',
            ErrorCode.GameConfig,
        )
    if (value.control !== undefined && value.control !== null) {
        const control = value.control,
            group = blueprint.groups[control.object_id],
            member = run.members.find((candidate) => candidate.id === control.player_id)
        ensure(
            uint(control.object_id) &&
                control.object_id > 0 &&
                group &&
                group.stage_index === value.stage_index &&
                member &&
                control.generation === run.generation &&
                control.lease === member.lease &&
                control.connection_hash === member.admission_connection_hash &&
                uint(control.granted_at) &&
                uint(control.epoch) &&
                control.epoch > 0 &&
                value.control_epoch === control.epoch &&
                value.battle_start_time !== undefined,
            'Shared NPC control grant is malformed or detached',
            ErrorCode.GameConfig,
        )
    }
    if (value.control_epoch !== undefined)
        ensure(
            uint(value.control_epoch) && value.control_epoch > 0,
            'Shared control epoch is malformed',
            ErrorCode.GameConfig,
        )
    return value
}
export function requireFreshSharedEntry(state, blueprint) {
    const entry = state.entrust?.run
    ensure(
        entry?.status === 2 &&
            !entry.battle_complete &&
            entry.stage_index === blueprint.initial_stage &&
            String(entry.damage_total ?? '0') === '0' &&
            !entry.materialStory,
        'Shared encounter requires a fresh private entry',
        ErrorCode.TeamInBattle,
    )
    for (const [id, definition] of Object.entries(blueprint.entities)) {
        const entity = state.combat?.entities?.[id]
        ensure(
            entity && entity.pack_id === definition.pack_id && entity.level === definition.level,
            'Shared entry enemy metadata is not prepared',
            ErrorCode.GameConfig,
        )
        ensure(
            entity.hp === entity.max_hp && entity.alive_state === 0,
            'Shared entry already contains combat progress',
            ErrorCode.TeamInBattle,
        )
    }
}
export function sharedEncounterObjects(records, encounter, blueprint) {
    return records.map((original) => {
        const stage = blueprint.stages.find((value) => value.object_id === original.obj_id),
            group = blueprint.groups[original.obj_id]
        // A chest is a personal claim/receipt projection,not a global reward.
        if (!group && stage?.type !== 13) return original
        const record = structuredClone(original),
            index = group ? group.stage_index : stage.index,
            finished = index !== null && index < encounter.stage_index
        record.active = index === null || index === encounter.stage_index
        record.complete = finished
        record.state_data = { ...record.state_data, step: finished ? 1 : 0, complete: finished }
        if (group) {
            const previous = record.expand_data?.battle_group ?? {},
                old = new Map((previous.monsters ?? []).map((monster) => [String(monster.uid), monster]))
            record.time = encounter.created_at
            record.next_time = 0
            record.expand_data = {
                ...record.expand_data,
                battle_group: {
                    ...previous,
                    monsters: group.ids.map((id) => {
                        const definition = blueprint.entities[id],
                            entity = encounter.entities[id]
                        return {
                            ...old.get(id),
                            uid: id,
                            obj_type: 3,
                            id: entity.config_id,
                            enemy_pack: entity.pack_id,
                            level: entity.level,
                            hp: entity.hp,
                            obj_key: { obj_id: group.object_id, obj_index: definition.slot, group_id: group.group_id },
                        }
                    }),
                    world_indexes: group.ids
                        .filter((id) => encounter.entities[id].hp > 0)
                        .map((id) => blueprint.entities[id].slot),
                },
            }
        }
        return record
    })
}
