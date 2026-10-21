import { ErrorCode } from './error-codes.js'
import { visibleEnemySlots } from './enemy-group-visibility.js'
import { ensure } from './handlers/common.js'
import { combatState } from './combat-state.js'
import { enemyDefinition } from './enemy-state.js'
import { recordMaterialVictory } from './material-dungeons.js'

const catalogs = new WeakMap()
export function getEntrustCatalog(tables) {
    let catalog = catalogs.get(tables)
    if (!catalog) {
        catalog = new EntrustCatalog(tables)
        catalogs.set(tables, catalog)
    }
    return catalog
}

export class EntrustCatalog {
    constructor(tables) {
        this.tables = tables
        this.scenes = new Map()
        this.stageCache = new Map()
    }

    get(id) {
        ensure(Number.isInteger(id) && id > 0, 'Invalid entrust ID')
        const commission = this.tables.find('dungeon_entrust', id),
            material = commission ? null : this.tables.find('dungeon_material', id),
            entrust = commission ?? (material && { ...material, groupId: material.type, taskUnlock: material.unlock })
        ensure(entrust, 'Unknown entrust', ErrorCode.EntrustConfigNone)
        const dungeon = this.tables.find('dungeon', entrust.dungeonId)
        ensure(dungeon, 'Entrust dungeon configuration unavailable', ErrorCode.DungeonConfNotExist)
        if (!this.scenes.has(id)) {
            // The box filter is the explicit dungeon-to-scene relationship.
            // Numbered [test] city labels do NOT correspond to entrust IDs.
            const chest = this.tables
                .get('stamina_chest_drop')
                .find((row) => row.worldFilter === `${material ? 4 : 1}|${dungeon.id}`)
            const city = chest && this.tables.find('world_city', chest.worldmapcityid)
            const scene = city && this.tables.find('dungeon_scene', city.id)
            const point =
                city && this.tables.get('world_borthpos').find((row) => row.cityId === city.id && row.mainPoint === 1)
            // The scene table can override the dungeon row's generic victory
            // count (for example, chapter boss scenes have one container).
            ensure(
                city && scene?.mapId === city.id && point,
                'Entrust scene mapping unavailable',
                ErrorCode.InstanceSceneConfNotExist,
            )
            this.scenes.set(id, { city, scene, point, chest })
        }
        return { entrust, dungeon, material, ...this.scenes.get(id) }
    }

    victoryObjects(id) {
        const { scene } = this.get(id)
        const [kind, spawner, , , count, ...extra] = String(scene.victoryCondition).split('#').map(Number)
        ensure(
            kind === 2500 && spawner > 0 && count > 0 && !extra.length,
            'Unsupported entrust victory condition',
            ErrorCode.GameConfig,
        )
        const rows = this.tables.get(`worldmap_${scene.id}`).filter((row) => row.spawnerId === spawner)
        ensure(rows.length === count, 'Entrust victory objects do not match configuration', ErrorCode.GameConfig)
        return rows.map((row) => {
            const group = this.tables.find('world_enemy_group', row.expandId)
            const enemies = String(group?.enemyList ?? '')
                .split('|')
                .filter(Boolean)
            ensure(enemies.length > 0 && enemies.length <= 24, 'Entrust enemy group unavailable', ErrorCode.GameConfig)
            return { objectId: row.id, count: enemies.length }
        })
    }

    stages(id) {
        if (!this.stageCache.has(id)) {
            const { scene } = this.get(id)
            const rows = this.tables
                .get(`worldmap_${scene.id}`)
                .flatMap((row) => {
                    const token = String(row.expandParams ?? '')
                        .split('|')
                        .find((part) => part.toLowerCase().startsWith('autobattleindex#'))
                    if (!token) return []
                    const index = Number(token.split('#')[1])
                    const type = this.tables.find('world_spawner', row.spawnerId)?.objectType
                    ensure(
                        Number.isInteger(index) && index > 0 && [13, 30, 50].includes(type),
                        'Unsupported entrust stage',
                        ErrorCode.GameConfig,
                    )
                    return [{ index, type, row }]
                })
                .sort((a, b) => a.index - b.index)
            ensure(
                rows.length >= 3 &&
                    rows[0].type === 13 &&
                    rows.at(-1).type === 30 &&
                    rows.slice(1, -1).every((row) => row.type === 50) &&
                    rows.every((row, index) => index === 0 || row.index > rows[index - 1].index),
                'Invalid entrust stage order',
                ErrorCode.GameConfig,
            )
            this.stageCache.set(id, rows)
        }
        return this.stageCache.get(id)
    }

    chest(id) {
        const { dungeon, material } = this.get(id)
        const row = this.tables.get('stamina_chest_drop').find((entry) => {
            const [type, target] = String(entry.worldFilter).split('|').map(Number)
            return type === (material ? 4 : 1) && target === dungeon.id
        })
        ensure(
            row && row.worldmapid === this.stages(id).at(-1).row.id,
            'Entrust chest configuration unavailable',
            ErrorCode.NoStaminaBoxDropConf,
        )
        return row
    }
}

export function settleEntrustVictory(tables, state, now) {
    const run = state.entrust?.run
    if (!run || run.battle_complete || !run.end_time || !run.battle_start_time) return false
    const catalog = getEntrustCatalog(tables)
    if (!entrustVictoryComplete(catalog, state, run.entrust_id)) return false
    const { scene, entrust } = catalog.get(run.entrust_id)
    const goals = tables
        .get('common_challenge')
        .filter((row) => row.group === scene.challengeGroup && row.type === 1)
        .sort((a, b) => a.id - b.id)
    const elapsed = run.end_time - run.battle_start_time
    let mask = 0
    goals.forEach((goal, index) => {
        const [type, a, b] = String(goal.challengeCondition).split('#').map(Number)
        // Unsupported requirements must never award an unearned star.
        const met =
            type === 3006
                ? elapsed <= a
                : type === 60007 && a === 0
                  ? run.hero_deaths !== undefined && run.hero_deaths < b
                  : false
        if (met) mask |= 1 << index
    })
    run.battle_complete = true
    // Old completed saves never received a claimable box. Give that one
    // recovered box its configured window once, without changing clear time.
    run.chest_ready_time = run.hero_deaths === undefined ? Math.max(run.end_time, now ?? run.end_time) : run.end_time
    run.status = 3
    run.star_mask = mask
    run.star = goals.reduce((count, _, index) => count + ((mask >>> index) & 1), 0)
    if (run.damage_total === undefined) {
        run.damage_total = String(
            Object.values(state.combat.entities).reduce(
                (total, enemy) => total + (enemy.max_hp ? Math.max(0, enemy.max_hp - enemy.hp) : 0),
                0,
            ),
        )
        run.damage_recovered_from_hp = true
    }
    if (run.kind === 'material') {
        recordMaterialVictory(tables, state, run, mask)
        return true
    }
    const old = state.entrust.records[run.entrust_id]
    state.entrust.records[run.entrust_id] = {
        ...old,
        entrust_id: run.entrust_id,
        entrust_star: Math.max(run.star, old?.entrust_star ?? 0),
        success_time: String(old?.success_time ?? run.end_time),
        group_id: entrust.groupId,
        difficulty_id: 0,
        entrust_start_bit: (old?.entrust_start_bit ?? 0) | mask,
        first_reward_claimed: old ? (old.first_reward_claimed ?? true) : false,
    }
    return true
}

export function entrustChestSnapshot(tables, state) {
    const run = state.entrust?.run
    if (!run?.battle_complete) return { boxes: [] }
    const chest = getEntrustCatalog(tables).chest(run.entrust_id)
    return {
        boxes: [
            {
                box_id: chest.id,
                finish_time: run.chest_claimed ? 0 : (run.chest_ready_time ?? run.end_time),
                map_id: run.map_id,
                box_count: run.chest_claimed ? (run.claim_times ?? 1) : 0,
                stage_type: run.kind === 'material' ? 4 : 1,
                stage_id: run.dungeon_id,
            },
        ],
    }
}

export function entrustDamageSnapshot(state, accountId) {
    return { info: [{ player_id: accountId, sum_dmg: state.entrust?.run?.damage_total ?? '0' }] }
}

export function entrustInfoSnapshot(state) {
    return {
        data: Object.values(state.entrust?.records ?? {}).map(
            ({ first_reward_claimed, pending_chest, ...wire }) => wire,
        ),
    }
}

export function entrustStarRewardSnapshot(state) {
    return { data: Object.values(state.entrust?.starRewards ?? {}) }
}

export function campaignSnapshot(run) {
    return {
        start_time: run.battle_start_time ?? run.start_time,
        real_start_time: run.real_start_time ?? 0,
        status: run.status,
        star: run.star_mask ?? 0,
        total_elapse_time: run.end_time && run.battle_start_time ? run.end_time - run.battle_start_time : 0,
        star_values: [],
        win_values: [],
        lose_values: [],
        cur_scene_id: run.map_id,
        end_time: run.end_time ?? 0,
        dungeon_id: run.dungeon_id,
        // CBT3 EntityLevelUtility looks up dungeon[GetDungeonInstanceId()].
        // This wire field is a configuration ID, not our per-run serial.
        // Keep instance_id server-side for cache isolation and fresh retries.
        dungeon_instance_id: run.dungeon_id,
        scene_datas: [
            {
                scene_id: run.map_id,
                scene_status: run.status === 3 ? 1 : 0,
                cur_step: Math.max(0, (run.stage_index ?? 1) - 1),
                objs: run.scene_objects ?? [],
            },
        ],
    }
}

export function entrustMultiSnapshot(run) {
    return {
        dungeon_id: run.dungeon_id,
        status: run.status === 2 ? (run.stage_index > 1 ? 3 : 2) : run.status === 3 ? 4 : run.status === 5 ? 6 : 1,
        // MultiplePlayingData passes these timestamps to a millisecond timer.
        // Supplying Unix seconds made the UI display roughly 20,704 days.
        start_time: String((run.battle_start_time ?? 0) * 1000),
        end_time: String((run.end_time ?? 0) * 1000),
        dungeon_scene_id: run.map_id,
        map_id: run.map_id,
        line_id: 1,
        star: run.star_mask ?? 0,
        clearance_time: String(
            run.end_time && run.battle_start_time ? (run.end_time - run.battle_start_time) * 1000 : 0,
        ),
    }
}

export function entrustMultiBaseSnapshot(state, accountId) {
    const manager = state.player.group_mgrs.find((entry) => entry.type === 1)
    const formation = manager?.groups.find((entry) => entry.id === manager.cur_group)
    const active = (formation?.heros ?? [])
        .map((entry) => state.player.heros_info.heros.find((hero) => hero.guid === entry.hero_id))
        .filter(Boolean)
    ensure(active.length > 0, 'Entrust formation has no hero')
    const control = active.find((hero) => hero.guid === formation.control) ?? active[0]
    return {
        dungeon_id: state.entrust.run.dungeon_id,
        dungeon_scene_id: state.entrust.run.map_id,
        player_list: [
            {
                player_id: accountId,
                hero_id: control.conf_id,
                name: Buffer.from(state.player.basic_info.name, 'base64').toString('utf8'),
                lv: state.player.basic_info.lv,
                heros: active.map((hero) => ({ hero_id: hero.conf_id })),
            },
        ],
        team_option_list: [{ player_id: accountId, stay: true }],
        player_status_list: [{ player_id: accountId, status: 1 }],
    }
}

export function ensureEntrustSceneObjects(tables, state, now) {
    const run = state.entrust?.run
    if (!run || state.world.map_id !== run.map_id) return false
    const config = getEntrustCatalog(tables).get(run.entrust_id)
    if (run.map_id !== config.scene.id) {
        run.migrated_from_map = run.map_id
        run.map_id = config.scene.id
        Object.assign(state.world, tables.position(config.point))
        delete state.combat
        delete run.scene_objects
        // Preserve the completed wave index and victory/claim receipt. The
        // correct map has different group IDs; completed groups stay dead.
        if (run.battle_complete && !run.chest_claimed) run.chest_ready_time = now ?? run.chest_ready_time
    }
    const records = (state.worldObjects ??= {})
    let changed = false
    const stages = getEntrustCatalog(tables).stages(run.entrust_id)
    if (run.sceneObjectVersion !== 4) {
        for (const key of Object.keys(records)) if (key.startsWith(`${run.map_id}:`)) delete records[key]
        if (state.combat?.map_id === run.map_id) delete state.combat
        const alreadyWon =
            run.status === 3 &&
            !!(run.kind === 'material' ? state.materialDungeonRecords : state.entrust.records)?.[run.entrust_id]
                ?.success_time
        run.stage_index = alreadyWon ? stages.at(-1).index + 1 : stages[0].index
        if (!alreadyWon) {
            run.status = 2
            run.star = 0
            delete run.battle_start_time
            delete run.real_start_time
            delete run.end_time
            delete run.rewards
        }
        run.sceneObjectVersion = 4
        changed = true
    }
    for (const row of tables.get(`worldmap_${run.map_id}`)) {
        const key = `${run.map_id}:${row.id}`
        if (records[key]) continue
        const coordinates = String(row.position).split('|').map(Number)
        ensure(
            coordinates.length === 3 && coordinates.every(Number.isFinite),
            'Invalid entrust object position',
            ErrorCode.GameConfig,
        )
        records[key] = {
            obj_id: row.id,
            active: true,
            complete: !!row.initialCompleteState,
            pos: {
                x: Math.round(coordinates[0] * 100),
                y: Math.round(coordinates[1] * 100),
                z: Math.round(coordinates[2] * 100),
            },
            state_data: { step: 0, complete: !!row.initialCompleteState },
        }
        changed = true
    }
    if (state.combat?.map_id === run.map_id)
        for (const field of ['skills', 'bullets', 'elements', 'entities']) state.combat[field] ??= {}
    const battle = combatState(state, run.start_time)
    const stagesById = new Map(stages.map((stage) => [stage.row.id, stage]))
    for (const row of tables.get(`worldmap_${run.map_id}`)) {
        const record = records[`${run.map_id}:${row.id}`]
        const stage = stagesById.get(row.id)
        if (stage) {
            const finished = stage.index < run.stage_index
            const active = stage.index === run.stage_index || (stage.type === 30 && finished)
            if (
                record.active !== active ||
                record.complete !== finished ||
                record.state_data?.step !== (finished ? 1 : 0)
            )
                changed = true
            record.active = active
            record.complete = finished
            record.state_data = { ...record.state_data, step: finished ? 1 : 0, complete: finished }
        }
        const spawner = tables.find('world_spawner', row.spawnerId)
        if (spawner?.objectType !== 50) continue
        // An inactive group with omitted times becomes an expired refresh entry
        // on CBT3 (next_time + 10 > time). Keep its server death/visibility data
        // for this run; a fresh entry rebuilds the run and monsters separately.
        if (record.time !== run.start_time || record.next_time !== 0) changed = true
        record.time = run.start_time
        record.next_time = 0
        // The client initializes every configured enemy-group unit while the
        // scene loads, including inactive later waves. All slots need their
        // level and pack at entry; active controls visibility, not metadata.
        const group = tables.find('world_enemy_group', row.expandId),
            packs = String(group?.enemyList ?? '')
                .split('|')
                .filter(Boolean)
        ensure(packs.length > 0 && packs.length <= 24, 'Entrust enemy group unavailable', ErrorCode.GameConfig)
        const monsters = packs.map((_, slot) => {
            const uid = ((3n << 56n) | (BigInt(slot) << 32n) | BigInt(row.id)).toString()
            const enemy = enemyDefinition(tables, state, uid)
            ensure(enemy, 'Entrust enemy attributes unavailable', ErrorCode.NoEnemyConf)
            const old = battle.entities[uid]
            if (!old) {
                battle.entities[uid] = {
                    uuid: uid,
                    ...enemy,
                    hp: stage && stage.index < run.stage_index ? 0 : enemy.max_hp,
                    sp: 0,
                    alive_state: stage && stage.index < run.stage_index ? 1 : 0,
                    updated_at: run.start_time,
                }
                changed = true
            } else if (old.level !== enemy.level || old.max_hp !== enemy.max_hp) {
                const ratio = old.max_hp > 0 ? old.hp / old.max_hp : 1
                old.level = enemy.level
                old.max_hp = enemy.max_hp
                old.hp = old.hp === 0 ? 0 : Math.max(1, Math.min(enemy.max_hp, Math.round(enemy.max_hp * ratio)))
                changed = true
            }
            return {
                uid,
                obj_type: 3,
                id: enemy.config_id,
                enemy_pack: enemy.pack_id,
                level: enemy.level,
                hp: battle.entities[uid].hp,
                obj_key: { obj_id: row.id, obj_index: slot, group_id: row.expandId },
                move: { pos: record.pos, move_status: 1, area_id: state.world.area_id },
            }
        })
        // VisibleEnemies is independent of the full attribute roster. Keep
        // dead slots' metadata, but never recreate them as visible monsters.
        const world_indexes = visibleEnemySlots(monsters, battle.entities)
        const previousIndexes = record.expand_data?.battle_group?.world_indexes
        if (
            !previousIndexes ||
            previousIndexes.length !== world_indexes.length ||
            previousIndexes.some((slot, index) => slot !== world_indexes[index])
        )
            changed = true
        record.expand_data = {
            ...(record.expand_data ?? {}),
            battle_group: { monsters, world_indexes },
        }
    }
    run.scene_objects = Object.entries(records)
        .filter(([key]) => key.startsWith(`${run.map_id}:`))
        .map(([, value]) => {
            const { claims, ...object } = value
            return object
        })
    if (settleEntrustVictory(tables, state, now)) changed = true
    return changed
}

export function entrustVictoryComplete(catalog, state, id) {
    const { scene } = catalog.get(id)
    if (state.world.map_id !== scene.id || state.combat?.map_id !== scene.id) return false
    return catalog
        .victoryObjects(id)
        .every(({ objectId, count }) =>
            Array.from({ length: count }, (_, slot) =>
                ((3n << 56n) | (BigInt(slot) << 32n) | BigInt(objectId)).toString(),
            ).every((uuid) => state.combat.entities[uuid]?.hp === 0),
        )
}
