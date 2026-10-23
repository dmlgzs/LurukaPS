import fs from 'node:fs'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { WorldObjectCatalog } from './world-objects.js'
import { worldCondition } from './handlers/world-objects.js'
import { trackingConditionResult } from './pet-tracking-conditions.js'

const config = JSON.parse(fs.readFileSync(new URL('../configs/pet-tracking.json', import.meta.url)))
const packs = new Map(config.packs.map(([id, pet, uncatchable, special]) => [id, { pet, uncatchable, special }]))
const pets = new Map(config.pets)
const maps = new Set(config.maps)
const models = new WeakMap()
const uint = (n) => Number.isInteger(n) && n > 0 && n <= 0xffffffff
const position = (p) =>
    p && ['x', 'y', 'z'].every((k) => Number.isInteger(p[k]) && p[k] >= -0x80000000 && p[k] <= 0x7fffffff)
const catchable = (pack) => pack && pets.get(pack.pet) === 1 && pack.uncatchable !== 1 && pack.special !== 1
const uuid = (object, slot) => String((3n << 56n) | (BigInt(slot) << 32n) | BigInt(object))
function condition(value, state, context) {
    return trackingConditionResult(() => worldCondition(value, state), value, context)
}
function visible(row, record, state, map) {
    if (record?.active === false || (record?.active === undefined && row.initStatus === 1)) return false
    if (record?.complete ?? !!row.initialCompleteState) return false
    if (condition(row.appearCond, state, { map_id: map, obj_id: row.id, field: 'appearCond' }) !== true) return false
    if (
        row.disappearCond &&
        condition(row.disappearCond, state, { map_id: map, obj_id: row.id, field: 'disappearCond' }) !== false
    )
        return false
    return true
}
function pool(value) {
    const result = new Set()
    for (const part of String(value ?? '')
        .split('|')
        .filter(Boolean)) {
        const [when, values, ...extra] = part.split('#'),
            entries = String(values ?? '')
                .split(',')
                .map(Number)
        ensure(
            !extra.length &&
                [0, 1, 2].includes(Number(when)) &&
                entries.length % 2 === 0 &&
                entries.every(Number.isInteger),
            'Invalid pet tracking random pool',
            ErrorCode.GameConfig,
        )
        for (let i = 0; i < entries.length; i += 2) {
            ensure(entries[i] > 0 && entries[i + 1] >= 0, 'Invalid pet tracking random weight', ErrorCode.GameConfig)
            if (entries[i + 1] > 0) result.add(entries[i])
        }
    }
    return result
}
export class PetTrackingCatalog {
    constructor(tables, world = new WorldObjectCatalog(tables)) {
        this.world = world
        this.groups = new Map(config.groups.map(([id, appear, slots]) => [id, { appear, slots }]))
        this.random = new Map(
            config.random.map(([id, common, normal, completed]) => [
                id,
                { common, normal: pool(normal), completed: pool(completed) },
            ]),
        )
        this.byPet = new Map()
        for (const map of config.maps) {
            let rows
            try {
                rows = world.get('worldmap_' + map)
            } catch (error) {
                if (error.code !== 'ENOENT') throw error
                continue
            }
            for (const row of rows) {
                // Local integrity boundary inherited from WorldObjectCatalog.object;
                // aliases with another row cityId are not yet supported here.
                if (row.cityId !== map || row.referObject || row.isstory === 1) continue
                const spawner = world.find('world_spawner', row.spawnerId)
                if (![50, 51].includes(spawner?.objectType)) continue
                const groupIds =
                    spawner.objectType === 50
                        ? [row.expandId]
                        : [
                              ...new Set([
                                  ...(this.random.get(row.expandId)?.normal ?? []),
                                  ...(this.random.get(row.expandId)?.completed ?? []),
                              ]),
                          ]
                const species = new Set(
                    groupIds.flatMap((id) =>
                        (this.groups.get(id)?.slots ?? [])
                            .map((id) => packs.get(id))
                            .filter(catchable)
                            .map((p) => p.pet),
                    ),
                )
                for (const pet of species) {
                    if (!this.byPet.has(pet)) this.byPet.set(pet, [])
                    this.byPet.get(pet).push({ map, row, spawner })
                }
            }
        }
    }
    targets(state, pet, now) {
        const result = []
        const candidates = new Map((this.byPet.get(pet) ?? []).map((c) => [c.map + ':' + c.row.id, c]))
        // Actual dynamic/special snapshots can select a different pool or pack.
        // The response still requires a real TDWorldmap object for the consumer.
        for (const [key, record] of Object.entries(state.worldObjects ?? {})) {
            const [map, id] = key.split(':').map(Number)
            if (
                !maps.has(map) ||
                !(record.expand_data?.battle_group?.monsters || record.expand_data?.random_battle_group?.monsters)
            )
                continue
            let row
            try {
                row = this.world.find('worldmap_' + map, id)
            } catch (error) {
                if (error.code !== 'ENOENT') throw error
                continue
            }
            if (!row || row.cityId !== map || row.referObject || row.isstory === 1) continue
            const dynamic = record.expand_data?.dynamic_obj
            const spawner = this.world.find('world_spawner', dynamic?.spawner_id || row.spawnerId)
            if (![50, 51].includes(spawner?.objectType)) continue
            candidates.set(key, {
                map,
                row: dynamic?.expand_id ? { ...row, expandId: dynamic.expand_id } : row,
                spawner,
            })
        }
        for (const candidate of candidates.values()) {
            const { map, row, spawner } = candidate,
                record = state.worldObjects?.[map + ':' + row.id]
            if (!visible(row, record, state, map) || record?.next_time > now) continue
            const group =
                spawner.objectType === 50 ? record?.expand_data?.battle_group : record?.expand_data?.random_battle_group
            let groupId = row.expandId
            if (spawner.objectType === 51) {
                const random = this.random.get(row.expandId)
                // A habitat probability is not an actual spawned selection.
                const completed = random?.common
                    ? condition(random.common, state, {
                          map_id: map,
                          obj_id: row.id,
                          field: 'commonCondition',
                          random_id: row.expandId,
                      })
                    : false
                if (completed === undefined) continue
                const allowed = completed && random.completed.size ? random.completed : random?.normal
                groupId = group?.record_group_id
                if (!allowed?.has(groupId)) continue
            }
            const definition = this.groups.get(groupId)
            if (!definition) continue
            // Nonzero scalar group appearance rules have no proven server predicate.
            // An actual live snapshot is required rather than exposing a potential habitat.
            if (definition.appear && !group?.monsters?.length) continue
            for (let slot = 0; slot < definition.slots.length; slot++) {
                if (group?.world_indexes && !group.world_indexes.includes(slot)) continue
                const monster = group?.monsters?.find((m, i) => (m.obj_key?.obj_index ?? i) === slot)
                // A supplied snapshot is authoritative; never fill omitted slots from static data.
                if (group?.monsters && !monster) continue
                const pack = packs.get(monster?.enemy_pack ?? definition.slots[slot])
                if (!catchable(pack) || pack.pet !== pet) continue
                const id = String(monster?.uid || uuid(row.id, slot))
                // The current catch resolver decodes normal-world type3 IDs.
                // Do not advertise an actual snapshot with an unsupported identity.
                if (id !== uuid(row.id, slot)) continue
                if (state.petCaptureResults?.[id]) continue
                const death = state.petTrackingDeaths?.[map]?.[id]
                const runtime = state.combat?.map_id === map ? state.combat.entities?.[id] : null
                if (
                    runtime?.captured ||
                    (runtime?.hp ?? monster?.hp) === 0 ||
                    (runtime?.alive_state ?? monster?.alive_state ?? 0) !== 0
                )
                    continue
                // TODO: a real refresh producer must supply an explicit generation.
                // Neither next_time, generic record.time, nor rebuilt template HP
                // proves that this UUID has respawned. Death evidence wins today.
                if (death) continue
                const moving =
                    String(row.expandParams ?? '').includes('specialRandomBornPos') ||
                    String(spawner.expandParams ?? '').includes('specialRandomBornPos')
                const pos =
                    runtime?.pos ??
                    monster?.move?.pos ??
                    record?.pos ??
                    (!moving ? this.world.object(map, row.id).pos : null)
                if (!position(pos)) continue
                result.push({ map_id: map, obj_id: row.id, pos: { ...pos }, slot })
            }
        }
        return result
    }
}
export function trackPet(c, request) {
    ensure(uint(request.pet_id) && uint(request.ts), 'Invalid pet tracking species or timestamp', ErrorCode.ParamError)
    ensure(pets.has(request.pet_id), 'Pet tracking species configuration does not exist', ErrorCode.PetConfNotExist)
    let targets = []
    if (pets.get(request.pet_id) === 1) {
        if (!models.has(c.tables)) models.set(c.tables, new PetTrackingCatalog(c.tables))
        targets = models.get(c.tables).targets(c.state, request.pet_id, c.now)
    }
    // Local selection policy: nearest eligible current-map target, then stable
    // map/object/slot order. The wire carries no client origin or search mode.
    const origin = c.state.world.pos
    const distance = (t) =>
        t.map_id === c.state.world.map_id && position(origin)
            ? ['x', 'y', 'z'].reduce((v, k) => v + (t.pos[k] - origin[k]) ** 2, 0)
            : Infinity
    targets.sort(
        (a, b) =>
            Number(b.map_id === c.state.world.map_id) - Number(a.map_id === c.state.world.map_id) ||
            distance(a) - distance(b) ||
            a.map_id - b.map_id ||
            a.obj_id - b.obj_id ||
            a.slot - b.slot,
    )
    const found = targets[0]
    c.push(
        'CSProtoTrackPetRsp',
        found ? { map_id: found.map_id, obj_id: found.obj_id, pos: found.pos, ts: request.ts } : { ts: request.ts },
    )
    return {}
}
export function recordTrackingDeath(tables, state, value, now) {
    if (
        !maps.has(state.world.map_id) ||
        Number(BigInt(value.uuid) >> 56n) !== 3 ||
        !catchable(packs.get(value.pack_id)) ||
        state.petCaptureResults?.[value.uuid] ||
        value.captured
    )
        return false
    const map = state.world.map_id,
        previous = state.petTrackingDeaths?.[map]?.[value.uuid]
    if (previous) return false
    // Deferred combat drafts borrow unmodified player branches: clone both levels
    // only on actual death, keeping parent state intact if packet encoding fails.
    state.petTrackingDeaths = {
        ...state.petTrackingDeaths,
        [map]: {
            ...state.petTrackingDeaths?.[map],
            [value.uuid]: { time: now, object_id: value.object_id, slot: value.slot, pack_id: value.pack_id },
        },
    }
    return true
}
