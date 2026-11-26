import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { actor } from './handlers/combat.js'
import { enemyDefinition } from './enemy-state.js'
import { u64, combatState, boundedSet } from './combat-state.js'
import { createHash } from 'node:crypto'

// BulletService 06000700-06000702: only a remotely controlled bullet takes
// this handshake. The server routes authority to its recorded CreateBullet
// source, then forwards one matching owner confirmation to the reflector.
// It does not invent damage, costs, a reflected bullet or a skill execution.
function requestFields(request) {
    const target_id = u64(request.target_id),
        cast_id = u64(request.cast_id),
        op_time = u64(request.op_time)
    ensure(target_id !== '0' && cast_id !== '0', 'Missing rebound bullet or caster')
    ensure(
        Number.isSafeInteger(request.skill_id) && request.skill_id > 0 && request.skill_id <= 0xffffffff,
        'Invalid rebound skill',
    )
    return { target_id, cast_id, skill_id: request.skill_id, op_time }
}

function sourceFor(store, c, target) {
    // Include deferred combat drafts: persisted JSON may predate CreateBullet.
    // The numeric uint64 target is passed as a bound JSON-path parameter.
    const ids = new Set(
        store.db
            .prepare(
                "SELECT account_id FROM players WHERE json_extract(state,'$.combat.map_id')=? AND json_type(state,?)='object'",
            )
            .all(c.state.world.map_id, `$.combat.bullets."${target}"`)
            .map((row) => row.account_id),
    )
    for (const id of store.pending.keys()) ids.add(id)
    ids.add(c.id)
    const matches = []
    for (const id of ids) {
        const state = id === c.id ? c.state : store.load(id).state
        const bullet = state.combat?.bullets?.[target]
        if (state.world.map_id !== c.state.world.map_id || state.combat?.map_id !== state.world.map_id || !bullet)
            continue
        ensure(
            Number.isSafeInteger(bullet.updated_at) && bullet.updated_at >= 0 && bullet.updated_at <= c.now,
            'Invalid recorded bullet timestamp',
            ErrorCode.GameConfig,
        )
        if (c.now - bullet.updated_at > 120) continue
        ensure(
            u64(bullet.info?.bullet_id) === target && u64(bullet.unit_id) !== '0',
            'Invalid recorded bullet source',
            ErrorCode.GameConfig,
        )
        matches.push({ id, state, bullet })
    }
    ensure(
        matches.length === 1,
        matches.length ? 'Bullet source is ambiguous' : 'Unknown current rebound bullet',
        ErrorCode.InvalidTarget,
    )
    return matches[0]
}

function verifyCaster(c, id) {
    const kind = Number(BigInt(id) >> 56n)
    ensure([1, 2, 3, 4, 5, 7, 9, 30, 31].includes(kind), 'Invalid rebound caster', ErrorCode.InvalidTarget)
    actor(c, id)
    if ([3, 4, 7].includes(kind))
        ensure(enemyDefinition(c.tables, c.state, id), 'Unknown rebound caster', ErrorCode.InvalidTarget)
}

export function registerBulletRebounds(on, store, { isOnline = () => false, connectionKey = () => null } = {}) {
    const connection = (id) => {
        const key = connectionKey(id)
        ensure(
            typeof key === 'string' && key.length > 0,
            'Rebound connection is unavailable',
            ErrorCode.PlayerNotOnline,
        )
        return createHash('sha256').update(key).digest('hex')
    }
    on('CSReboundBulletReq', (c, request) => {
        const wire = requestFields(request)
        verifyCaster(c, wire.cast_id)
        const source = sourceFor(store, c, wire.target_id)
        ensure(isOnline(source.id), 'Rebound bullet owner is offline', ErrorCode.PlayerNotOnline)
        ensure(
            typeof c.editPlayer === 'function' && typeof c.pushTo === 'function',
            'Rebound routing context unavailable',
            ErrorCode.GameConfig,
        )
        const owner = c.editPlayer(source.id),
            battle = combatState(owner, c.now)
        const ownerConnection = connection(source.id),
            requesterConnection = connection(c.id)
        battle.reboundRequests ??= {}
        const previous = battle.reboundRequests[wire.target_id]
        if (previous && c.now - previous.started_at <= 120) {
            // BulletService's owner-side set permits a target only once. A
            // duplicate must never recast an already confirmed rebound.
            c.pushTo(c.id, 'SCReboundBulletNtfRsp', { ...wire, result: 0 })
            return
        }
        ensure(source.bullet.action?.action_type !== 3, 'Rebound bullet was already removed', ErrorCode.InvalidTarget)
        boundedSet(
            battle.reboundRequests,
            wire.target_id,
            {
                ...wire,
                requester: c.id,
                owner: source.id,
                map_id: owner.world.map_id,
                started_at: c.now,
                status: 'pending',
                owner_connection: ownerConnection,
                requester_connection: requesterConnection,
            },
            2048,
        )
        c.pushTo(source.id, 'SCReboundBulletRsp', wire)
    })
    on('CSReboundBulletNtfReq', (c, request) => {
        const wire = requestFields(request)
        ensure(request.result === 0 || request.result === 1, 'Invalid rebound result')
        const battle = combatState(c.state, c.now),
            pending = battle.reboundRequests?.[wire.target_id]
        ensure(
            pending && pending.owner === c.id && pending.map_id === c.state.world.map_id,
            'Rebound confirmation has no owner request',
            ErrorCode.InvalidTarget,
        )
        ensure(
            pending.cast_id === wire.cast_id && pending.skill_id === wire.skill_id,
            'Rebound confirmation does not match request',
            ErrorCode.InvalidTarget,
        )
        ensure(c.now - pending.started_at <= 120, 'Rebound request expired', ErrorCode.InvalidTarget)
        ensure(
            pending.owner_connection === connection(c.id),
            'Rebound owner connection changed',
            ErrorCode.InvalidTarget,
        )
        if (pending.status !== 'pending') {
            ensure(
                pending.status !== 'confirmed' || pending.result === request.result,
                'Conflicting rebound confirmation',
                ErrorCode.InvalidTarget,
            )
            return // Durable once-only result, including application-level retries.
        }
        ensure(
            typeof c.editPlayer === 'function' && typeof c.pushTo === 'function',
            'Rebound routing context unavailable',
            ErrorCode.GameConfig,
        )
        const requester = c.editPlayer(pending.requester)
        if (
            requester.world.map_id !== pending.map_id ||
            !isOnline(pending.requester) ||
            pending.requester_connection !== connection(pending.requester)
        ) {
            pending.status =
                requester.world.map_id !== pending.map_id
                    ? 'cancelled-after-scene-change'
                    : !isOnline(pending.requester)
                      ? 'cancelled-requester-offline'
                      : 'cancelled-requester-connection-changed'
            pending.finished_at = c.now
            return
        }
        verifyCaster({ ...c, state: requester, id: pending.requester }, pending.cast_id)
        pending.status = 'confirmed'
        pending.result = request.result
        pending.finished_at = c.now
        // OnReboundBulletRsp IL004a-0051 takes a fresh owner clock reading;
        // this is not the request op_time. Preserve it for the final relay.
        pending.confirmation_op_time = wire.op_time
        if (request.result === 1) {
            const bullet = battle.bullets[wire.target_id]
            ensure(bullet, 'Confirmed rebound bullet source expired', ErrorCode.InvalidTarget)
            bullet.rebounded = true
            bullet.updated_at = c.now
        }
        c.pushTo(pending.requester, 'SCReboundBulletNtfRsp', { ...wire, result: request.result })
    })
}
