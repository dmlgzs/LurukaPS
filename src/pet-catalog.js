// CBT3 socket_6517 feeds record_pets into CatalogStore.rsp_syncPetCatalog.
// This is acquisition history, not the current pet bag or research progress.
export function recordPetAcquisition(tables, state, configId) {
    if (!tables.find('pet', configId)) return false
    const records = (state.recordPets ??= [])
    if (records.includes(configId)) return false
    records.push(configId)
    return true
}
export function repairPetCatalog(tables, state) {
    state.recordPets = [...new Set((state.recordPets ?? []).filter((id) => tables.find('pet', id)))]
    for (const pet of state.pets ?? []) recordPetAcquisition(tables, state, pet.config_id)
    // Existing successful capture receipts survive release; recover those too.
    for (const capture of Object.values(state.petCaptureResults ?? {}))
        recordPetAcquisition(tables, state, capture.pet_id)
}
