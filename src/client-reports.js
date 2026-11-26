import { createHash } from 'node:crypto'
import { ErrorCode } from './error-codes.js'
import { ensure, pet } from './handlers/common.js'
import { pushSceneMode } from './scene-mode.js'
import { publishCombatEnemyActivations, replayCombatEnemyTerminals } from './handlers/world-combat.js'

const uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff

export function recordPetCaress(tables, state, guid) {
    const homeId = Number(tables.get('game').find((row) => row.title === 'HOME_ID')?.value)
    ensure(Number.isSafeInteger(homeId) && homeId > 0, 'Missing home map configuration', ErrorCode.GameConfig)
    ensure(state.world.map_id === homeId, 'Pet caress requires the home scene', ErrorCode.PlayerNotInHome)
    const target = pet(state, guid)
    const old = state.petCaressProgress ?? { guid: '0', consecutive: 0, maximum: 0 }
    ensure(
        typeof old.guid === 'string' && uint(old.consecutive) && uint(old.maximum),
        'Invalid pet caress history',
        ErrorCode.GameConfig,
    )
    const consecutive = old.guid === target.guid ? Math.min(old.consecutive + 1, 0xffffffff) : 1
    state.petCaressProgress = { guid: target.guid, consecutive, maximum: Math.max(old.maximum, consecutive) }
    // 6555 is sent before the favor-cap check; 6534 is the separate favor grant.
    // Counting an interaction must never duplicate its experience or daily budget.
    return {}
}

export function recordAnniversaryReport(state, request, now, eventIds, requestKey) {
    const events = request.events ?? []
    ensure(Array.isArray(events) && events.length <= 64, 'Too many anniversary events')
    const normalized = events.map((event) => {
        ensure(eventIds.has(event.event_id), 'Unknown anniversary client event')
        const entity = String(event.entity_id ?? '0'),
            value = String(event.value ?? '0')
        ensure(/^\d+$/.test(entity) && BigInt(entity) < 1n << 64n, 'Invalid anniversary entity')
        ensure(
            /^-?\d+$/.test(value) && BigInt(value) >= -(1n << 63n) && BigInt(value) < 1n << 63n,
            'Invalid anniversary value',
        )
        const text = event.str_value ?? ''
        ensure(typeof text === 'string' && Buffer.byteLength(text) <= 8192, 'Anniversary event text is too large')
        return {
            event_id: event.event_id,
            entity_id: BigInt(entity).toString(),
            value: BigInt(value).toString(),
            str_value: text,
        }
    })
    if (!normalized.length) return {}
    const old = state.anniversaryClientReports ?? { received: 0, recent: [], receipts: [] }
    ensure(
        uint(old.received) && Array.isArray(old.recent) && Array.isArray(old.receipts),
        'Invalid anniversary report journal',
        ErrorCode.GameConfig,
    )
    const receipt = requestKey ? createHash('sha256').update(requestKey).digest('hex') : null
    if (receipt && old.receipts.includes(receipt)) return {}
    // The public client proves the event payload, not the official server's
    // annual aggregation rules. Retain a bounded journal without inventing
    // rewards, achievements or official statistics from client-supplied values.
    state.anniversaryClientReports = {
        received: Math.min(old.received + normalized.length, 0xffffffff),
        recent: [...old.recent, ...normalized.map((event) => ({ ...event, received_at: now }))].slice(-200),
        receipts: receipt ? [...old.receipts, receipt].slice(-128) : old.receipts,
    }
    return {}
}

export function registerClientReports(on, protocol) {
    const eventIds = new Set(
        Object.values(protocol.root.lookupEnum('cs.AnnivClientEventId').values).filter((id) => id > 0),
    )
    on('PetCaressCount', (c, r) => recordPetCaress(c.tables, c.state, r.u64))
    on('AnnivClientReport', (c, r) => recordAnniversaryReport(c.state, r, c.now, eventIds, c.requestKey))
    on('MapLoadFinish', (c) => {
        // CutWorldFlow/TransferFlow.OnComplete sends9151 without a response.
        // It reports scene presentation completion, not dungeon victory or the
        // multiplayer player-loaded handshake9601.
        c.state.world.map_load_finished = { map_id: c.state.world.map_id, time: c.now }
        pushSceneMode(c)
        const ready = { ...c, pushBefore: c.push }
        publishCombatEnemyActivations(ready)
        replayCombatEnemyTerminals(ready)
    })
}
