import { changePetBoxLock } from '../pet-box-locks.js'

export function registerPetCosmetics(on) {
    on('PetBoxLock', changePetBoxLock)
}
