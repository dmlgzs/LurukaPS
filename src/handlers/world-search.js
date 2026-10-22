import { ErrorCode } from '../error-codes.js'
import { ensure } from './common.js'
import { worldSearchVisible as visible } from '../world-search-visible.js'
import { findUncompletedWorldObject } from '../world-detectors.js'
import { WorldObjectCatalog } from '../world-objects.js'

const positionValid = (pos) => pos && ['x', 'y', 'z'].every((axis) => Number.isFinite(pos[axis]))
const distanceSquared = (a, b) => ['x', 'y', 'z'].reduce((n, axis) => n + (a[axis] - b[axis]) ** 2, 0)
function specialPet(tables, state, record, row, spawner) {
    const group =
        spawner.objectType === 50
            ? record?.expand_data?.battle_group
            : spawner.objectType === 51
              ? record?.expand_data?.random_battle_group
              : null
    if (!(group?.special_type > 0)) return null
    const slot = group.special_index ?? 0
    if (group.world_indexes && !group.world_indexes.includes(slot)) return null
    const monster = group.monsters?.find((entry, index) => (entry.obj_key?.obj_index ?? index) === slot)
    if (!monster?.uid || state.petCaptureResults?.[monster.uid]) return null
    const runtime = state.combat?.map_id === state.world.map_id ? state.combat.entities?.[monster.uid] : null
    if (
        runtime?.captured ||
        (runtime?.hp ?? monster.hp) === 0 ||
        (runtime?.alive_state ?? monster.alive_state ?? 0) !== 0
    )
        return null
    const pack = tables.find('enemy_pack', monster.enemy_pack),
        enemy = tables.find('enemy', pack?.enemyId ?? monster.id)
    if (!enemy?.petId) return null
    return {
        obj_id: row.id,
        pos: runtime?.pos ?? monster.move?.pos ?? record.pos,
        search_type: 2,
        special_type: group.special_type,
        pet_id: enemy.petId,
        color: group.color ?? 0,
    }
}
export function registerWorldSearch(on, tables) {
    on('FindUnCompletedWorldObj', findUncompletedWorldObject)
    const catalog = new WorldObjectCatalog(tables),
        eggs = new Map()
    const maxRange = Number(tables.get('game').find((row) => row.title === 'SKILL_SEARCHSKILL_MAX_RANGE')?.value)
    ensure(Number.isFinite(maxRange) && maxRange > 0, 'Search range configuration unavailable', ErrorCode.GameConfig)
    on('WorldObjSearch', ({ state }, request) => {
        const type = request.search_type,
            filter = request.attribute_filter ?? 0,
            count = request.search_count ?? 0,
            range = request.search_range ?? 0
        ensure([1, 2, 3].includes(type), 'Unknown world object search type')
        ensure(
            [filter, count, range].every((value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff),
            'Invalid world object search parameters',
        )
        // TODO: verify nonzero attribute_filter semantics against a client caller/capture.
        // CBT3 MapStore.BuildBattleExploreSearchReq never sets it; do not guess a bitmask.
        ensure(filter === 0, 'World search attribute filter is not implemented', ErrorCode.FunctionClosed)
        ensure(positionValid(state.world.pos), 'Search position unavailable', ErrorCode.InvalidTarget)
        // A zero count is used by the client's overload. The local response bound
        // is 64; the 100m range comes from game.json, not a guessed skill radius.
        const limit = Math.min(count || 64, 64),
            radiusSquared = (Math.min(range || maxRange, maxRange) * 100) ** 2,
            map = state.world.map_id,
            results = new Map()
        const add = (value) => {
            if (!positionValid(value.pos)) return
            const distance = distanceSquared(state.world.pos, value.pos)
            if (distance <= radiusSquared)
                results.set(value.obj_id, { value: { ...value, pos: { ...value.pos } }, distance })
        }
        if (type !== 2) {
            if (!eggs.has(map)) {
                let rows
                try {
                    rows = catalog.get('worldmap_' + map)
                } catch (error) {
                    if (error.code !== 'ENOENT') throw error
                    rows = []
                }
                eggs.set(
                    map,
                    rows.filter((row) => catalog.find('world_spawner', row.spawnerId)?.objectType === 31),
                )
            }
            for (const row of eggs.get(map)) {
                const record = state.worldObjects?.[map + ':' + row.id]
                if (visible(row, record, state))
                    add({ obj_id: row.id, pos: record?.pos ?? catalog.object(map, row.id).pos, search_type: 1 })
            }
        }
        if (type !== 1)
            for (const [key, record] of Object.entries(state.worldObjects ?? {})) {
                if (!key.startsWith(map + ':') || !record.expand_data) continue
                const dynamicSpawner = record.expand_data.dynamic_obj?.spawner_id
                let row
                try {
                    row = catalog.find('worldmap_' + map, record.obj_id)
                } catch (error) {
                    if (error.code !== 'ENOENT') throw error
                    continue
                }
                if (!row || !visible(row, record, state)) continue
                const spawner = catalog.find('world_spawner', dynamicSpawner || row.spawnerId)
                const result = spawner && specialPet(tables, state, record, row, spawner)
                if (result) add(result)
            }
        return {
            search_type: type,
            results: [...results.values()]
                .sort((a, b) => a.distance - b.distance || a.value.obj_id - b.value.obj_id)
                .slice(0, limit)
                .map((entry) => entry.value),
        }
    })
}
