import { catchCardDefinition } from './pet-catch-policy.js'
import { spend } from './inventory.js'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
export function hatchCardSyncFields(tables, state) {
    const id = state.hatchDefaultCatchCardId ?? 0
    ensure(uint(id), 'Malformed saved default hatch card', ErrorCode.GameConfig)
    if (id) {
        ensure(
            tables.find('common_item', id)?.type === 410,
            'Saved default hatch card is not a configured card',
            ErrorCode.GameConfig,
        )
        hatchCardDefinition(tables, id)
    }
    return { default_catch_card_id: id }
}
function savedEggCard(tables, egg) {
    const id = egg.catch_card_id ?? 0
    ensure(uint(id), 'Malformed saved egg hatch card', ErrorCode.GameConfig)
    if (id) {
        ensure(
            tables.find('common_item', id)?.type === 410,
            'Saved egg hatch card is not a configured card',
            ErrorCode.GameConfig,
        )
        hatchCardDefinition(tables, id)
    }
    return id
}
function stock(state, id, now) {
    return state.player.sbag_infos.items
        .filter((row) => row.itemid === id && (!row.deadtime || row.deadtime > now))
        .reduce((n, row) => n + row.itemnum, 0)
}
export function hatchCardDefinition(tables, id) {
    const row = catchCardDefinition(tables, id)
    ensure(
        Number.isInteger(row.config.StarColorProb) &&
            row.config.StarColorProb >= 0 &&
            row.config.StarColorProb <= 10000 &&
            typeof row.config.StarColorParam === 'string' &&
            typeof row.config.colorParam === 'string',
        'Malformed hatch card appearance configuration',
        ErrorCode.GameConfig,
    )
    return row
}
function compatible(tables, egg, card) {
    const ids = egg.egg_affix ?? []
    ensure(
        Array.isArray(ids) && ids.every((id) => uint(id) && id > 0),
        'Malformed hatch egg affixes',
        ErrorCode.GameConfig,
    )
    if (card.config.StarColorProb === 10000) {
        const guaranteed = ids.some((id) => {
            const affix = tables.find('egg_affix', id)
            ensure(affix, 'Missing egg affix configuration', ErrorCode.GameConfig)
            return affix.type === 2 && [4, 6].includes(affix.affixtype)
        })
        ensure(!guaranteed, 'Guaranteed star-color egg cannot use a star-color card', ErrorCode.StarColrCardUnMatched)
    }
}
export function setDefaultHatchCard(c, id) {
    hatchCardDefinition(c.tables, id)
    if (hatchCardSyncFields(c.tables, c.state).default_catch_card_id === id) return false
    ensure(stock(c.state, id, c.now) > 0, 'Hatch card is not owned', ErrorCode.ItemNotEnough)
    c.state.hatchDefaultCatchCardId = id
    return true
}
export function setEggHatchCard(c, eggGuid, id) {
    ensure(uint(eggGuid) && eggGuid > 0, 'Invalid egg identity', ErrorCode.InvalidArgument)
    const egg = (c.state.petEggs ?? []).find((row) => row.guid === eggGuid)
    ensure(egg, 'Pet egg not owned', ErrorCode.EggNotExist)
    const card = hatchCardDefinition(c.tables, id)
    compatible(c.tables, egg, card)
    ensure(!egg.lock_state, 'Pet egg is locked', ErrorCode.EggIsLock)
    ensure(uint(egg.hatch_state ?? 0) && (egg.hatch_state ?? 0) <= 3, 'Malformed hatch state', ErrorCode.GameConfig)
    if (savedEggCard(c.tables, egg) === id) return false
    ensure(egg.hatch_state !== 3, 'Egg has already finished hatching', ErrorCode.PetEggHatchStateFinish)
    ensure(
        !egg.hatch_state && !egg.hatch_build_guid,
        'Egg is already assigned to incubation',
        ErrorCode.PetEggHatchStateIn,
    )
    ensure(stock(c.state, id, c.now) > 0, 'Hatch card is not owned', ErrorCode.ItemNotEnough)
    egg.catch_card_id = id
    return true
}
function receipts(state) {
    const value = state.hatchCardReceipts
    ensure(
        value === undefined || (value && typeof value === 'object' && !Array.isArray(value)),
        'Malformed hatch card receipts',
        ErrorCode.GameConfig,
    )
    return value ?? {}
}
export function reserveHatchCard(c, egg, buildGuid, productGuid) {
    const id = savedEggCard(c.tables, egg) || hatchCardSyncFields(c.tables, c.state).default_catch_card_id,
        card = hatchCardDefinition(c.tables, id)
    compatible(c.tables, egg, card)
    ensure(
        card.config.StarColorProb === 0 && card.config.StarColorParam === '' && card.config.colorParam === '',
        'Special hatch card settlement is not recovered',
        ErrorCode.FunctionClosed,
    )
    const key = buildGuid + ':' + productGuid,
        previous = receipts(c.state)[key]
    ensure(!previous, 'Hatch card product identity is already used', ErrorCode.GameConfig)
    spend(c.state, new Map([[id, 1]]), 0, c.now)
    const value = {
        version: 1,
        build_guid: buildGuid,
        product_guid: productGuid,
        egg_guid: egg.guid,
        item_id: id,
        consumed_at: c.now,
        status: 'queued',
    }
    c.state.hatchCardReceipts = { ...receipts(c.state), [key]: value }
    egg.catch_card_id = id
    return { version: 1, item_id: id, receipt_key: key }
}
export function completeHatchCard(state, job, pet, buildGuid) {
    if (job.hatch_card === undefined) {
        // Explicit previous accepted-job contract; a marked current job cannot
        // silently fall back after losing its payment binding.
        ensure(job.hatch_card_version === undefined, 'Current hatch job lost its payment binding', ErrorCode.GameConfig)
        return null
    }
    ensure(job.hatch_card_version === 1, 'Invalid hatch card job contract', ErrorCode.GameConfig)
    const binding = job.hatch_card
    ensure(
        binding &&
            binding.version === 1 &&
            uint(binding.item_id) &&
            binding.item_id > 0 &&
            typeof binding.receipt_key === 'string',
        'Malformed saved hatch card binding',
        ErrorCode.GameConfig,
    )
    const record = receipts(state)[binding.receipt_key]
    ensure(
        record &&
            record.version === 1 &&
            uint(record.consumed_at) &&
            record.build_guid === buildGuid &&
            binding.receipt_key === record.build_guid + ':' + record.product_guid &&
            record.product_guid === job.guid &&
            record.egg_guid === job.eggGuid &&
            record.item_id === binding.item_id &&
            record.status === 'queued',
        'Hatch card payment receipt mismatch',
        ErrorCode.GameConfig,
    )
    if (pet) {
        pet.catch_item = binding.item_id
        record.status = 'claimed'
        record.pet_guid = pet.guid
    } else record.status = 'cancelled'
    return { ...record }
}
