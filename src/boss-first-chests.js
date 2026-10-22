import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { WorldObjectCatalog } from './world-objects.js'
import { completedEnemyGroup } from './enemy-group-completion.js'
import { grantRewards } from './rewards.js'
import { rewardSource } from './reward-source.js'

const models = new WeakMap()
function model(tables) {
    if (models.has(tables)) return models.get(tables)
    const world = new WorldObjectCatalog(tables),
        byId = new Map(),
        byObject = new Map()
    for (const row of tables.get('boss_first_chest_drop')) {
        const pair = String(row.WorldFilter).split('|').map(Number)
        ensure(
            Number.isSafeInteger(row.id) &&
                row.id > 0 &&
                pair.length === 2 &&
                pair.every((n) => Number.isSafeInteger(n) && n > 0) &&
                Number.isSafeInteger(row.drop) &&
                row.drop > 0 &&
                Number.isSafeInteger(row.spawnerid) &&
                row.spawnerid > 0,
            'Malformed world boss first chest configuration',
            ErrorCode.GameConfig,
        )
        const [mapId, objectId] = pair,
            key = mapId + ':' + objectId
        ensure(!byId.has(row.id) && !byObject.has(key), 'Duplicate world boss chest mapping', ErrorCode.GameConfig)
        const rule = { ...row, mapId, objectId, key }
        byId.set(row.id, rule)
        byObject.set(key, rule)
    }
    const data = { world, byId, byObject }
    models.set(tables, data)
    return data
}
function ledger(state) {
    const entries = state.bossFirstChests ?? {}
    ensure(
        typeof entries === 'object' && !Array.isArray(entries),
        'Invalid saved first chest ledger',
        ErrorCode.GameConfig,
    )
    return entries
}
function checkedEntry(rule, entry) {
    ensure(
        entry &&
            entry.chest_id === rule.id &&
            entry.map_id === rule.mapId &&
            entry.object_id === rule.objectId &&
            typeof entry.received === 'boolean' &&
            Number.isSafeInteger(entry.defeated_at) &&
            entry.defeated_at >= 0 &&
            entry.group_root === ((3n << 56n) | BigInt(rule.objectId)).toString(),
        'Invalid saved first chest receipt',
        ErrorCode.GameConfig,
    )
    return entry
}
export function bossFirstChestInfo(tables, state) {
    return {
        chest_infos: Object.entries(ledger(state))
            .map(([id, entry]) => {
                const rule = model(tables).byId.get(Number(id))
                ensure(rule, 'Saved boss chest configuration is unavailable', ErrorCode.WorldBossChestConfInvalid)
                return { chest_id: rule.id, state: checkedEntry(rule, entry).received }
            })
            .sort((a, b) => a.chest_id - b.chest_id),
    }
}
export function recordBossFirstClear(c, uuid, { recovered = false } = {}) {
    const number = BigInt(uuid)
    // Task, playable and arena clones must not unlock a static-world reward.
    if (number >> 56n !== 3n) return false
    const data = model(c.tables),
        objectId = Number(number & 0xffffffffn)
    const rule = data.byObject.get(c.state.world.map_id + ':' + objectId)
    if (!rule) return false
    const entries = ledger(c.state)
    if (entries[rule.id]) {
        checkedEntry(rule, entries[rule.id])
        return false
    }
    const object = data.world.object(rule.mapId, rule.objectId)
    ensure(
        object.spawner.objectType === 50,
        'First chest boss is not an enemy group',
        ErrorCode.WorldBossChestConfInvalid,
    )
    const group = completedEnemyGroup(c.tables, c.state, uuid)
    if (!group) return false
    const expected = String(c.tables.find('world_enemy_group', object.row.expandId)?.enemyList ?? '')
        .split('|')
        .filter(Boolean)
        .map(Number)
    ensure(
        expected.length && expected.every(Number.isSafeInteger),
        'Invalid first chest enemy group',
        ErrorCode.GameConfig,
    )
    if (
        group.members.length !== expected.length ||
        group.members.some((id, index) => c.state.combat.entities[id]?.pack_id !== expected[index])
    )
        return false
    c.state.bossFirstChests = {
        ...entries,
        [rule.id]: {
            chest_id: rule.id,
            map_id: rule.mapId,
            object_id: rule.objectId,
            group_root: group.root,
            defeated_at: Math.floor(c.now),
            received: false,
            ...(recovered ? { recovered: true } : {}),
        },
    }
    c.push('CSProtoWorldBossChestInfoSync', { chest_infos: [{ chest_id: rule.id, state: false }] })
    return true
}
export function recoverBossFirstClears(tables, state, now) {
    if (state.combat?.map_id !== state.world.map_id) return
    const roots = new Set()
    for (const [uuid, entity] of Object.entries(state.combat.entities ?? {}))
        if (
            entity &&
            entity.hp === 0 &&
            entity.alive_state === 1 &&
            !entity.captured &&
            /^\d+$/.test(uuid) &&
            BigInt(uuid) >> 56n === 3n
        )
            roots.add((BigInt(uuid) & ~(0xffffffn << 32n)).toString())
    for (const uuid of roots) recordBossFirstClear({ tables, state, now, push: () => {} }, uuid, { recovered: true })
}
export function claimBossFirstChest(c, request) {
    const data = model(c.tables),
        rule = data.byId.get(request.u32)
    ensure(rule, 'World boss chest configuration is unavailable', ErrorCode.WorldBossChestConfInvalid)
    const entry = ledger(c.state)[rule.id]
    ensure(entry, 'World boss first chest has not been unlocked', ErrorCode.WorldBossChestInvalid)
    checkedEntry(rule, entry)
    const src = rewardSource(c.tables, 'worldBossFirstChest')
    if (entry.received) {
        c.push('CSProtoWorldBossChestInfoSync', { chest_infos: [{ chest_id: rule.id, state: true }] })
        return { rewards: [], src }
    }
    ensure(
        c.state.world.map_id === rule.mapId,
        'World boss chest is not in the current map',
        ErrorCode.WorldBossChestInvalid,
    )
    const object = data.world.object(rule.mapId, rule.objectId)
    ensure(
        data.world.find('world_spawner', rule.spawnerid),
        'First chest prefab configuration is missing',
        ErrorCode.WorldBossChestConfInvalid,
    )
    const range = Number(c.tables.get('game').find((r) => r.title === 'WORLD_INTERACT_MAX_DISTANCE')?.value) * 100
    ensure(
        Number.isFinite(range) &&
            range > 0 &&
            ['x', 'y', 'z'].every((axis) => Number.isFinite(c.state.world.pos?.[axis])),
        'Invalid first chest interaction range or saved position',
        ErrorCode.GameConfig,
    )
    const distance = ['x', 'y', 'z'].reduce((n, axis) => n + (object.pos[axis] - c.state.world.pos[axis]) ** 2, 0)
    ensure(distance <= range * range, 'First chest interaction is too far away', ErrorCode.InteractDistanceTooFar)
    const configured = data.world.drops(rule.drop, c.randomInt)
    ensure(configured.length, 'First chest drop has no rewards', ErrorCode.WorldBossChestConfInvalid)
    const rewards = grantRewards(c.tables, c.state, configured)
    c.state.bossFirstChests = {
        ...ledger(c.state),
        [rule.id]: { ...entry, received: true, claimed_at: Math.floor(c.now) },
    }
    // Inventory/ornament deltas are pre-ACK in Game. The status can destroy the
    // local chest, so send it after the reward callback has read its position.
    c.push('CSProtoWorldBossChestInfoSync', { chest_infos: [{ chest_id: rule.id, state: true }] })
    return { rewards, src }
}
