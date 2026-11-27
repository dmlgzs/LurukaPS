import { currentMapFormation, currentMapPet } from './current-map-member.js'
import { requirePetModel } from './pet-model-eligibility.js'
import { heroModules, petModules, heroBattleLimits } from './battle.js'
import { ErrorCode } from './error-codes.js'
import { ensure, GameError } from './handlers/common.js'

const uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
function guid(value) {
    const text = String(value)
    ensure(
        (typeof value !== 'number' || Number.isSafeInteger(value)) &&
            /^[1-9]\d*$/.test(text) &&
            BigInt(text) <= (1n << 64n) - 1n,
        'World player actor identity is malformed',
        ErrorCode.GameConfig,
    )
    return text
}
function formation(tables, state) {
    const selected = currentMapFormation(state),
        pets = selected.slots.map((slot, index) => {
            const pet = currentMapPet(state, slot)
            if (!pet) return null
            ensure(
                String(pet.hero_id) === String(selected.heroes[index].guid),
                'World player pet binding disagrees with its hero',
                ErrorCode.GameConfig,
            )
            requirePetModel(tables, pet)
            return pet
        })
    return { ...selected, pets }
}
export function currentWorldPlayer(tables, state, playerId, now) {
    ensure(
        uint(playerId) && playerId > 0 && Number.isSafeInteger(now * 1000) && now >= 0,
        'World player snapshot identity or clock is malformed',
        ErrorCode.GameConfig,
    )
    const { heroes, control, pets } = formation(tables, state),
        w = state.world,
        ids = heroes.map((hero) => guid(hero.guid)),
        move = { pos: { ...w.pos }, angle: w.angle, area_id: w.area_id, move_status: 1, timestamp: String(now * 1000) }
    return {
        player_id: playerId,
        move: [move],
        status: w.status ?? 0,
        // Preserve the existing field; NPC control is a separate addressed authority.
        host: true,
        name: state.player.basic_info.name,
        face: structuredClone(state.player.basic_info.wardrobe),
        group: {
            heros: ids,
            hero_mid: [...ids],
            control: guid(control.guid),
            // OtherPlayerData06029e26 indexes these parallel lists by hero slot.
            pets: pets.map((pet) => (pet ? guid(pet.guid) : '0')),
            pet_cfgid: pets.map((pet) => pet?.config_id ?? 0),
        },
        mount: w.mount,
        mount_status: w.mount_status ?? 0,
        ...(w.mount && w.mount !== '0' ? { mount_move: structuredClone(move) } : {}),
        apparel_info: structuredClone(state.player.basic_info.apparel_info),
        clothes_info: structuredClone(state.player.basic_info.clothes_info),
    }
}
export function currentWorldActorInfo(tables, original) {
    // Module builders may reconcile their own derived data. Never lend them
    // another participant's pending mutable profile to build a scene packet.
    const state = structuredClone(original),
        { heroes, pets } = formation(tables, state)
    try {
        const heroAttributes = heroes.map((hero) => heroModules(tables, state, hero)),
            attributes = [...heroAttributes],
            infos = heroes.map((hero, index) => {
                const id = guid(hero.guid),
                    rows = state.player.heros_info.battle_infos.filter((row) => String(row.hero_id) === id)
                ensure(
                    rows.length === 1,
                    'World player battle state is unavailable or duplicated',
                    ErrorCode.GameConfig,
                )
                const saved = rows[0],
                    limits = heroBattleLimits(attributes[index])
                ensure(
                    uint(saved.hp) &&
                        uint(saved.sp) &&
                        uint(saved.alive_state) &&
                        (!Object.hasOwn(saved, 'rescue_val') || uint(saved.rescue_val)),
                    'World player battle values are malformed',
                    ErrorCode.GameConfig,
                )
                return {
                    uuid: id,
                    hp: Math.min(saved.hp, limits.hp),
                    sp: Math.min(saved.sp, limits.sp),
                    alive_state: saved.alive_state,
                    ...(Object.hasOwn(saved, 'rescue_val') ? { rescue_val: saved.rescue_val } : {}),
                    reason: 1,
                }
            })
        const petSp = state.combat?.map_id === state.world.map_id ? (state.combat.petSp ?? {}) : {}
        for (const pet of pets.filter(Boolean)) {
            const id = guid(pet.guid),
                sp = petSp[id] ?? 0
            ensure(uint(sp), 'World player pet energy is malformed', ErrorCode.GameConfig)
            attributes.push(petModules(tables, state, pet, heroAttributes))
            infos.push({ uuid: id, sp, reason: 1 })
        }
        return { attributes: { heros: attributes }, battle: { infos } }
    } catch (error) {
        if (error instanceof GameError) throw error
        throw new GameError(`World player actor attributes unavailable: ${error.message}`, ErrorCode.GameConfig)
    }
}

// Current MultiPlayerService0602991a consumes the concrete hero base and the
// PetAttrInfo overload. Its legacy pet_attr field is not a substitute.
export function currentOtherPlayerInfo(tables, state, playerId, now) {
    ensure(
        (state.world.status ?? 0) !== 1,
        'Shared mounted-player appearance is not implemented',
        ErrorCode.FunctionClosed,
    )
    const selected = formation(tables, state),
        index = selected.heroes.findIndex((hero) => String(hero.guid) === String(selected.control.guid)),
        pet = selected.pets[index],
        data = currentWorldActorInfo(tables, state),
        attrs = new Map(data.attributes.heros.map((info) => [String(info.hero_guid), info])),
        battle = new Map(data.battle.infos.map((info) => [String(info.uuid), info])),
        id = guid(selected.control.guid)
    const result = {
        player_id: playerId,
        player_info: currentWorldPlayer(tables, state, playerId, now),
        hero: structuredClone(selected.control),
        hero_attr: attrs.get(id),
        hero_battle_info: battle.get(id),
    }
    if (pet) {
        ensure(uint(pet.type) && pet.type > 0, 'Appearance pet type is malformed', ErrorCode.GameConfig)
        const petId = guid(pet.guid),
            info = attrs.get(petId)
        ensure(info, 'Appearance pet attributes are unavailable', ErrorCode.GameConfig)
        result.pet_full_attr = {
            guid: petId,
            conf_id: pet.config_id,
            type: pet.type,
            level: pet.lv,
            color: pet.color ?? 0,
            special: pet.special ?? 0,
            modules: info.modules,
        }
        result.pet_base_info = structuredClone(pet)
        result.pet_battle_info = battle.get(petId)
    }
    return result
}
