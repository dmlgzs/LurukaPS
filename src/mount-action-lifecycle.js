import { createHash } from 'node:crypto'
import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'

const mapId = (value) => Number.isInteger(value) && value > 0 && value <= 0xffffffff
const guid = (value) =>
    typeof value === 'string' && value.length <= 20 && /^[1-9]\d*$/.test(value) && BigInt(value) < 1n << 64n
function sessionKey(context) {
    const token = context.connectionKey ?? context.combatSessionId
    return typeof token === 'string' && token.length ? createHash('sha256').update(token).digest('hex') : null
}
function valid(proof) {
    return (
        proof &&
        proof.version === 1 &&
        typeof proof.session === 'string' &&
        /^[a-f0-9]{64}$/.test(proof.session) &&
        Number.isSafeInteger(proof.epoch) &&
        proof.epoch > 0 &&
        mapId(proof.map_id) &&
        guid(proof.mount) &&
        (proof.phase === 'riding' || (proof.phase === 'exited' && mapId(proof.exit_map_id)))
    )
}
// LOCAL reconciliation only: no request nonce/mount identity exists on9120.
// A successful current-session ride and real exit authorize ignoring a queued
// known action, never executing it or reconstructing mounted state. No TTL.
export function beginMountActionLifecycle(c, mount) {
    const world = c.state.world,
        key = sessionKey(c),
        old = world.mountActionLifecycle
    ensure(key && mapId(world.map_id), 'Mount action session is unavailable', ErrorCode.GameConfig)
    const epoch = valid(old) && old.session === key ? old.epoch + 1 : 1
    ensure(Number.isSafeInteger(epoch), 'Mount action epoch overflow', ErrorCode.GameConfig)
    world.mountActionLifecycle = {
        version: 1,
        session: key,
        epoch,
        phase: 'riding',
        map_id: world.map_id,
        mount: String(mount.guid),
    }
}
export function endMountActionLifecycle(state, fromMapId = state.world.map_id, c) {
    const world = state.world,
        proof = world.mountActionLifecycle,
        key = c ? sessionKey(c) : null
    if (!valid(proof) || (c && proof.session !== key)) {
        delete world.mountActionLifecycle
        return
    }
    if (
        proof.phase === 'riding' &&
        world.status === 1 &&
        String(world.mount) === proof.mount &&
        proof.map_id === fromMapId
    ) {
        world.mountActionLifecycle = { ...proof, phase: 'exited', exit_map_id: world.map_id }
        return
    }
    // Repeated cleanup of the same destination is idempotent. Another real
    // scene transition without a new ride invalidates the prior exit proof.
    if (proof.phase === 'exited' && proof.exit_map_id === world.map_id && fromMapId === world.map_id) return
    delete world.mountActionLifecycle
}
export function isExitedMountAction(c) {
    const world = c.state.world,
        proof = world.mountActionLifecycle
    return (
        valid(proof) &&
        proof.phase === 'exited' &&
        proof.session === sessionKey(c) &&
        proof.exit_map_id === world.map_id &&
        world.status !== 1 &&
        String(world.mount ?? '0') === '0'
    )
}
