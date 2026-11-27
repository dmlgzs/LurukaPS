import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { currentMapMember } from './current-map-member.js'
import { activeFormationManager, temporaryPets } from './trial-actors.js'
const uint = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff
// Current CreateCTeam060015e7 uses the current formation's control/positions;
// its public pet data explicitly carries configId/color. No owned GUID leaves.
export function teamV2MemberData(state, playerId) {
    const data = currentMapMember(state, playerId).data,
        manager = activeFormationManager(state),
        formation = manager.groups.find((g) => g.id === manager.cur_group)
    const slots = formation.heros.filter((s) => s.hero_id && String(s.hero_id) !== '0'),
        pets = [...state.pets, ...temporaryPets(state)]
    ensure(slots.length === data.group.hero_list.length, 'TeamV2 member formation changed', ErrorCode.GameConfig)
    data.group.hero_list.forEach((hero, index) => {
        const petId = String(slots[index].pet_id ?? '0')
        if (petId === '0') return
        const found = pets.filter((p) => String(p.guid) === petId)
        ensure(
            found.length === 1,
            'TeamV2 bound pet identity is unavailable',
            found.length ? ErrorCode.GameConfig : ErrorCode.PetNotExist,
        )
        const pet = found[0]
        ensure(
            uint(pet.config_id) &&
                pet.config_id > 0 &&
                uint(pet.lv) &&
                pet.lv > 0 &&
                uint(pet.color === undefined ? 0 : pet.color) &&
                uint(pet.special === undefined ? 0 : pet.special) &&
                uint(pet.colorful === undefined ? 0 : pet.colorful),
            'TeamV2 bound pet display is malformed',
            ErrorCode.GameConfig,
        )
        hero.pet = {
            pet_id: pet.config_id,
            level: pet.lv,
            color: pet.color === undefined ? 0 : pet.color,
            special: pet.special === undefined ? 0 : pet.special,
            colorful: pet.colorful === undefined ? 0 : pet.colorful,
        }
    })
    return data
}
