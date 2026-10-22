import { changePetBoxLock } from '../pet-box-locks.js'
import { wearPetSkin } from '../pet-skins.js'

export function registerPetCosmetics(on) {
    on('PetBoxLock', changePetBoxLock)
    on('WearPetSkin', wearPetSkin)
}
