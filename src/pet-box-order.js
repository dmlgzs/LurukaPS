import policy from '../configs/pet-box-order-policy.json' with { type: 'json' }
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { lockedPetBoxes, petBoxCount } from './pet-box-locks.js'
import { petGrade } from './pets.js'
import { temporaryPets } from './trial-actors.js'
function limits(tables) {
    const boxes = petBoxCount(tables),
        size = Number(tables.get('game').find((r) => r.title === 'PET_BOX_LIMIT')?.value)
    ensure(
        Number.isInteger(size) && size > 0 && size < 100 && boxes <= Math.floor(0xffffffff / 100),
        'Invalid pet box capacity',
        ErrorCode.GameConfig,
    )
    return { boxes, size }
}
function persistentPets(state, boxes, size) {
    const temporary = new Set(temporaryPets(state).map((p) => p.guid)),
        occupied = new Set()
    return state.pets.filter((pet) => {
        let kind
        try {
            kind = Number(BigInt(pet.guid) >> 56n)
        } catch {
            ensure(false, 'Invalid saved pet GUID', ErrorCode.GameConfig)
        }
        if (kind === 9 || temporary.has(pet.guid)) return false
        // Carried actors without a physical box slot must not be packed into one.
        if (!pet.box_id && pet.hero_id && pet.hero_id !== '0') return false
        const box = Math.floor(pet.box_id / 100),
            slot = pet.box_id % 100
        ensure(
            Number.isInteger(pet.box_id) &&
                box >= 1 &&
                box <= boxes &&
                slot >= 1 &&
                slot <= size &&
                !occupied.has(pet.box_id),
            'Invalid/overlapping saved pet box position',
            ErrorCode.GameConfig,
        )
        occupied.add(pet.box_id)
        return true
    })
}
function values(tables, pet, rules) {
    const config = tables.find('pet', pet.config_id)
    ensure(config, 'Missing pet configuration', ErrorCode.PetConfNotExist)
    return rules.map((rule) => {
        // Native PetItem.getPetGrade/GetPetGradeNew consume the wire grade.
        // Reuse the existing server scorer only for old saves lacking that field.
        const value =
            rule === 1
                ? (pet.grade ?? petGrade(tables, pet))
                : rule === 2
                  ? pet.lv
                  : rule === 3
                    ? Number(String(config.element).split('|')[0])
                    : config.petStage
        ensure(Number.isFinite(value) && value >= 0, 'Invalid pet sorting value', ErrorCode.GameConfig)
        return value
    })
}
export function orderPetBoxes(c, r) {
    ensure(
        ['ascending', 'descending'].includes(policy.sequentialDirection) &&
            policy.allScope === 'unlocked-boxes' &&
            policy.tieBreak === 'original-position',
        'Invalid local pet box ordering policy',
        ErrorCode.GameConfig,
    )
    const { boxes, size } = limits(c.tables),
        all = r.is_all ?? false,
        rules = r.order_id ?? []
    ensure(
        all || (Number.isInteger(r.box) && r.box >= 1 && r.box <= boxes),
        'Pet box does not exist',
        ErrorCode.PetBoxNotExist,
    )
    ensure(
        Array.isArray(rules) &&
            rules.length > 0 &&
            rules.length <= 4 &&
            rules.every((id) => [1, 2, 3, 4].includes(id)) &&
            new Set(rules).size === rules.length,
        'Invalid pet box sorting priorities',
        ErrorCode.InvalidArgument,
    )
    const locked = new Set(lockedPetBoxes(c.tables, c.state))
    ensure(all || !locked.has(r.box), 'Pet box is locked and cannot be sorted', ErrorCode.PetBoxAlreadlyLock)
    const included = new Set(
        Array.from({ length: boxes }, (_, i) => i + 1).filter((box) => !locked.has(box) && (all || box === r.box)),
    )
    const pets = persistentPets(c.state, boxes, size).filter((pet) => included.has(Math.floor(pet.box_id / 100)))
    const sign = (r.is_seq_order ?? false) === (policy.sequentialDirection === 'ascending') ? 1 : -1
    const sorted = pets
        .map((pet) => ({ pet, values: values(c.tables, pet, rules) }))
        .sort((a, b) => {
            for (let i = 0; i < rules.length; i++) {
                const cmp = a.values[i] - b.values[i]
                if (cmp) return cmp * sign
            }
            return a.pet.box_id - b.pet.box_id
        })
    const slots = []
    for (const box of included) for (let slot = 1; slot <= size; slot++) slots.push(box * 100 + slot)
    ensure(sorted.length <= slots.length, 'Pet box capacity exceeded', ErrorCode.GameConfig)
    let changed = false
    sorted.forEach(({ pet }, i) => {
        if (pet.box_id !== slots[i]) {
            pet.box_id = slots[i]
            changed = true
        }
    })
    if (changed) c.state.petRevision = (c.state.petRevision ?? 0) + 1
    return {}
}
export function registerPetBoxOrder(on) {
    on('OrderPetBoxInfo', orderPetBoxes)
}
