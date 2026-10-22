import { recordNoviceCounter } from '../novice-counters.js'
import { recordActiveProgress } from '../daily-active.js'
import { ensure } from './common.js'
import { enemyDefinition } from '../enemy-state.js'
import { createPets, petData } from '../pets.js'
import { addItems, spend } from '../inventory.js'
import { retireCapturedEnemy } from './world-combat.js'

// A disconnected client cannot finish its thrown-card animation. Restore any
// unconsumed reservations before sending the next login inventory snapshot.
export function refundPendingCatchCards(state) {
    let refunded = false
    for (const card of Object.values(state.petCatchCards ?? {}))
        if (card.state === 'reserved') {
            addItems(state, [{ itemid: card.item_id, itemnum: 1 }])
            card.state = 'refunded'
            refunded = true
        }
    return refunded
}
function reserveKey(state) {
    state.petCatchCards ??= {}
    let key = state.nextCatchKey || 1
    while (state.petCatchCards[key]) {
        key++
        ensure(key <= 0xffffffff, 'Catch key space exhausted')
    }
    ensure(key <= 0xffffffff, 'Catch key space exhausted')
    state.nextCatchKey = key + 1
    return key
}

function target(c, value, preview = false) {
    const id = String(value ?? '0')
    ensure(/^\d+$/.test(id) && BigInt(id) > 0n, 'Invalid catch target')
    const enemy = enemyDefinition(c.tables, c.state, id)
    ensure(enemy, 'Target is not a catchable pet')
    const config = c.tables.find('enemy', enemy.config_id),
        pack = c.tables.find('enemy_pack', enemy.pack_id),
        petId = config?.petId
    // Aiming is an information probe, not permission to consume a catch card.
    // Known noncatchable monsters (including puzzle/challenge variants) have
    // no preview rows. Unknown entities and malformed pet configuration still fail.
    if (
        preview &&
        (pack?.uncatchableType === 1 ||
            petId === 0 ||
            (config?.petId_id === 0 && !(Number.isSafeInteger(petId) && petId > 0)))
    )
        return null
    ensure(pack?.uncatchableType !== 1, 'Pet cannot be caught')
    ensure(
        petId && c.tables.find('pet', petId) && c.tables.find('template_value', petId),
        'Target is not a catchable pet',
    )
    return { id, enemy, petId }
}
function info(c, id, petId, len = 0) {
    c.state.petCatchPreviews ??= {}
    let specimen = c.state.petCatchPreviews[id]
    if (!specimen || specimen.config_id !== petId) {
        const rolled = petData(c.tables, petId, '0', 0)
        specimen = {
            config_id: petId,
            grade: rolled.grade,
            gene_infos: rolled.gene_infos,
            comprehension: rolled.comprehension,
        }
        c.state.petCatchPreviews[id] = specimen
        const keys = Object.keys(c.state.petCatchPreviews)
        if (keys.length > 128) delete c.state.petCatchPreviews[keys[0]]
    }
    return {
        uuid: id,
        grade: specimen.grade,
        gene_size: specimen.gene_infos.length,
        gene_infos: specimen.gene_infos,
        rank: 1,
        catch_pet_times: [],
        pet_len_id: len,
        comprehension: specimen.comprehension,
    }
}
export function registerPetCatch(on) {
    on('GetCatchPetInfo', (c, r) => {
        const ids = r.tar_id ?? []
        ensure(ids.length > 0 && ids.length <= 64, 'Invalid catch target list')
        ensure(Number.isInteger(r.day_weather) && r.day_weather >= 0 && r.day_weather <= 100, 'Invalid catch weather')
        const rows = [...new Set(ids)].flatMap((id) => {
            const resolved = target(c, id, true)
            return resolved ? [info(c, resolved.id, resolved.petId, r.pet_len_id ?? 0)] : []
        })
        c.pushBefore('CSProtoSyncCatchPetInfo', { pets: rows, reason: r.reason ?? 0 })
        return {}
    })
    on('CatchPet', (c, r) => {
        const { id, petId, enemy } = target(c, r.tar_id),
            item = c.tables.find('common_item', r.item_id)
        ensure(item?.type === 410 && item.subId > 0, 'Invalid catch card')
        const past = c.state.petCaptureResults?.[id]
        if (past) {
            ensure(past.item_id === r.item_id, 'Catch card mismatch')
            return { tar_id: id, success: true, guid: past.guid, rand_rate: 1, rewards: { rewards: [] } }
        }
        const card = c.state.petCatchCards?.[r.catch_key]
        ensure(card?.state === 'reserved' && card.item_id === r.item_id, 'Catch card reservation unavailable')
        if (r.position)
            ensure(
                ['x', 'y', 'z'].every(
                    (axis) => Number.isFinite(r.position[axis]) && Math.abs(r.position[axis]) < 1000000,
                ),
                'Invalid catch position',
            )
        const pet = createPets(c.tables, c.state, petId, 1)[0]
        const preview = c.state.petCatchPreviews?.[id]
        if (preview?.config_id === petId) pet.comprehension = structuredClone(preview.comprehension)
        if (c.state.petCatchPreviews) delete c.state.petCatchPreviews[id]
        card.state = 'used'
        card.target_id = id
        recordNoviceCounter(c.state, 'captures', 1)
        if ([1, 2].includes(c.tables.find('enemy', enemy.config_id)?.enemyType))
            recordActiveProgress(c.tables, c.state, 15014, 1, c.now)
        c.state.petCaptureResults ??= {}
        c.state.petCaptureResults[id] = {
            guid: pet.guid,
            item_id: r.item_id,
            pet_id: petId,
            map_id: c.state.world.map_id,
            time: c.now,
        }
        retireCapturedEnemy(c, id)
        // The SCCatchPet success response drives CBT3's local catch result state
        // (SingleReceivePetCatch / OnRealTimeCatchResult). Single-player has no
        // server AOI despawn; SCProtoObjDisappearNtf is MultiTeam-only.
        // c.push('SCProtoObjDisappearNtf', { agent_uid: id })
        const rewards = [{ itemtype: 5, itemid: petId, itemnum: 1, guid: pet.guid }]
        return { tar_id: id, success: true, guid: pet.guid, rand_rate: 1, rewards: { rewards } }
    })
    on('CatchPetCard', (c, r) => {
        if (r.is_create) {
            const item = c.tables.find('common_item', r.item_id)
            ensure(item?.type === 410, 'Unknown catch card')
            const param = String(r.client_param ?? '0')
            const previous = Object.entries(c.state.petCatchCards ?? {}).find(
                ([, card]) => card.state === 'reserved' && card.client_param === param && param !== '0',
            )
            if (previous) {
                ensure(previous[1].item_id === r.item_id, 'Catch card request mismatch')
                return { catch_key: Number(previous[0]), item_id: r.item_id, is_create: true, client_param: param }
            }
            spend(c.state, new Map([[r.item_id, 1]]), 0, c.now)
            const key = reserveKey(c.state)
            c.state.petCatchCards[key] = {
                item_id: r.item_id,
                client_param: param,
                state: 'reserved',
                created_at: c.now,
            }
            return { catch_key: key, item_id: r.item_id, is_create: true, client_param: param }
        }
        ensure(Number.isInteger(r.catch_key) && r.catch_key > 0, 'Missing catch key')
        const card = c.state.petCatchCards?.[r.catch_key]
        ensure(card, 'Unknown catch key')
        ensure(!r.item_id || r.item_id === card.item_id, 'Catch card mismatch')
        if (card.state === 'reserved') {
            addItems(c.state, [{ itemid: card.item_id, itemnum: 1 }])
            card.state = 'refunded'
        }
        return { catch_key: r.catch_key, item_id: card.item_id, is_create: false, client_param: card.client_param }
    })
    on('CatchPetPlayOver', (c, r) => {
        const id = String(r.tar_id ?? '0')
        ensure(c.state.petCaptureResults?.[id], 'Catch target has no result')
        return { tar_id: id }
    })
}
