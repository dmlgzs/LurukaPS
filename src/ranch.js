import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { homeCondition } from './home-grid.js'

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
    const home = state.home,
        data = ranchCatalog(tables)
    for (const block of data.blocks) {
        if (!homeCondition(block.unlockCondi, state) || home.ranches?.[block.id]) continue
        const max = [...home.builds, ...(home.storedBuilds || []), ...Object.values(home.ranches || {})].reduce(
            (n, b) => Math.max(n, b.guid),
            0,
        )
        const guid = Math.max(home.nextBuildGuid || 1, max + 1)
        ensure(
            Number.isSafeInteger(guid) && guid <= 0xffffffff,
            'Ranch identity space exhausted',
            ErrorCode.InvalidLogic,
        )
        home.nextBuildGuid = guid + 1
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
    return ranch
}
export function ranchWorkerLimit(tables, state, field = 'pasture_woker_max') {
    const level = tables.find('home_level', state.home.level)
    ensure(
        level && Number.isSafeInteger(level[field]) && level[field] >= 0,
        'Missing home worker capacity',
        ErrorCode.GameConfig,
    )
    return (
        level[field] +
        tables
            .get('home_freeworkposition')
            .filter((row) => homeCondition(row.unlockCondition, state))
            .reduce((sum, row) => {
                ensure(
                    Number.isSafeInteger(row.num) && row.num >= 0,
                    'Invalid free worker capacity',
                    ErrorCode.GameConfig,
                )
                return sum + row.num
            }, 0)
    )
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
            drops: ranch.drops,
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
export function ranchDue(state, now) {
    return Object.values(state.home?.ranches || {}).some((ranch) =>
        ranch.product_pets.some((slot) => slot.drop_times.some((clock) => clock.time <= now)),
    )
}
export function retimeRanches(tables, state, now) {
    let updated = false
    for (const ranch of Object.values(state.home?.ranches || {}))
        for (const slot of ranch.product_pets) {
            const pet = state.pets.find((pet) => pet.guid === slot.pet_guid)
            ensure(pet, 'Missing assigned ranch pet', ErrorCode.GameConfig)
            const drops = ranchPetDrops(tables, pet)
            for (const clock of slot.drop_times) {
                const row = drops.find((row) => row.id === clock.drop_id)
                ensure(
                    row && Number.isSafeInteger(clock.seconds) && clock.seconds > 0 && Number.isSafeInteger(clock.time),
                    'Invalid saved ranch clock',
                    ErrorCode.GameConfig,
                )
                const seconds = ranchSeconds(tables, state, pet, row)
                if (clock.seconds === seconds || clock.time <= now) continue
                clock.time = now + Math.max(1, Math.ceil(((clock.time - now) / clock.seconds) * seconds))
                clock.seconds = seconds
                updated = true
            }
        }
    if (updated) changed(state)
    return updated
}

// Geometric skipping samples Bernoulli failures without a loop per missed
// interval. Work is bounded by the configured visible drop capacity, including
// arbitrarily old saves and zero-probability rows.
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
export function settleRanches(tables, state, now, randomInt) {
    let updated = false
    for (const ranch of ensureRanches(tables, state)) {
        const config = ranchCatalog(tables).levels.get(ranch.lv)
        ensure(
            config && Number.isSafeInteger(config.petProductLimit) && config.petProductLimit > 0,
            'Invalid ranch floor capacity',
            ErrorCode.GameConfig,
        )
        // TODO: verify whether petProductLimit is shared by the ranch or per
        // producer. Current table supplies the limit; no server capture proves
        // its attribution. Use a shared visible cap as an explicit local policy.
        const room = Math.max(0, config.petProductLimit - ranch.drops.length),
            pending = []
        for (const slot of ranch.product_pets) {
            const pet = state.pets.find((pet) => pet.guid === slot.pet_guid)
            ensure(
                pet && pet.work_status === 6 && pet.work_build === ranch.block_id,
                'Inconsistent ranch production assignment',
                ErrorCode.PetWorkingStatusValid,
            )
            for (const clock of slot.drop_times) {
                const row = ranchPetDrops(tables, pet).find((row) => row.id === clock.drop_id)
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
                updated = true
            }
        }
        pending.sort((a, b) => a.at - b.at || a.slot.slot - b.slot.slot || a.row.id - b.row.id)
        for (const { slot, row } of pending.slice(0, room)) {
            ensure(
                Number.isSafeInteger(ranch.nextDropGuid) && ranch.nextDropGuid > 0 && ranch.nextDropGuid <= 0xffffffff,
                'Ranch drop identity space exhausted',
                ErrorCode.InvalidLogic,
            )
            const count = row.minValue + (row.maxValue > row.minValue ? randomInt(row.maxValue - row.minValue + 1) : 0)
            ranch.drops.push({
                guid: ranch.nextDropGuid++,
                pet_guid: slot.pet_guid,
                drop_id: row.id,
                item: { itemtype: row.itemType, itemid: lists(row.itemId)[0], itemnum: count },
            })
        }
    }
    if (updated) changed(state)
    // TODO: authoritative offline cap/paused clock semantics, 3005/3006 extra
    // drops and eggs, satiety/experience settlement and exact retiming policy.
    // Current 57 farmProducts rows are supported, without inventing extra loot.
    return updated
}
