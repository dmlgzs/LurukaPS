// CBT3 socket_6517 feeds record_pets into CatalogStore.rsp_syncPetCatalog.
// Acquisition history is independent of the current bag. Starter gifts are
// excluded by server policy; old starter GUIDs were exactly their config ID.
export function isStarterPet(pet) {
    return String(pet.guid) === String(pet.config_id)
}
export function recordPetAcquisition(tables, state, configId) {
    if (!tables.find('pet', configId)) return false
    if (state.petCatalogVersion !== 2) repairPetCatalog(tables, state)
    const records = (state.recordPets ??= [])
    if (records.includes(configId)) return false
    records.push(configId)
    return true
}
export function repairPetCatalog(tables, state) {
    const earned = new Set((state.pets ?? []).filter((pet) => !isStarterPet(pet)).map((pet) => pet.config_id))
    for (const capture of Object.values(state.petCaptureResults ?? {})) earned.add(capture.pet_id)
    const starters = new Set((state.pets ?? []).filter(isStarterPet).map((pet) => pet.config_id))
    const records = (state.recordPets ?? []).filter(
        (id) => state.petCatalogVersion === 2 || !starters.has(id) || earned.has(id),
    )
    state.recordPets = [...new Set([...records, ...earned].filter((id) => tables.find('pet', id)))]
    state.petCatalogVersion = 2
}
