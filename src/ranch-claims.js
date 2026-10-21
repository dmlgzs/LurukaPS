import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { grantRewards } from './rewards.js'
import fs from 'node:fs'
import { ranchCatalog } from './ranch.js'

const stackRules = new Map(
    JSON.parse(fs.readFileSync(new URL('../configs/inventory-tables/common_item.json', import.meta.url))).map((row) => [
        row.id,
        row.stackNum,
    ]),
)
export function ranchStoredSlots(stores) {
    return stores.reduce((count, item) => {
        ensure(item.itemtype === 3, 'Unsupported ranch storage item type', ErrorCode.FunctionClosed)
        const stack = stackRules.get(item.itemid)
        ensure(
            Number.isSafeInteger(stack) &&
                stack >= 0 &&
                Number.isSafeInteger(item.itemnum) &&
                item.itemnum > 0 &&
                item.itemnum <= 0xffffffff,
            'Invalid ranch storage stack configuration',
            ErrorCode.GameConfig,
        )
        return count + (stack > 0 ? Math.ceil(item.itemnum / stack) : 1)
    }, 0)
}
export function storeRanchDrop(tables, state, ranch, guid) {
    ensure(
        Number.isSafeInteger(guid) && guid > 0 && guid <= 0xffffffff,
        'Invalid ranch pickup identity',
        ErrorCode.InvalidArgument,
    )
    const drop = ranch.drops.find((drop) => drop.guid === guid)
    if (!drop && ranch.claimedRewardGuids?.includes(guid)) return false
    ensure(drop, 'Ranch drop is no longer present', ErrorCode.HomeRanchDropNotExist)
    const pet = state.pets.find((pet) => pet.guid === ranch.harvest_pet)
    ensure(
        pet?.work_status === 6 &&
            pet.work_build === ranch.block_id &&
            pet.capacity_id === ranchCatalog(tables).constants.get('HOME_PET_RANCH_HARVEST_ATTRIBUTE'),
        'Ranch has no active harvesting worker',
        ErrorCode.BuildPetAutoWorkInvalid,
    )
    const stores = ranch.stores.map((item) => ({ ...item })),
        incoming = drop.item
    ensure(
        incoming.itemtype === 3 &&
            Number.isSafeInteger(incoming.itemid) &&
            tables.find('common_item', incoming.itemid) &&
            Number.isSafeInteger(incoming.itemnum) &&
            incoming.itemnum > 0,
        'Invalid stored ranch drop',
        ErrorCode.GameConfig,
    )
    const existing = stores.find((item) => item.itemtype === incoming.itemtype && item.itemid === incoming.itemid)
    if (existing) existing.itemnum += incoming.itemnum
    else stores.push({ itemtype: incoming.itemtype, itemid: incoming.itemid, itemnum: incoming.itemnum })
    const limit = ranchCatalog(tables).levels.get(ranch.lv)?.storageLimit
    ensure(Number.isSafeInteger(limit) && limit > 0, 'Invalid ranch storage capacity', ErrorCode.GameConfig)
    ensure(ranchStoredSlots(stores) <= limit, 'Ranch storage is full', ErrorCode.BagItemFull)
    ranch.stores = stores
    ranch.drops = ranch.drops.filter((drop) => drop.guid !== guid)
    rememberRanchClaim(ranch, 'reward', guid)
    state.homeRevision = (state.homeRevision || 0) + 1
    return true
}

export function rememberRanchClaim(ranch, kind, guid) {
    const key = kind === 'egg' ? 'claimedEggGuids' : 'claimedRewardGuids'
    const ids = (ranch[key] ??= [])
    if (!ids.includes(guid)) ids.push(guid)
    // Local retry window only. IDs are monotonic and never reused, so an older
    // request outside the window fails as missing instead of paying twice.
    if (ids.length > 256) ids.splice(0, ids.length - 256)
}
function select(ranch, ids, kind) {
    ensure(
        Array.isArray(ids) &&
            ids.every((id) => Number.isSafeInteger(id) && id > 0 && id <= 0xffffffff) &&
            new Set(ids).size === ids.length,
        'Invalid ranch pickup identities',
        ErrorCode.InvalidArgument,
    )
    const eggs = kind === 'egg',
        list = eggs ? ranch.eggs : ranch.drops,
        seen = eggs ? ranch.claimedEggGuids : ranch.claimedRewardGuids
    return ids.flatMap((id) => {
        const entry = list.find((entry) => entry.guid === id)
        ensure(
            entry || seen?.includes(id),
            'Ranch pickup is no longer present',
            eggs ? ErrorCode.HomeRanchNotExistThisPetEgg : ErrorCode.HomeRanchDropNotExist,
        )
        return entry ? [entry] : []
    })
}
function transferEggs(tables, state, eggs) {
    if (!eggs.length) return
    const limit = Number(tables.get('game').find((row) => row.title === 'PET_EGG_LIMITS')?.value)
    ensure(Number.isSafeInteger(limit) && limit > 0, 'Invalid egg inventory capacity', ErrorCode.GameConfig)
    state.petEggs ??= []
    ensure(state.petEggs.length + eggs.length <= limit, 'Pet egg inventory is full', ErrorCode.EggBagNumIsMax)
    for (const egg of eggs) {
        ensure(tables.find('pet_egg', egg.configid), 'Missing ranch egg configuration', ErrorCode.EggConfNotExist)
        ensure(
            egg.hatch_state === 0 &&
                Array.isArray(egg.egg_affix) &&
                egg.egg_affix.every((id) => tables.find('egg_affix', id)),
            'Invalid saved ranch egg',
            ErrorCode.GameConfig,
        )
        ensure(
            !state.petEggs.some((other) => other.guid === egg.guid),
            'Ranch egg identity conflicts with inventory',
            ErrorCode.GameConfig,
        )
        state.petEggs.push({ ...egg, egg_affix: [...egg.egg_affix] })
        state.nextEggGuid = Math.max(state.nextEggGuid || 1, egg.guid + 1)
    }
    state.eggRevision = (state.eggRevision || 0) + 1
}
export function pickRanchDrops(tables, state, ranch, request) {
    const ids = request.reward_guids ?? [],
        eggIds = request.egg_guids ?? []
    ensure(ids.length || eggIds.length, 'No ranch pickups selected', ErrorCode.InvalidArgument)
    const drops = select(ranch, ids, 'reward'),
        eggs = select(ranch, eggIds, 'egg')
    // Both selections are validated before inventory mutation. Persisted egg
    // identity and affixes move intact; generating another egg would reroll it.
    const rewards = grantRewards(
        tables,
        state,
        drops.map((drop) => drop.item),
    )
    transferEggs(tables, state, eggs)
    for (const drop of drops) rememberRanchClaim(ranch, 'reward', drop.guid)
    for (const egg of eggs) rememberRanchClaim(ranch, 'egg', egg.guid)
    ranch.drops = ranch.drops.filter((drop) => !ids.includes(drop.guid))
    ranch.eggs = ranch.eggs.filter((egg) => !eggIds.includes(egg.guid))
    if (drops.length || eggs.length) state.homeRevision = (state.homeRevision || 0) + 1
    return rewards
}
