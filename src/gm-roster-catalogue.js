import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { heroData } from './player.js'
import { petData } from './pets.js'
import { heroModules, petModules, heroBattleLimits } from './battle.js'
import { permanentHeroFavorRecords } from './hero-favor-ownership.js'
import { petModelEligibility } from './pet-model-eligibility.js'
import { parsePetGuid } from './pet-guid.js'
import { lockedPetBoxes } from './pet-box-locks.js'
import { normalStarterAvatarOwnedConfigIds } from './normal-starter-avatar.js'

const catalogues = new WeakMap()
const positive = (value) => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff
const initialRandom = (minimum, maximum) => (maximum === undefined ? 0 : minimum)

function definitions(tables, name) {
    const rows = tables.get(name)
    ensure(
        Array.isArray(rows) &&
            rows.length > 0 &&
            rows.every((row) => positive(row?.id)) &&
            new Set(rows.map((row) => row.id)).size === rows.length,
        'GM roster catalogue is missing or malformed: ' + name,
        ErrorCode.GameConfig,
    )
    return [...rows].sort((a, b) => a.id - b.id)
}

export function gmRosterCatalogue(tables) {
    if (catalogues.has(tables)) return catalogues.get(tables)
    const state = {
        player: { basic_info: { id: 1, sex: 2 }, heros_info: { heros: [] }, soulessence_infos: { soulessences: [] } },
        pets: [],
        ornaments: [],
    }
    const heroes = [],
        pets = [],
        excludedHeroes = [],
        excludedPets = []
    const units = new Map(definitions(tables, 'unit').map((row) => [row.id, row]))
    for (const row of definitions(tables, 'hero')) {
        ensure([0, 1].includes(row.isUsable), 'GM hero usability is malformed', ErrorCode.GameConfig)
        if (row.isUsable !== 1) continue
        const unit = units.get(row.unitId)
        const model = Array.isArray(unit?.model)
            ? unit.model[0]
            : typeof unit?.model === 'string'
              ? unit.model.split(',')[0]
              : null
        if (!unit || typeof model !== 'string' || !model.trim() || model.includes('\0')) {
            excludedHeroes.push(Object.freeze({ id: row.id, reason: unit ? 'missing-primary-model' : 'missing-unit' }))
            continue
        }
        try {
            heroBattleLimits(heroModules(tables, state, heroData(row.id, 1)))
        } catch (error) {
            ensure(false, 'GM hero statistics are unavailable: ' + row.id + '/' + error.message, ErrorCode.GameConfig)
        }
        heroes.push(row.id)
    }
    for (const row of definitions(tables, 'pet')) {
        const status = petModelEligibility(tables, row.id)
        const reason = !status.eligible
            ? status.reason
            : !tables.find('template_value', row.id)
              ? 'missing-template'
              : null
        if (reason) {
            excludedPets.push(Object.freeze({ id: row.id, reason }))
            continue
        }
        try {
            const pet = petData(tables, row.id, '1', 101, 1001, initialRandom)
            heroBattleLimits(petModules(tables, state, pet, []))
        } catch (error) {
            ensure(false, 'GM pet statistics are malformed: ' + row.id + '/' + error.message, ErrorCode.GameConfig)
        }
        pets.push(row.id)
    }
    ensure(heroes.length > 0 && pets.length > 0, 'GM usable roster catalogue is empty', ErrorCode.GameConfig)
    const result = Object.freeze({
        heroes: Object.freeze(heroes),
        pets: Object.freeze(pets),
        excludedHeroes: Object.freeze(excludedHeroes),
        excludedPets: Object.freeze(excludedPets),
    })
    catalogues.set(tables, result)
    return result
}

export function gmHeroRewards(tables, state) {
    // This helper returns all permanent records, including the main avatar;
    // gift-recipient favor=1 qualification is deliberately not applied.
    const owned = new Set(permanentHeroFavorRecords(tables, state).map(({ actor }) => actor.conf_id))
    for (const id of normalStarterAvatarOwnedConfigIds(tables, state)) owned.add(id)
    return gmRosterCatalogue(tables)
        .heroes.filter((id) => !owned.has(id))
        .map((id) => {
            ensure(
                !state.player.heros_info.heros.some((hero) => hero.conf_id === id && !hero.trail),
                'GM hero acquisition conflicts with a nonpermanent owned record',
                ErrorCode.GameConfig,
            )
            return { itemtype: 1, itemid: id, itemnum: 1 }
        })
}

export function gmPetRewards(tables, state) {
    const owner = state.player?.basic_info?.id
    ensure(
        positive(owner) && Array.isArray(state.pets),
        'GM permanent pet ownership is malformed',
        ErrorCode.GameConfig,
    )
    const owned = new Set()
    for (const pet of state.pets) {
        if (pet.type !== 1 || pet.trail || pet.trial || pet.is_trial || pet.abyss) continue
        const identity = parsePetGuid(pet.guid)
        if ((identity.type === 2 && identity.ownerId === owner) || BigInt(identity.guid) <= 0xffffffffn)
            owned.add(pet.config_id)
    }
    const rewards = gmRosterCatalogue(tables)
        .pets.filter((id) => !owned.has(id))
        .map((id) => ({ itemtype: 5, itemid: id, itemnum: 1 }))
    if (!rewards.length) return rewards
    const boxCount = Number(tables.get('game').find((row) => row.title === 'PET_BOX_NUM')?.value)
    const boxSize = Number(tables.get('game').find((row) => row.title === 'PET_BOX_LIMIT')?.value)
    ensure(
        Number.isInteger(boxCount) && boxCount > 0 && Number.isInteger(boxSize) && boxSize > 0 && boxSize < 100,
        'Invalid pet box limits',
        ErrorCode.GameConfig,
    )
    const locked = new Set(lockedPetBoxes(tables, state)),
        used = new Set(state.pets.map((pet) => pet.box_id))
    let free = 0
    for (let box = 1; box <= boxCount; box++)
        for (let slot = 1; slot <= boxSize; slot++) if (!locked.has(box) && !used.has(box * 100 + slot)) free++
    ensure(
        state.pets.length + rewards.length <= boxCount * boxSize && free >= rewards.length,
        'Pet boxes are full for the missing GM catalogue',
        ErrorCode.BagPetFullForAdd,
    )
    return rewards
}
