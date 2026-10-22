import { appearanceCatalog } from './appearance.js'
import { petSkinIds } from './pet-skins.js'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

// Cosmetic ownership has dedicated CBT3 channels; these are not bag stacks.
export function cosmeticOwnedCount(tables, state, type, id) {
    if (type === 34) {
        ensure(
            appearanceCatalog(tables).clothes.has(id),
            'Clothing configuration unavailable',
            ErrorCode.ClothesItemConfValid,
        )
        return (state.unlockedClothes ?? []).includes(id) ? 1 : 0
    }
    if (type === 39) {
        const row = appearanceCatalog(tables).skins.get(id)
        ensure(row, 'Hero clothing configuration unavailable', ErrorCode.GameConfig)
        return (state.unlockedHeroSkins?.[row.hero] ?? []).includes(id) ? 1 : 0
    }
    if (type === 37) {
        const row = tables.find('pet_skin', id)
        ensure(row, 'Pet skin configuration unavailable', ErrorCode.PetSkinConfNotExist)
        return row.isNormal === 1 || petSkinIds(tables, state).includes(id) ? 1 : 0
    }
    if (type === 40) {
        ensure(
            tables.find('home_dorm_item', id),
            'Dorm style configuration unavailable',
            ErrorCode.HomeDormFurnitureConf,
        )
        return state.home?.dorm?.back_ground_scene?.rewards?.some((r) => r.itemtype === 40 && r.itemid === id) ? 1 : 0
    }
    return null
}

export function grantAppearanceReward(tables, state, type, id) {
    ensure(type === 34 || type === 39, 'Unsupported appearance reward type', ErrorCode.FunctionClosed)
    if (cosmeticOwnedCount(tables, state, type, id)) return false
    if (type === 34) state.unlockedClothes = [...(state.unlockedClothes ?? []), id]
    else {
        const row = appearanceCatalog(tables).skins.get(id)
        // Combat reports borrow untouched fields; replace this small ownership
        // map instead of mutating a previous transaction's shared object.
        const old = state.unlockedHeroSkins ?? {}
        state.unlockedHeroSkins = { ...old, [row.hero]: [...(old[row.hero] ?? []), id] }
    }
    state.appearanceRevision = (state.appearanceRevision ?? 0) + 1
    return true
}
