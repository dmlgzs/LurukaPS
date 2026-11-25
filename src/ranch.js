import {
    ranchBonusEnabled,
    validateRanchBonus,
    adoptRanchBonus,
    reconcileRanchBonuses,
    recordRanchBaseCommit,
    reserveRanchDropGuid,
} from './ranch-bonus.js'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { homeCondition } from './home-grid.js'
import { allocateHomeGuid } from './home-identities.js'

const lists = (value) =>
    String(value || '')
        .split('|')
        .filter(Boolean)
        .map(Number)
const catalogs = new WeakMap()
export function ranchCatalog(tables) {
    if (catalogs.has(tables)) return catalogs.get(tables)
    const data = {
        blocks: tables.get('home_block').filter((row) => row.blockType === 2),
        levels: new Map(tables.get('home_ranch').map((row) => [row.level, row])),
        talents: new Map(tables.get('pet_home_talent').map((row) => [row.id, row])),
        drops: new Map(tables.get('home_drop').map((row) => [row.id, row])),
        constants: new Map(tables.get('game').map((row) => [row.title, Number(row.value)])),
        technology: tables.get('home_technology'),
    }
    ensure(data.levels.has(1), 'Missing initial ranch level', ErrorCode.HomeRanchLvNotExist)
    catalogs.set(tables, data)
    return data
}
function changed(state) {
    state.homeRevision = (state.homeRevision || 0) + 1
}
export function ensureRanches(tables, state) {
    if (!state.home) return []
    let home = state.home
    const data = ranchCatalog(tables)
    let copied = false
    for (const block of data.blocks) {
        if (!homeCondition(block.unlockCondi, state) || home.ranches?.[block.id]) continue
        if (!copied) {
            state.home = { ...home, ranches: { ...home.ranches } }
            home = state.home
            copied = true
        }
        const guid = allocateHomeGuid(home)
        ;(home.ranches ??= {})[block.id] = {
            guid,
            block_id: block.id,
            lv: 1,
            product_pets: [],
            harvest_pet: '0',
            drops: [],
            eggs: [],
            stores: [],
            nextDropGuid: 1,
        }
        changed(state)
    }
    return Object.values(home.ranches || {})
}
export function ranchAt(tables, state, blockId) {
    const config = ranchCatalog(tables).blocks.find((row) => row.id === blockId)
    ensure(config, 'Unknown ranch block', ErrorCode.HomeRanchNotExist)
    ensure(homeCondition(config.unlockCondi, state), 'Ranch is locked', ErrorCode.HomeRanchSysLock)
    ensureRanches(tables, state)
    const ranch = state.home.ranches[blockId]
    ensure(
        ranchCatalog(tables).levels.has(ranch.lv),
        'Saved ranch level is not configured',
        ErrorCode.HomeRanchLvNotExist,
    )
    return writableRanch(state, blockId)
}
export function ranchWorkerLimit(tables, state, field = 'pasture_woker_max') {
    const level = tables.find('home_level', state.home.level)
    ensure(
        level && Number.isSafeInteger(level[field]) && level[field] >= 0,
        'Missing home worker capacity',
        ErrorCode.GameConfig,
    )
    // 1.0 HomeUtil.GetPetStationedWorkingLimit / GetRanchWorkingLimit:
    // WorkerMax / PastureWokerMax + ConstType.HOME_KIBO_WORK_MANAGE_POSITION.
    // The former condition-based free-work-position table is no longer used.
    const rows = tables.get('game').filter((row) => row.title === 'HOME_KIBO_WORK_MANAGE_POSITION')
    ensure(
        rows.length === 1 && rows[0].type === 'int' && /^\d+$/.test(String(rows[0].value)),
        'Missing or malformed home work-position capacity constant',
        ErrorCode.GameConfig,
    )
    const increment = Number(rows[0].value),
        capacity = level[field] + increment
    ensure(
        Number.isSafeInteger(increment) && increment >= 0 && Number.isSafeInteger(capacity) && capacity <= 0xffffffff,
        'Home worker capacity exceeds wire bounds',
        ErrorCode.GameConfig,
    )
    return capacity
}
export function ranchPetDrops(tables, pet) {
    const data = ranchCatalog(tables),
        talent = data.talents.get(pet.config_id)
    ensure(talent, 'Missing ranch pet configuration', ErrorCode.GameConfig)
    return lists(talent.farmProducts).map((id) => {
        const row = data.drops.get(id)
        ensure(row, 'Missing ranch production drop', ErrorCode.GameConfig)
        ensure(
            row.itemType === 3 && lists(row.itemId).length === 1,
            'Unsupported ranch drop variant',
            ErrorCode.FunctionClosed,
        )
        ensure(
            [row.minValue, row.maxValue, row.rate, row.dropTime].every(Number.isSafeInteger) &&
                row.minValue > 0 &&
                row.maxValue >= row.minValue &&
                row.maxValue <= 0xffffffff &&
                row.rate >= 0 &&
                row.rate <= 10000 &&
                row.dropTime > 0,
            'Invalid ranch drop range',
            ErrorCode.GameConfig,
        )
        ensure(tables.find('common_item', lists(row.itemId)[0]), 'Missing ranch output item', ErrorCode.GameConfig)
        return row
    })
}
export function ranchSeconds(tables, state, pet, row) {
    const data = ranchCatalog(tables)
    let reduction = 0
    for (const tech of data.technology) {
        if (state.home.technology?.levels[tech.type]?.level !== tech.level) continue
        const ids = lists(tech.buffId),
            values = String(tech.buffParams || '').split('|')
        for (let index = 0; index < ids.length; index++)
            if (ids[index] === 3001) {
                ensure(!tech.buffCondition, 'Conditional ranch time bonus requires support', ErrorCode.FunctionClosed)
                const value = Number(values[index])
                ensure(
                    Number.isFinite(value) && value >= 0 && value < 10000,
                    'Invalid ranch time bonus',
                    ErrorCode.GameConfig,
                )
                reduction += value / 10000
            }
    }
    const labor = pet.labor_infos
        ?.filter((info) => info.labor_id === data.constants.get('HOME_PET_RANCH_HARVEST_LABORTYPE'))
        .at(-1)
    let speed = 0
    if (labor) {
        const efficiency = tables.find('home_labor_efficiency', labor.labor_grade)
        ensure(
            efficiency && Number.isFinite(efficiency.PastureTimeReduct),
            'Missing ranch labor efficiency',
            ErrorCode.GameConfig,
        )
        speed = Math.max(0, efficiency.PastureTimeReduct) / 10000
        if (pet.satiety_val <= data.constants.get('PET_HOME_TIRED_SATIETY'))
            speed *= data.constants.get('HOME_LABOR_PASTURE_DECREASE') / 10000
    }
    const seconds = Math.floor(row.dropTime * (1 - reduction) * (1 - speed))
    ensure(Number.isSafeInteger(seconds) && seconds > 0, 'Invalid ranch production period', ErrorCode.GameConfig)
    return seconds
}
export function ranchPayloads(tables, state) {
    return ensureRanches(tables, state).map((ranch) => ({
        guid: ranch.guid,
        build_type: 53,
        ranch_pet_work_info: {
            block_id: ranch.block_id,
            lv: ranch.lv,
            product_pets: ranch.product_pets.map(({ slot, pet_guid, drop_times }) => ({
                slot,
                pet_guid,
                drop_times: drop_times.map(({ drop_id, time }) => ({ drop_id, time })),
            })),
            harvest_pet: ranch.harvest_pet,
            // Internal sealed provenance is not a HomeRanchDropReward wire field.
            drops: ranch.drops.map(({ guid, pet_guid, drop_id, item }) => ({ guid, pet_guid, drop_id, item })),
            eggs: ranch.eggs,
            stores: ranch.stores,
        },
    }))
}
export function clearRanchPetSlots(state, guid) {
    let cleared = false
    for (const ranch of Object.values(state.home?.ranches || {})) {
        const before = ranch.product_pets.length
        ranch.product_pets = ranch.product_pets.filter((slot) => slot.pet_guid !== guid)
        if (before !== ranch.product_pets.length) cleared = true
        if (ranch.harvest_pet === guid) {
            ranch.harvest_pet = '0'
            cleared = true
        }
    }
    if (cleared) changed(state)
    return cleared
}

export function writableRanch(state, blockId) {
    const ranch = state.home.ranches[blockId]
    ensure(
        ranch &&
            ['product_pets', 'drops', 'eggs', 'stores'].every((key) => Array.isArray(ranch[key])) &&
            ['claimedRewardGuids', 'claimedEggGuids'].every(
                (key) => ranch[key] === undefined || Array.isArray(ranch[key]),
            ),
        'Malformed writable ranch state',
        ErrorCode.GameConfig,
    )
    const bonus =
        ranch.bonus && typeof ranch.bonus === 'object'
            ? {
                  ...ranch.bonus,
                  families:
                      ranch.bonus.families && typeof ranch.bonus.families === 'object'
                          ? Object.fromEntries(
                                Object.entries(ranch.bonus.families).map(([id, row]) => [
                                    id,
                                    row && typeof row === 'object' ? { ...row } : row,
                                ]),
                            )
                          : ranch.bonus.families,
                  pendingBonus: Array.isArray(ranch.bonus.pendingBonus)
                      ? ranch.bonus.pendingBonus.map((row) =>
                            row && typeof row === 'object'
                                ? {
                                      ...row,
                                      item: row.item && typeof row.item === 'object' ? { ...row.item } : row.item,
                                  }
                                : row,
                        )
                      : ranch.bonus.pendingBonus,
              }
            : ranch.bonus
    const draft = {
        ...ranch,
        product_pets: Array.isArray(ranch.product_pets)
            ? ranch.product_pets.map((slot) => ({
                  ...slot,
                  drop_times: Array.isArray(slot.drop_times)
                      ? slot.drop_times.map((clock) => ({ ...clock }))
                      : slot.drop_times,
              }))
            : ranch.product_pets,
        drops: Array.isArray(ranch.drops) ? ranch.drops.slice() : ranch.drops,
        eggs: Array.isArray(ranch.eggs) ? ranch.eggs.slice() : ranch.eggs,
        stores: Array.isArray(ranch.stores) ? ranch.stores.slice() : ranch.stores,
        ...(ranch.claimedRewardGuids ? { claimedRewardGuids: ranch.claimedRewardGuids.slice() } : {}),
        ...(ranch.claimedEggGuids ? { claimedEggGuids: ranch.claimedEggGuids.slice() } : {}),
        ...(ranch.bonus !== undefined ? { bonus } : {}),
    }
    state.home = { ...state.home, ranches: { ...state.home.ranches, [blockId]: draft } }
    return draft
}
export function ranchDue(tables, state, now) {
    const data = ranchCatalog(tables)
    for (const ranch of Object.values(state.home?.ranches ?? {})) {
        ensure(
            Array.isArray(ranch.product_pets) && Array.isArray(ranch.drops),
            'Invalid saved ranch scheduler state',
            ErrorCode.GameConfig,
        )
        if (ranch.bonus !== undefined) {
            ensure(
                ranchBonusEnabled() &&
                    ranch.bonus &&
                    ranch.bonus.version === 1 &&
                    Array.isArray(ranch.bonus.pendingBonus) &&
                    ranch.bonus.pendingBonus.length <= 2,
                'Ranch bonus model unavailable or malformed',
                ErrorCode.GameConfig,
            )
            const config = data.levels.get(ranch.lv)
            ensure(
                config && Number.isSafeInteger(config.petProductLimit) && config.petProductLimit > 0,
                'Invalid ranch visible capacity',
                ErrorCode.GameConfig,
            )
            if (ranch.bonus.pendingBonus.length && ranch.drops.length < config.petProductLimit) return true
        }
        if (ranch.product_pets.some((slot) => slot.drop_times.some((clock) => clock.time <= now))) return true
    }
    return false
}
export function retimeRanches(tables, state, now) {
    let updated = false
    for (const ranch of Object.values(state.home?.ranches ?? {})) {
        const changes = []
        for (let slotIndex = 0; slotIndex < ranch.product_pets.length; slotIndex++) {
            const slot = ranch.product_pets[slotIndex],
                pet = state.pets.find((item) => item.guid === slot.pet_guid)
            ensure(pet, 'Missing assigned ranch pet', ErrorCode.GameConfig)
            const drops = ranchPetDrops(tables, pet)
            for (let index = 0; index < slot.drop_times.length; index++) {
                const clock = slot.drop_times[index],
                    row = drops.find((item) => item.id === clock.drop_id)
                ensure(
                    row && Number.isSafeInteger(clock.seconds) && clock.seconds > 0 && Number.isSafeInteger(clock.time),
                    'Invalid saved ranch clock',
                    ErrorCode.GameConfig,
                )
                const seconds = ranchSeconds(tables, state, pet, row)
                if (clock.seconds === seconds || clock.time <= now) continue
                const time = now + Math.max(1, Math.ceil(((clock.time - now) / clock.seconds) * seconds))
                ensure(Number.isSafeInteger(time) && time <= 0xffffffff, 'Ranch clock overflow', ErrorCode.InvalidLogic)
                changes.push({ slotIndex, index, time, seconds })
            }
        }
        if (changes.length) {
            const draft = writableRanch(state, ranch.block_id)
            for (const row of changes)
                Object.assign(draft.product_pets[row.slotIndex].drop_times[row.index], {
                    time: row.time,
                    seconds: row.seconds,
                })
            updated = true
        }
    }
    if (updated) changed(state)
    return updated
}
// Geometric skipping is bounded by visible capacity, not missed periods.
function successes(attempts, probability, limit, randomInt) {
    if (!probability || !attempts || !limit) return []
    const result = []
    let at = 0
    while (result.length < limit) {
        const failures =
            probability === 1
                ? 0
                : Math.floor(Math.log1p(-(randomInt(0x100000000) + 0.5) / 0x100000000) / Math.log1p(-probability))
        at += failures
        if (at >= attempts) break
        result.push(at++)
    }
    return result
}
function floorLimit(tables, ranch) {
    const config = ranchCatalog(tables).levels.get(ranch.lv)
    ensure(
        config && Number.isSafeInteger(config.petProductLimit) && config.petProductLimit > 0,
        'Invalid ranch floor capacity',
        ErrorCode.GameConfig,
    )
    return config.petProductLimit
}
function drainInto(tables, ranch) {
    const ledger = validateRanchBonus(tables, ranch),
        moved = []
    if (!ledger) return moved
    while (ledger.pendingBonus.length && ranch.drops.length < floorLimit(tables, ranch)) {
        const sealed = ledger.pendingBonus.shift()
        // Preserve the exact historical producer and selected bonus HomeDrop.
        ranch.drops.push({
            guid: sealed.guid,
            pet_guid: sealed.pet_guid,
            drop_id: sealed.drop_id,
            item: { ...sealed.item },
            bonus_source: {
                family: sealed.family,
                technologyId: sealed.technologyId,
                paramsFingerprint: sealed.paramsFingerprint,
                triggerBaseGuid: sealed.triggerBaseGuid,
                triggerBaseDropId: sealed.triggerBaseDropId,
                triggeredAt: sealed.triggeredAt,
            },
        })
        moved.push(sealed.guid)
    }
    return moved
}
export function drainRanchPending(tables, state, ranch, now) {
    if (ranch.bonus === undefined) return { changed: false, homeChanged: false, movedGuids: [] }
    ensure(ranchBonusEnabled(), 'Saved ranch bonus requires its configured model', ErrorCode.GameConfig)
    const ledger = validateRanchBonus(tables, ranch)
    if (!ledger.pendingBonus.length || ranch.drops.length >= floorLimit(tables, ranch))
        return { changed: false, homeChanged: false, movedGuids: [] }
    const draft = writableRanch(state, ranch.block_id),
        movedGuids = drainInto(tables, draft)
    if (movedGuids.length) changed(state)
    return { changed: !!movedGuids.length, homeChanged: !!movedGuids.length, movedGuids }
}
export function reconcileRanchTechnology(tables, state) {
    if (!ranchBonusEnabled()) return false
    let updated = false
    for (const ranch of Object.values(state.home?.ranches ?? {})) {
        if (ranch.bonus === undefined) continue
        validateRanchBonus(tables, ranch)
        updated = reconcileRanchBonuses(tables, state, writableRanch(state, ranch.block_id)) || updated
    }
    return updated
}
export function settleRanches(tables, state, now, randomInt) {
    const enabled = ranchBonusEnabled()
    let updated = false
    for (const original of ensureRanches(tables, state)) {
        ensure(
            Array.isArray(original.product_pets) && Array.isArray(original.drops),
            'Malformed ranch production state',
            ErrorCode.GameConfig,
        )
        const managed = original.bonus !== undefined
        ensure(enabled || !managed, 'Saved ranch bonus requires its configured model', ErrorCode.GameConfig)
        if (managed) validateRanchBonus(tables, original)
        // Own every mutable path even when the caller borrowed a shallow draft.
        const ranch = writableRanch(state, original.block_id)
        if (managed) {
            reconcileRanchBonuses(tables, state, ranch)
            if (drainInto(tables, ranch).length) updated = true
        }
        const room = Math.max(0, floorLimit(tables, ranch) - ranch.drops.length),
            pending = []
        for (const slot of ranch.product_pets) {
            const pet = state.pets.find((item) => item.guid === slot.pet_guid)
            ensure(
                pet && pet.work_status === 6 && pet.work_build === ranch.block_id,
                'Inconsistent ranch production assignment',
                ErrorCode.PetWorkingStatusValid,
            )
            ensure(Array.isArray(slot.drop_times), 'Malformed ranch production clocks', ErrorCode.GameConfig)
            for (const clock of slot.drop_times) {
                const row = ranchPetDrops(tables, pet).find((item) => item.id === clock.drop_id)
                ensure(
                    row &&
                        Number.isSafeInteger(clock.time) &&
                        clock.time > 0 &&
                        Number.isSafeInteger(clock.seconds) &&
                        clock.seconds > 0,
                    'Invalid ranch production clock',
                    ErrorCode.GameConfig,
                )
                if (clock.time > now) continue
                const attempts = Math.floor((now - clock.time) / clock.seconds) + 1
                for (const offset of successes(attempts, row.rate / 10000, room, randomInt))
                    pending.push({ at: clock.time + offset * clock.seconds, slot, row })
                clock.time += attempts * clock.seconds
                ensure(
                    Number.isSafeInteger(clock.time) && clock.time <= 0xffffffff,
                    'Ranch clock overflow',
                    ErrorCode.InvalidLogic,
                )
                updated = true
            }
        }
        pending.sort((a, b) => a.at - b.at || a.slot.slot - b.slot.slot || a.row.id - b.row.id)
        for (const { at, slot, row } of pending) {
            if (ranch.drops.length >= floorLimit(tables, ranch) || ranch.bonus?.pendingBonus.length) break
            const count = row.minValue + (row.maxValue > row.minValue ? randomInt(row.maxValue - row.minValue + 1) : 0)
            const drop = {
                guid: reserveRanchDropGuid(ranch),
                pet_guid: slot.pet_guid,
                drop_id: row.id,
                item: { itemtype: row.itemType, itemid: lists(row.itemId)[0], itemnum: count },
            }
            ranch.drops.push(drop)
            if (managed) {
                recordRanchBaseCommit(tables, state, ranch, drop, at, randomInt)
                if (drainInto(tables, ranch).length) updated = true
            }
        }
        // First close every legacy <=T window above without bonus, then adopt.
        if (enabled && !managed) adoptRanchBonus(tables, state, ranch, now)
        if (managed) validateRanchBonus(tables, ranch)
    }
    if (updated) changed(state)
    // Explicitly separate: eggs, daily limits, satiety/experience and offline
    // automatic pickup still lack an approved implemented producer here.
    return updated
}
