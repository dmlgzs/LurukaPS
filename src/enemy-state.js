import { WorldObjectCatalog } from './world-objects.js'
import { selectedWorldDifficulty } from './world-difficulty-catalogue.js'
import { TaskGraphs, asList, nodeConditions } from './tasks.js'
import { pairs } from './battle.js'
import { taskEnemyGroups } from './task-enemy-groups.js'
import { arenaProperty } from './npc-kibo-properties.js'
import { taskEnemyPacks } from './task-enemy-slots.js'
import { abyssTables } from './abyss-catalog.js'
import { abyssEnemyHpScale } from './abyss-battle-config.js'
import { worldCondition } from './handlers/world-objects.js'
import { trackingConditionResult } from './pet-tracking-conditions.js'
const catalogs = new WeakMap()
export function enemyDefinition(tables, state, uuid) {
    if (state.abyssRun?.map_id === state.world.map_id) tables = abyssTables(tables)
    const arena = state.combat?.npcDuel
    const actor = arena?.map_id === state.world.map_id ? arena.actors[String(uuid)] : null
    if (actor)
        return {
            config_id: actor.config_id,
            level: actor.level,
            max_hp: actor.base_properties
                ? Math.max(0, arenaProperty({ tables, state }, String(uuid), 5))
                : actor.max_hp,
            npc_duel: true,
        }
    const id = BigInt(uuid),
        kind = Number(id >> 56n),
        slot = Number((id >> 32n) & 0xffffffn),
        object = Number(id & 0xffffffffn)
    if (![3, 4, 7].includes(kind)) return null
    let cached = catalogs.get(tables)
    if (!cached) {
        cached = { world: new WorldObjectCatalog(tables, tables.abyss_directory), graphs: new TaskGraphs(tables) }
        catalogs.set(tables, cached)
    }
    let packId, worldRow, taskConfig, groupSize, taskGroup, livePack
    if (kind === 7) {
        for (const [key, entry] of Object.entries(state.playableEnemies ?? {})) {
            if (!key.startsWith(state.world.map_id + ':')) continue
            packId = entry.entities.find((e) => e.uuid === uuid)?.config_id
            if (packId) {
                groupSize = entry.entities.filter((e) => e.container === object).length
                break
            }
        }
    } else {
        let groupId
        // Task-spawned enemy containers use the configured createNpcId.
        for (const task of state.tasks ?? [])
            for (const node of task.nodes) {
                for (const q of nodeConditions(cached.graphs.get(task.task_id).nodes.get(node.node_id))) {
                    const base = q.__type_TaskConditionBaseData ?? {}
                    for (const data of asList(
                        base.__type_TaskCondEnemiesGroupData?.enemiesDatas ??
                            base.__type_TaskCondFractalPetCatchData?.enemyData,
                    ))
                        if (data?.createNpcId === object && data.sceneId === state.world.map_id) {
                            groupId = data.__type_TaskEnemiesOverrideData?.enemiesGroupId
                            taskGroup = data
                            taskConfig = cached.graphs.get(task.task_id).config
                        }
                }
            }
        if (!groupId && kind === 4) {
            const configured = taskEnemyGroups(tables, state).find((group) => group.objectId === object)
            if (configured) {
                groupId = configured.groupId
                taskGroup = configured.data
                taskConfig = configured.taskConfig
            }
        }
        if (!groupId && kind === 3) {
            let row
            try {
                row = cached.world.find('worldmap_' + state.world.map_id, object)
            } catch (error) {
                if (error.code !== 'ENOENT') throw error
            }
            if (row) {
                worldRow = row
                const record = state.worldObjects?.[state.world.map_id + ':' + object]
                const dynamic = record?.expand_data?.dynamic_obj
                const spawner = cached.world.find('world_spawner', dynamic?.spawner_id || row.spawnerId)
                if (spawner?.objectType === 50) groupId = dynamic?.expand_id || row.expandId
                // Random habitats are potential pools. Only a selected current
                // server snapshot defines which group and pack can be fought/caught.
                if (spawner?.objectType === 51) {
                    const selected = record?.expand_data?.random_battle_group
                    const random = tables.find('world_enemy_group_random', dynamic?.expand_id || row.expandId)
                    const completed = random?.commonCondition
                        ? trackingConditionResult(
                              () => worldCondition(random.commonCondition, state),
                              random.commonCondition,
                              {
                                  map_id: state.world.map_id,
                                  obj_id: object,
                                  field: 'commonCondition',
                                  random_id: random.id,
                              },
                          )
                        : false
                    if (completed === undefined) return null
                    const pool =
                        completed && random.conditionCompleteEnemyGroup
                            ? random.conditionCompleteEnemyGroup
                            : random?.enemyGroupRandom
                    const allowed = new Set(
                        String(pool ?? '')
                            .split('|')
                            .flatMap((part) => {
                                const entries = (part.split('#')[1] ?? '').split(',').map(Number)
                                return entries.filter((id, index) => index % 2 === 0 && entries[index + 1] > 0)
                            }),
                    )
                    const monster = selected?.monsters?.find((m, index) => (m.obj_key?.obj_index ?? index) === slot)
                    if (
                        allowed.has(selected?.record_group_id) &&
                        monster &&
                        (!selected.world_indexes || selected.world_indexes.includes(slot))
                    )
                        groupId = selected.record_group_id
                }
                const live =
                    spawner?.objectType === 50
                        ? record?.expand_data?.battle_group
                        : spawner?.objectType === 51
                          ? record?.expand_data?.random_battle_group
                          : null
                const monster = live?.monsters?.find((m, index) => (m.obj_key?.obj_index ?? index) === slot)
                if (
                    groupId &&
                    monster?.enemy_pack &&
                    (!live.world_indexes || live.world_indexes.includes(slot)) &&
                    (!monster.uid || String(monster.uid) === String(uuid))
                )
                    livePack = monster.enemy_pack
            }
        }
        if (groupId) {
            const group = tables.find('world_enemy_group', groupId)
            const packs = taskGroup
                ? taskEnemyPacks(tables, taskGroup)
                : String(group?.enemyList ?? '')
                      .split('|')
                      .filter(Boolean)
                      .map(Number)
            groupSize = packs.length
            packId = livePack || packs[slot]
        }
    }
    if (!packId) return null
    const pack = tables.find('enemy_pack', packId),
        enemy =
            pack?.specialCreateType === 1
                ? tables.find('hero', pack.enemyId)
                : tables.find('enemy', pack?.enemyId || packId)
    if (!enemy) return null
    const property = tables.find('unit_property', pack?.propertyId || enemy.propertyId)
    // EntityLevelUtility0600e009 uses the first worldAreaId override.
    let parameter = pack?.levelParameter ?? 0
    if (pack?.levelPolicy === 1 && worldRow) {
        const area = Number(String(worldRow.worldAreaIds).split('|')[0])
        parameter = pairs(pack.levelAreaParameter).get(area) ?? parameter
    }
    if (pack?.levelPolicy === 4) parameter = taskConfig?.levelParameter || parameter
    const dungeonId =
        state.entrust?.run?.map_id === state.world.map_id
            ? state.entrust.run.dungeon_id
            : state.storyCampaign?.map_id === state.world.map_id
              ? state.storyCampaign.dungeon_id
              : state.cultTrial?.map_id === state.world.map_id
                ? state.cultTrial.dungeon_id
                : state.abyssRun?.map_id === state.world.map_id
                  ? state.abyssRun.dungeon_id
                  : null
    const dungeon = dungeonId ? tables.find('dungeon', dungeonId) : null
    const configured =
        pack?.levelPolicy === 3 && dungeon
            ? tables
                  .get('world_difficulty_obj_level')
                  .find((row) => row.groupid === parameter && row.difficultLv === dungeon.diffType && row.mapid === 0)
                  ?.monsterLevel
            : [1, 4].includes(pack?.levelPolicy)
              ? tables
                    .get('world_difficulty_obj_level')
                    .find(
                        (r) =>
                            r.groupid === parameter &&
                            r.difficultLv === selectedWorldDifficulty(tables, state) &&
                            r.mapid === state.world.map_id,
                    )?.monsterLevel
              : pack?.levelPolicy === 2
                ? parameter
                : undefined
    const defaultLevel = Number(tables.get('game').find((r) => r.title === 'DEFAULT_MONSTER_LEVEL')?.value ?? 1)
    const level = Math.max(
            1,
            pack?.levelPolicy === 3 && dungeon
                ? (configured ?? state.combat?.entities?.[uuid]?.level ?? defaultLevel)
                : (state.combat?.entities?.[uuid]?.level ?? configured ?? defaultLevel),
        ),
        template = (3000 + (pack?.templateID || enemy.enemyType)) * 1000 + level
    const base = tables.find('template_value', property?.baseAttributeId),
        growth = tables.find('template_value', template)
    if (!base || !growth) return null
    let maxHp = Math.floor(
        Math.fround(Math.fround(pairs(base.baseAttribute).get(5) * pairs(growth.baseAttribute).get(5)) / 10000),
    )
    if (state.abyssRun?.map_id === state.world.map_id)
        maxHp = Math.floor((maxHp * abyssEnemyHpScale(tables, state.abyssRun.dungeon_id, object)) / 10000)
    if (!Number.isSafeInteger(maxHp) || maxHp <= 0 || maxHp > 0xffffffff) return null
    return {
        config_id: enemy.id,
        pack_id: packId,
        level,
        max_hp: maxHp,
        object_id: object,
        slot,
        group_size: groupSize,
    }
}
