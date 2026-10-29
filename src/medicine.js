import catalog from '../configs/medicine-effect-catalog.json' with { type: 'json' }
import policy from '../configs/medicine-policy.json' with { type: 'json' }
import formulas from '../configs/npc-arena-formulas.json' with { type: 'json' }
import elements from '../configs/npc-arena-elements.json' with { type: 'json' }
import { createHash } from 'node:crypto'
import { ErrorCode } from './error-codes.js'
import { ensure, syncPlayer } from './handlers/common.js'
import { spend } from './inventory.js'
import { activeFormationManager, temporaryHeroes } from './trial-actors.js'
import { u64 } from './combat-state.js'
import {
    medicineDraft,
    medicineContext,
    reconcileMedicineContext,
    endMedicineTarget,
    trackMedicineTarget,
    hasPersonalBuffConflict,
    registerPersonalBuffSource,
    medicineCleanupPayload,
    validateMedicineLedger,
    personalBuffFrames,
    takeMedicineCleanupPayload,
    requireMedicineEnvelope,
    currentMedicineTarget,
} from './medicine-state.js'

function knownCooldownTypes() {
    return [...new Set(Object.values(catalog.medicines).map((row) => row.cooldownType))]
}
export function medicineCooldownPayload(state, now) {
    return {
        infos: knownCooldownTypes().map((type) => ({
            type,
            cd_expire: state.medicine?.cooldowns?.[type]?.expire > now ? state.medicine.cooldowns[type].expire : 0,
        })),
        send_type: 0,
    }
}
export function medicineDue(state, now) {
    const ledger = requireMedicineEnvelope(state)
    if (!ledger) return false
    let due = false
    for (const row of Object.values(ledger.cooldowns)) {
        ensure(
            row &&
                typeof row === 'object' &&
                !Array.isArray(row) &&
                Number.isSafeInteger(row.expire) &&
                row.expire >= 0 &&
                row.expire <= 0xffffffff &&
                (row.expiryNotified === undefined || typeof row.expiryNotified === 'boolean'),
            'Malformed current medicine cooldown',
            ErrorCode.GameConfig,
        )
        if (row.expire <= now && !row.expiryNotified) due = true
    }
    return due
}
export function syncMedicineExpiry(c) {
    if (!medicineDue(c.state, c.now)) return
    reconcileMedicine(c)
    const ledger = medicineDraft(c.state),
        infos = []
    ledger.cooldowns = { ...ledger.cooldowns }
    for (const [type, row] of Object.entries(ledger.cooldowns))
        if (row.expire <= c.now && !row.expiryNotified) {
            ledger.cooldowns[type] = { ...row, expiryNotified: true }
            infos.push({ type: Number(type), cd_expire: 0 })
        }
    if (infos.length) c.pushBefore('SCProtoMedicineInfo', { infos, send_type: 0 })
}
export function reconcileMedicine(c) {
    const tracked = requireMedicineEnvelope(c.state)?.tracked
    if (!tracked || !Object.keys(tracked).length) return
    reconcileMedicineContext(c.state, c.now)
    for (const id of Object.keys(c.state.medicine.tracked)) {
        const { receipt, target } = currentMedicineTarget(c.state, id)
        if (receipt.expire <= c.now) endMedicineTarget(c.state, id, 'cancelled', 'pending-expired', c.now)
        else if (hasPersonalBuffConflict(c.state, id, target.elementConfigId, target.buffGuid))
            endMedicineTarget(c.state, id, 'cancelled', 'known-personal-source-conflict', c.now)
    }
}
export function medicineDeliveryPayload(c) {
    validateMedicineLedger(c.state)
    reconcileMedicine(c)
    const cleanup = medicineCleanupPayload(c.state, true),
        updates = []
    for (const [id, row] of Object.entries(c.state.medicine?.tracked ?? {})) {
        const receipt = c.state.medicine.receipts[row.receipt],
            target = receipt.targets[row.index],
            saved = c.state.player.heros_info.battle_infos.find((entry) => entry.hero_id === id)
        if (
            !saved ||
            saved.hp !== 0 ||
            row.lifeToken !== target.lifeToken ||
            row.deathGeneration !== target.deathGeneration
        ) {
            endMedicineTarget(c.state, id, 'cancelled', 'delivery-state-invalid', c.now)
            continue
        }
        if (!hasPersonalBuffConflict(c.state, id, target.elementConfigId, target.buffGuid))
            updates.push(buffInfo(receipt, target))
    }
    const finalCleanup = medicineCleanupPayload(c.state, true)
    return updates.length || finalCleanup ? { ...(finalCleanup ?? cleanup ?? {}), update_buffs: updates } : null
}
export function syncMedicineDelivery(c) {
    if (!c.state.medicine) return
    c.push('SCProtoMedicineInfo', medicineCooldownPayload(c.state, c.now))
    for (const payload of personalBuffFrames(medicineDeliveryPayload(c))) c.push('CSProtoWorldBuffSync', payload)
}
function buffInfo(receipt, target) {
    // Local timestamps: accepted time for add/trigger, expiry for last_time.
    // No official meanings for these unused consumer fields are claimed.
    return {
        guid: target.buffGuid,
        buff_id: receipt.worldBuffId,
        target_id: target.actorUuid,
        add_time: receipt.acceptedAt,
        last_time: receipt.expire,
        trigger_time: receipt.acceptedAt,
    }
}
export function useMedicine(c, request, store) {
    validateMedicineLedger(c.state)
    ensure(
        policy.runtimeEnabled && policy.approved && policy.revivalMode === 'compatibility',
        'Medicine policy is unavailable',
        ErrorCode.FunctionClosed,
    )
    ensure(
        Number.isSafeInteger(request.num) && request.num > 0,
        'Missing medicine quantity',
        ErrorCode.UseItemSendNumZero,
    )
    ensure(request.num === 1, 'Medicine requires one item', ErrorCode.UseItemArgFail)
    ensure(
        Array.isArray(request.args) && request.args.length === 1,
        'Medicine requires one formation anchor',
        ErrorCode.MedicineRequireTarget,
    )
    const common = c.tables.find('common_item', request.itemid),
        row = c.tables.find('medicine', request.itemid),
        compiled = catalog.medicines[request.itemid]
    ensure(common && row, 'Medicine configuration is missing', ErrorCode.GameConfig)
    ensure(common.type === 701 && common.useType === 17, 'Malformed medicine item configuration', ErrorCode.GameConfig)
    ensure(
        Number.isInteger(row.medicinType) && Number.isInteger(row.medicineTarget),
        'Malformed medicine family',
        ErrorCode.GameConfig,
    )
    ensure(
        row.medicinType === 3 && [1, 2].includes(row.medicineTarget),
        'Medicine effect family is not implemented',
        ErrorCode.FunctionClosed,
    )
    ensure(compiled, 'Revival medicine compiled configuration is missing', ErrorCode.GameConfig)
    ensure(
        common.type === 701 && common.useType === 17 && row.medicinType === 3 && [1, 2].includes(row.medicineTarget),
        'Malformed revival medicine configuration',
        ErrorCode.GameConfig,
    )
    const worldBuff = c.tables.find('world_buff', row.buffId),
        effect = catalog.effects[worldBuff?.buffElementId]
    ensure(
        row.medicineTarget === compiled.targetType &&
            row.buffType === compiled.cooldownType &&
            row.coolDown === compiled.cooldownSeconds &&
            row.buffId === compiled.worldBuffId &&
            worldBuff?.buffElementId === compiled.elementConfigId &&
            effect?.kind === 'revive' &&
            effect.formulaId > 0,
        'Medicine catalog differs from current tables',
        ErrorCode.GameConfig,
    )
    ensure(
        worldBuff.duration_type === compiled.worldBuff.durationType &&
            worldBuff.duration === compiled.worldBuff.duration &&
            worldBuff.group === compiled.worldBuff.group &&
            worldBuff.priority === compiled.worldBuff.priority &&
            elements.elements?.[compiled.elementConfigId]?.config.type === 'ConfigTReviveElementParams' &&
            createHash('sha256').update(JSON.stringify(formulas.formulas[effect.formulaId])).digest('hex') ===
                effect.formulaSha256,
        'Medicine effect resources differ from compiled contract',
        ErrorCode.GameConfig,
    )
    ensure(
        Number.isSafeInteger(row.coolDown) &&
            row.coolDown > 0 &&
            Number.isSafeInteger(c.now) &&
            c.now >= 0 &&
            c.now + row.coolDown <= 0xffffffff,
        'Invalid medicine cooldown',
        ErrorCode.GameConfig,
    )
    const city = c.tables.find('world_city', c.state.world.map_id),
        home = Number(c.tables.get('game').find((entry) => entry.title === 'HOME_ID')?.value)
    ensure(city && Number.isSafeInteger(home) && home > 0, 'Medicine scene configuration missing', ErrorCode.GameConfig)
    ensure(
        policy.sceneTypes.includes(city.type) && city.playModule !== 'Home' && c.state.world.map_id !== home,
        'Medicine cannot be used in this scene',
        ErrorCode.MedicineRequireSpecMode,
    )
    reconcileMedicine(c)
    for (const payload of personalBuffFrames(takeMedicineCleanupPayload(c.state)))
        c.pushBefore('CSProtoWorldBuffSync', payload)
    ensure(
        !(c.state.medicine?.cooldowns?.[row.buffType]?.expire > c.now),
        'Medicine is cooling down',
        ErrorCode.MedicineRequireCoolDown,
    )
    const manager = activeFormationManager(c.state),
        group = manager?.groups.find((entry) => entry.id === manager.cur_group),
        heroes = new Map(
            [...c.state.player.heros_info.heros, ...temporaryHeroes(c.state)].map((hero) => [hero.guid, hero]),
        ),
        ids = [...new Set((group?.heros ?? []).map((entry) => entry.hero_id).filter((id) => id && id !== '0'))]
    ensure(
        typeof request.args[0] !== 'number' || Number.isSafeInteger(request.args[0]),
        'Unsafe medicine anchor',
        ErrorCode.UseItemArgFail,
    )
    const anchor = u64(request.args[0])
    ensure(
        ids.includes(anchor) && heroes.has(anchor),
        'Medicine anchor is not deployed',
        ErrorCode.MedicineRequireTarget,
    )
    const selected = row.medicineTarget === 1 ? [anchor] : ids,
        targets = selected.map((id) => ({
            id,
            hero: heroes.get(id),
            saved: c.state.player.heros_info.battle_infos.find((entry) => entry.hero_id === id),
        }))
    for (const target of targets)
        ensure(
            target.hero &&
                target.saved &&
                Number.isSafeInteger(target.saved.hp) &&
                target.saved.hp >= 0 &&
                Number.isInteger(target.saved.alive_state) &&
                target.saved.alive_state >= 0 &&
                target.saved.alive_state <= 2,
            'Invalid medicine target battle state',
            ErrorCode.GameConfig,
        )
    const dead = targets.filter((target) => target.saved.hp === 0)
    ensure(dead.length > 0, 'Medicine has no dead target', ErrorCode.MedicineRequireTargetDead)
    for (const target of dead)
        ensure(
            !c.state.medicine?.tracked?.[target.id] &&
                !hasPersonalBuffConflict(c.state, target.id, compiled.elementConfigId),
            'Medicine target configuration is occupied',
            ErrorCode.TargetBusy,
        )
    const before = new Map(c.state.player.sbag_infos.items.map((item) => [item.guid, item.itemnum])),
        spent = spend(c.state, new Map([[request.itemid, 1]]), 0, c.now),
        ledger = medicineDraft(c.state)
    ledger.nextReceipt = String(BigInt(ledger.nextReceipt) + 1n)
    const receiptId = ledger.nextReceipt,
        receipt = {
            id: receiptId,
            itemId: request.itemid,
            quantity: 1,
            acceptedAt: c.now,
            expire: c.now + row.coolDown,
            cooldownType: row.buffType,
            worldBuffId: row.buffId,
            context: medicineContext(c.state),
            status: 'open',
            costSlices: spent.map((item) => ({
                guid: item.guid,
                itemId: item.itemid,
                quantity: before.get(item.guid) - item.itemnum,
                deadtime: item.deadtime ?? 0,
            })),
            targets: [],
        }
    for (const target of dead) {
        const tracked = trackMedicineTarget(c.state, target.id, target.saved, receiptId, receipt.targets.length)
        let guid
        do {
            try {
                guid = store.nextSequence('personal-world-buff:' + c.id)
            } catch (error) {
                // Store's bounded wire-identity allocator has one explicit
                // exhaustion branch. Unexpected SQL faults retain their identity.
                if (error?.message === 'Sequence exhausted')
                    ensure(false, 'Medicine personal effect identity exhausted', ErrorCode.GameConfig)
                throw error
            }
        } while (c.state.personalBuffSources?.[guid] || c.state.medicine.issued[guid])
        receipt.targets.push({
            actorUuid: target.id,
            lifeToken: tracked.lifeToken,
            deathGeneration: tracked.deathGeneration,
            buffGuid: guid,
            elementConfigId: compiled.elementConfigId,
            status: 'pending',
        })
    }
    const final = medicineDraft(c.state)
    final.receipts = { ...final.receipts, [receiptId]: receipt }
    final.cooldowns = { ...final.cooldowns, [row.buffType]: { expire: receipt.expire, receipt: receiptId } }
    final.issued = { ...final.issued }
    for (const target of receipt.targets)
        final.issued[target.buffGuid] = { actorUuid: target.actorUuid, elementConfigId: target.elementConfigId }
    const updates = receipt.targets.map((target) => buffInfo(receipt, target))
    for (const info of updates) registerPersonalBuffSource(c.state, c.tables, info, 'medicine')
    syncPlayer({ ...c, push: c.pushBefore })
    c.pushBefore('SCProtoMedicineInfo', { infos: [{ type: row.buffType, cd_expire: receipt.expire }], send_type: 0 })
    c.pushBefore('CSProtoWorldBuffSync', { update_buffs: updates })
    return { rewards: [] }
}
