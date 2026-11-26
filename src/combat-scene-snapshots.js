import { combatEnemyRoot } from './combat-enemy-lifecycle.js'

// Per-output-stream transport metadata only. Weak keys never become player
// state, persisted receipts or a global suppression cache.
const streams = new WeakMap()
function stream(c, producer = false) {
    const key = producer ? c.push?.combatSnapshotStream : (c.combatSnapshotStream ?? c.pushBefore?.combatSnapshotStream)
    if (!key || (typeof key !== 'object' && typeof key !== 'function')) return null
    let value = streams.get(key)
    if (!value) streams.set(key, (value = { planned: null, fresh: new Map() }))
    return value
}
function identity(c, id) {
    const battle = c.state.combat,
        activation = battle?.enemyActivations?.[combatEnemyRoot(id)],
        slot = Number((BigInt(id) >> 32n) & 0xffffffn),
        pack = activation?.packIds[slot]
    if (!battle?.runtimeEpoch || !activation?.active || !activation.generation || !pack) return null
    return `${battle.map_id}:${battle.runtimeEpoch}:${activation.generation}:${pack}`
}
export function beginCombatSnapshotPublication(c) {
    const output = stream(c)
    if (output) output.fresh = new Map()
}
export function plannedCombatInitialization(c, info) {
    const planned = stream(c)?.planned?.get(info.uuid)
    if (
        !planned ||
        planned.hp !== info.hp ||
        planned.alive_state !== 0 ||
        (planned.final_blow_guid !== undefined && String(planned.final_blow_guid) !== '0')
    )
        return info
    // Retain explicit producer semantics, including reason. Equal HP does not
    // prove that reason0/1 or a missing/nonzero SP value are interchangeable.
    const result = { ...info }
    for (const key of ['sp', 'reason'])
        if (
            Number.isSafeInteger(planned[key]) &&
            planned[key] >= 0 &&
            planned[key] <= 0xffffffff &&
            (key !== 'sp' || planned.sp === info.sp)
        )
            result[key] = planned[key]
    return result
}
export function recordCombatInitialization(c, infos) {
    const output = stream(c)
    if (!output) return
    for (const info of infos) {
        const scope = identity(c, info.uuid)
        if (scope && info.hp > 0 && info.alive_state === 0 && info.final_blow_guid === '0')
            output.fresh.set(info.uuid, { scope, info: { ...info } })
    }
}
export function publishCombatSceneSnapshot(c, infos, publishObjects) {
    const output = stream(c, true),
        previous = output?.planned
    if (output) output.planned = new Map(infos.map((info) => [info.uuid, info]))
    try {
        publishObjects()
    } finally {
        if (output) output.planned = previous
    }
    const remaining = infos.filter((info) => {
        const published = output?.fresh.get(info.uuid)
        // Consume the narrow pairing once. Later ordinary reprojections keep
        // their packet even when they happen in this same transaction/stream.
        output?.fresh.delete(info.uuid)
        return !(
            published &&
            published.scope === identity(c, info.uuid) &&
            info.hp > 0 &&
            info.alive_state === 0 &&
            Object.entries(info).every(([key, value]) => published.info[key] === value)
        )
    })
    if (remaining.length) c.push('CSProtoObjBattleInfoSync', { infos: remaining })
}
