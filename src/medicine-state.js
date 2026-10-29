import catalog from '../configs/medicine-effect-catalog.json' with { type: 'json' }
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { effectiveFormationManager } from './formation-scope.js'
const record = (value) => !!value && typeof value === 'object' && !Array.isArray(value)
export function requireMedicineEnvelope(state) {
    const ledger = state.medicine
    if (ledger === undefined) return undefined
    ensure(
        record(ledger) &&
            ledger.version === 1 &&
            typeof ledger.nextLife === 'string' &&
            /^(0|[1-9]\d*)$/.test(ledger.nextLife) &&
            typeof ledger.nextReceipt === 'string' &&
            /^(0|[1-9]\d*)$/.test(ledger.nextReceipt) &&
            ['tracked', 'receipts', 'cooldowns', 'issued', 'cleanup'].every((key) => record(ledger[key])),
        'Malformed managed medicine envelope',
        ErrorCode.GameConfig,
    )
    return ledger
}
export function currentMedicineTarget(state, id) {
    const ledger = requireMedicineEnvelope(state),
        tracked = ledger?.tracked[String(id)]
    if (tracked === undefined) return null
    ensure(
        record(tracked) && Number.isSafeInteger(tracked.index) && tracked.index >= 0,
        'Malformed current medicine tracker',
        ErrorCode.GameConfig,
    )
    const receipt = ledger.receipts[tracked.receipt],
        target = receipt?.targets?.[tracked.index]
    ensure(
        record(receipt) &&
            receipt.status === 'open' &&
            Array.isArray(receipt.targets) &&
            record(target) &&
            target.status === 'pending' &&
            target.actorUuid === String(id) &&
            target.lifeToken === tracked.lifeToken &&
            typeof tracked.lifeToken === 'string' &&
            /^[1-9]\d*$/.test(tracked.lifeToken) &&
            Number.isSafeInteger(tracked.deathGeneration) &&
            tracked.deathGeneration >= 0 &&
            target.deathGeneration === tracked.deathGeneration &&
            Number.isSafeInteger(tracked.hp) &&
            tracked.hp >= 0 &&
            Number.isInteger(tracked.aliveState) &&
            tracked.aliveState >= 0 &&
            tracked.aliveState <= 2 &&
            tracked.dead === (tracked.hp === 0 || tracked.aliveState !== 0) &&
            Number.isSafeInteger(tracked.vitalsRevision) &&
            tracked.vitalsRevision >= 0 &&
            Number.isSafeInteger(receipt.expire) &&
            receipt.expire >= 0 &&
            typeof receipt.context === 'string',
        'Malformed current medicine target',
        ErrorCode.GameConfig,
    )
    return { tracked, receipt, target }
}

// Server-local forward observations, never an official physical entity nonce.
// Every branch is copied before mutation: combat forks borrow closed history.
export function medicineDraft(state) {
    const previous = requireMedicineEnvelope(state)
    state.medicine = previous
        ? { ...previous }
        : {
              version: 1,
              nextLife: '0',
              nextReceipt: '0',
              tracked: {},
              receipts: {},
              cooldowns: {},
              issued: {},
              cleanup: {},
          }
    return state.medicine
}
function changeTarget(state, tracked, status, reason, now) {
    const ledger = medicineDraft(state),
        receipt = ledger.receipts[tracked.receipt],
        target = receipt?.targets[tracked.index]
    if (!target || target.status !== 'pending') return
    const targets = receipt.targets.slice()
    targets[tracked.index] = {
        ...target,
        status,
        reason,
        endedAt: now ?? null,
        ...(status === 'ended-by-accepted-revival' ? { origin: 'unknown-or-competing' } : {}),
    }
    ledger.receipts = {
        ...ledger.receipts,
        [tracked.receipt]: {
            ...receipt,
            targets,
            status: targets.some((row) => row.status === 'pending') ? 'open' : 'closed',
        },
    }
    ledger.tracked = { ...ledger.tracked }
    delete ledger.tracked[target.actorUuid]
    ledger.cleanup = {
        ...ledger.cleanup,
        [target.buffGuid]: {
            actorUuid: target.actorUuid,
            elementConfigId: target.elementConfigId,
            blocked: reason === 'known-personal-source-conflict',
        },
    }
}
export function endMedicineTarget(state, id, status, reason, now) {
    const tracked = currentMedicineTarget(state, id)?.tracked
    if (tracked) changeTarget(state, tracked, status, reason, now)
}
export function observeAcceptedHeroVitals(state, id, after, reason, now) {
    const tracked = currentMedicineTarget(state, id)?.tracked
    if (!tracked) return
    const dead = after.hp === 0 || after.alive_state !== 0
    if (tracked.hp === after.hp && tracked.aliveState === after.alive_state) return
    const ledger = medicineDraft(state),
        next = {
            ...tracked,
            hp: after.hp,
            aliveState: after.alive_state,
            dead,
            deathGeneration: tracked.deathGeneration + (!tracked.dead && dead ? 1 : 0),
            vitalsRevision: tracked.vitalsRevision + 1,
        }
    ledger.tracked = { ...ledger.tracked, [String(id)]: next }
    if (!dead)
        changeTarget(
            state,
            next,
            reason === 'accepted-10721' ? 'ended-by-accepted-revival' : 'ended-by-external-state',
            reason,
            now,
        )
    else if (next.deathGeneration !== tracked.deathGeneration)
        changeTarget(state, next, 'cancelled', 'new-death-generation', now)
}
export function invalidateTrackedHeroes(state, ids, reason, now) {
    const ledger = requireMedicineEnvelope(state)
    if (!ledger || !Object.keys(ledger.tracked).length) return
    for (const id of ids) endMedicineTarget(state, String(id), 'cancelled', reason, now)
}
export function invalidateMedicineContext(state, reason, now) {
    const ledger = requireMedicineEnvelope(state)
    if (!ledger) return
    invalidateTrackedHeroes(state, Object.keys(ledger.tracked), reason, now)
}
export function medicineContext(state) {
    const manager = effectiveFormationManager(state),
        type = manager?.type,
        group = manager?.groups.find((row) => row.id === manager.cur_group)
    return JSON.stringify([
        state.world.map_id,
        type,
        manager?.cur_group ?? null,
        (group?.heros ?? []).map((row) => row.hero_id),
        state.abyssRun?.instance_id ?? null,
    ])
}
export function reconcileMedicineContext(state, now) {
    const tracked = requireMedicineEnvelope(state)?.tracked
    if (!tracked || !Object.keys(tracked).length) return
    const context = medicineContext(state)
    for (const id of Object.keys(tracked))
        if (currentMedicineTarget(state, id).receipt.context !== context)
            endMedicineTarget(state, id, 'cancelled', 'formation-or-world-context-changed', now)
}
export function trackMedicineTarget(state, id, saved, receipt, index) {
    const ledger = medicineDraft(state)
    ensure(!ledger.tracked[id], 'Medicine target has pending delivery', ErrorCode.TargetBusy)
    ensure(/^\d+$/.test(ledger.nextLife), 'Invalid medicine lifetime allocator', ErrorCode.GameConfig)
    ledger.nextLife = String(BigInt(ledger.nextLife) + 1n)
    const tracked = {
        lifeToken: ledger.nextLife,
        deathGeneration: 0,
        vitalsRevision: 0,
        hp: saved.hp,
        aliveState: saved.alive_state,
        dead: saved.hp === 0 || saved.alive_state !== 0,
        receipt,
        index,
    }
    ledger.tracked = { ...ledger.tracked, [id]: tracked }
    return tracked
}
// Shared registry for all server-managed personal WorldBuff senders. Existing
// 355 has no sender; future senders must use this API before encoding 9131.
export function registerPersonalBuffSource(state, tables, info, source = 'external') {
    requireMedicineEnvelope(state)
    ensure(
        record(info) &&
            Number.isSafeInteger(info.guid) &&
            info.guid > 0 &&
            info.guid <= 0xffffffff &&
            typeof source === 'string' &&
            source.length > 0,
        'Malformed personal WorldBuff identity',
        ErrorCode.GameConfig,
    )
    const id = String(info.target_id ?? '0')
    if (id === '0') return
    ensure(
        /^[1-9]\d*$/.test(id) && BigInt(id) <= 0xffffffffffffffffn,
        'Malformed personal WorldBuff target',
        ErrorCode.GameConfig,
    )
    const element = tables.find('world_buff', info.buff_id)?.buffElementId
    ensure(
        Number.isSafeInteger(element) && element > 0,
        'Invalid personal WorldBuff configuration',
        ErrorCode.GameConfig,
    )
    const key = String(info.guid),
        sources = state.personalBuffSources ?? {}
    ensure(record(sources), 'Malformed personal WorldBuff registry', ErrorCode.GameConfig)
    const previous = sources[key]
    ensure(
        !previous || (previous.source === source && previous.actorUuid === id && previous.elementConfigId === element),
        'Personal WorldBuff GUID collision',
        ErrorCode.GameConfig,
    )
    const target = currentMedicineTarget(state, id)?.target
    if (target?.elementConfigId === element && target.buffGuid !== info.guid) {
        ensure(false, 'Personal WorldBuff configuration occupied', ErrorCode.TargetBusy)
    }
    state.personalBuffSources = { ...sources, [key]: { actorUuid: id, elementConfigId: element, source } }
}
export function preparePersonalBuffPacket(state, tables, value) {
    for (const guid of value.del_buffs ?? []) if (!state.medicine?.issued?.[guid]) removePersonalBuffSource(state, guid)
    for (const info of value.update_buffs ?? []) {
        const own = state.medicine?.issued?.[info.guid]
        ensure(
            !own || own.actorUuid === String(info.target_id),
            'Medicine WorldBuff GUID identity differs',
            ErrorCode.GameConfig,
        )
        registerPersonalBuffSource(state, tables, info, own ? 'medicine' : 'external')
    }
}
export function removePersonalBuffSource(state, guid, source) {
    const key = String(guid),
        previous = state.personalBuffSources?.[key]
    if (!previous || (source && previous.source !== source)) return
    state.personalBuffSources = { ...state.personalBuffSources }
    delete state.personalBuffSources[key]
}
export function hasPersonalBuffConflict(state, id, element, ownGuid, ignoreMedicine = false) {
    ensure(
        state.personalBuffSources === undefined || record(state.personalBuffSources),
        'Malformed personal WorldBuff registry',
        ErrorCode.GameConfig,
    )
    return Object.entries(state.personalBuffSources ?? {}).some(([guid, row]) => {
        ensure(record(row), 'Malformed personal WorldBuff source', ErrorCode.GameConfig)
        return (
            row.actorUuid === id &&
            row.elementConfigId === element &&
            guid !== String(ownGuid ?? '') &&
            !(ignoreMedicine && row.source === 'medicine')
        )
    })
}
export function medicineCleanupPayload(state, allIssued = false) {
    const ledger = requireMedicineEnvelope(state)
    if (!ledger) return null
    const ids = allIssued ? Object.keys(ledger.issued) : Object.keys(ledger.cleanup)
    const del = ids
        .filter((guid) => {
            const row = ledger.issued[guid]
            ensure(
                /^[1-9]\d*$/.test(guid) &&
                    Number.isSafeInteger(Number(guid)) &&
                    Number(guid) <= 0xffffffff &&
                    record(row),
                'Malformed medicine cleanup identity',
                ErrorCode.GameConfig,
            )
            if (!allIssued)
                ensure(
                    record(ledger.cleanup[guid]) &&
                        ledger.cleanup[guid].actorUuid === row.actorUuid &&
                        ledger.cleanup[guid].elementConfigId === row.elementConfigId &&
                        typeof ledger.cleanup[guid].blocked === 'boolean',
                    'Malformed current medicine cleanup',
                    ErrorCode.GameConfig,
                )
            return !hasPersonalBuffConflict(state, row.actorUuid, row.elementConfigId, guid, allIssued)
        })
        .map(Number)
    return del.length ? { del_buffs: del } : null
}
export function takeMedicineCleanupPayload(state) {
    const payload = medicineCleanupPayload(state)
    if (!payload) return null
    const ledger = medicineDraft(state)
    ledger.cleanup = { ...ledger.cleanup }
    for (const guid of payload.del_buffs) {
        delete ledger.cleanup[guid]
        removePersonalBuffSource(state, guid, 'medicine')
    }
    return payload
}
export function personalBuffFrames(payload, limit = 128) {
    if (!payload) return []
    const frames = [],
        deletes = payload.del_buffs ?? [],
        updates = payload.update_buffs ?? [],
        updateIds = new Set(updates.map((row) => row.guid)),
        deleteIds = new Set(deletes),
        historical = deletes.filter((guid) => !updateIds.has(guid))
    for (let i = 0; i < historical.length; i += limit) frames.push({ del_buffs: historical.slice(i, i + limit) })
    for (let i = 0; i < updates.length; i += limit) {
        const chunk = updates.slice(i, i + limit),
            ownDeletes = chunk.map((row) => row.guid).filter((guid) => deleteIds.has(guid))
        frames.push({ ...(ownDeletes.length ? { del_buffs: ownDeletes } : {}), update_buffs: chunk })
    }
    return frames
}
export function validateMedicineLedger(state) {
    const ledger = state.medicine
    if (ledger === undefined) return
    const record = (value) => !!value && typeof value === 'object' && !Array.isArray(value),
        uint32 = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff,
        guid = (value) => typeof value === 'string' && /^[1-9]\d*$/.test(value) && BigInt(value) <= 0xffffffffffffffffn,
        ordinal = (value) => typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)
    ensure(
        record(ledger) &&
            ledger.version === 1 &&
            ordinal(ledger.nextLife) &&
            ordinal(ledger.nextReceipt) &&
            ['tracked', 'receipts', 'cooldowns', 'issued', 'cleanup'].every((key) => record(ledger[key])),
        'Malformed managed medicine ledger',
        ErrorCode.GameConfig,
    )
    for (const [id, row] of Object.entries(ledger.issued))
        ensure(
            /^[1-9]\d*$/.test(id) &&
                uint32(Number(id)) &&
                record(row) &&
                guid(row.actorUuid) &&
                uint32(row.elementConfigId) &&
                row.elementConfigId > 0 &&
                catalog.effects[row.elementConfigId],
            'Malformed issued medicine personal GUID',
            ErrorCode.GameConfig,
        )
    const issuedTargets = new Map()
    for (const [receiptId, receipt] of Object.entries(ledger.receipts)) {
        const compiled = record(receipt) && catalog.medicines[receipt.itemId]
        ensure(
            record(receipt) &&
                compiled &&
                uint32(receipt.itemId) &&
                receipt.quantity === 1 &&
                receipt.cooldownType === compiled.cooldownType &&
                receipt.worldBuffId === compiled.worldBuffId &&
                /^[1-9]\d*$/.test(receiptId) &&
                BigInt(receiptId) <= BigInt(ledger.nextReceipt) &&
                receipt.id === receiptId &&
                ['open', 'closed'].includes(receipt.status) &&
                uint32(receipt.acceptedAt) &&
                uint32(receipt.expire) &&
                receipt.expire > receipt.acceptedAt &&
                typeof receipt.context === 'string' &&
                Array.isArray(receipt.targets) &&
                receipt.targets.length > 0 &&
                Array.isArray(receipt.costSlices) &&
                receipt.costSlices.length > 0,
            'Malformed medicine receipt',
            ErrorCode.GameConfig,
        )
        let cost = 0
        for (const slice of receipt.costSlices) {
            ensure(
                record(slice) &&
                    guid(slice.guid) &&
                    slice.itemId === receipt.itemId &&
                    Number.isSafeInteger(slice.quantity) &&
                    slice.quantity > 0 &&
                    uint32(slice.deadtime),
                'Malformed medicine inventory slice',
                ErrorCode.GameConfig,
            )
            cost += slice.quantity
        }
        ensure(
            cost === receipt.quantity,
            'Medicine inventory slices differ from accepted quantity',
            ErrorCode.GameConfig,
        )
        for (let index = 0; index < receipt.targets.length; index++) {
            const target = receipt.targets[index]
            ensure(
                record(target) &&
                    guid(target.actorUuid) &&
                    ordinal(target.lifeToken) &&
                    target.lifeToken !== '0' &&
                    BigInt(target.lifeToken) <= BigInt(ledger.nextLife) &&
                    Number.isSafeInteger(target.deathGeneration) &&
                    target.deathGeneration >= 0 &&
                    uint32(target.buffGuid) &&
                    target.buffGuid > 0 &&
                    target.elementConfigId === compiled.elementConfigId &&
                    ['pending', 'ended-by-accepted-revival', 'ended-by-external-state', 'cancelled'].includes(
                        target.status,
                    ) &&
                    ledger.issued[target.buffGuid]?.actorUuid === target.actorUuid &&
                    ledger.issued[target.buffGuid]?.elementConfigId === target.elementConfigId,
                'Malformed medicine receipt target',
                ErrorCode.GameConfig,
            )
            ensure(
                !issuedTargets.has(String(target.buffGuid)),
                'Medicine personal GUID is reused',
                ErrorCode.GameConfig,
            )
            issuedTargets.set(String(target.buffGuid), target)
            if (target.status === 'pending')
                ensure(
                    ledger.tracked[target.actorUuid]?.receipt === receiptId &&
                        ledger.tracked[target.actorUuid]?.index === index,
                    'Missing tracked medicine target',
                    ErrorCode.GameConfig,
                )
        }
        ensure(
            (receipt.status === 'open') === receipt.targets.some((target) => target.status === 'pending'),
            'Medicine receipt status differs from targets',
            ErrorCode.GameConfig,
        )
    }
    for (const id of Object.keys(ledger.issued))
        ensure(issuedTargets.has(id), 'Orphan issued medicine personal GUID', ErrorCode.GameConfig)
    for (const [id, row] of Object.entries(ledger.cleanup)) {
        const issued = ledger.issued[id],
            target = issuedTargets.get(id)
        ensure(
            record(row) &&
                issued &&
                target?.status !== 'pending' &&
                typeof row.blocked === 'boolean' &&
                row.actorUuid === issued.actorUuid &&
                row.elementConfigId === issued.elementConfigId,
            'Malformed medicine cleanup reference',
            ErrorCode.GameConfig,
        )
    }
    for (const [type, row] of Object.entries(ledger.cooldowns))
        ensure(
            record(row) &&
                /^[1-9]\d*$/.test(type) &&
                uint32(Number(type)) &&
                uint32(row.expire) &&
                ledger.receipts[row.receipt]?.cooldownType === Number(type) &&
                ledger.receipts[row.receipt]?.expire === row.expire &&
                (row.expiryNotified === undefined || typeof row.expiryNotified === 'boolean'),
            'Malformed medicine cooldown',
            ErrorCode.GameConfig,
        )
    for (const [id, row] of Object.entries(ledger.tracked)) {
        ensure(
            record(row) &&
                guid(id) &&
                Number.isSafeInteger(row.index) &&
                row.index >= 0 &&
                uint32(row.hp) &&
                Number.isInteger(row.aliveState) &&
                row.aliveState >= 0 &&
                row.aliveState <= 2 &&
                row.dead === (row.hp === 0 || row.aliveState !== 0) &&
                Number.isSafeInteger(row.vitalsRevision) &&
                row.vitalsRevision >= 0,
            'Malformed tracked medicine vitals',
            ErrorCode.GameConfig,
        )
        const receipt = ledger.receipts[row.receipt],
            target = receipt?.targets?.[row.index]
        ensure(
            receipt?.status === 'open' &&
                target?.status === 'pending' &&
                target.actorUuid === id &&
                target.lifeToken === row.lifeToken &&
                target.deathGeneration === row.deathGeneration &&
                target.lifeToken !== '0' &&
                row.hp === 0 &&
                row.dead,
            'Malformed tracked medicine target reference',
            ErrorCode.GameConfig,
        )
    }
    if (state.personalBuffSources !== undefined) {
        ensure(record(state.personalBuffSources), 'Malformed personal WorldBuff registry', ErrorCode.GameConfig)
        for (const [id, row] of Object.entries(state.personalBuffSources))
            ensure(
                /^[1-9]\d*$/.test(id) &&
                    uint32(Number(id)) &&
                    record(row) &&
                    guid(row.actorUuid) &&
                    uint32(row.elementConfigId) &&
                    row.elementConfigId > 0 &&
                    typeof row.source === 'string' &&
                    row.source.length > 0 &&
                    (row.source !== 'medicine' ||
                        (ledger.issued[id]?.actorUuid === row.actorUuid &&
                            ledger.issued[id]?.elementConfigId === row.elementConfigId)),
                'Malformed personal WorldBuff source',
                ErrorCode.GameConfig,
            )
    }
}
