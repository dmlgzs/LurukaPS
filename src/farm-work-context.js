import { gridPosition } from './home-grid.js'

export const farmWorkSlots = new Map([
    [1001, 'plant_pet'],
    [1002, 'water_pet'],
    [1003, 'harvest_pet'],
])
export function findFarmWork(tables, state, field, slot) {
    if (!field?.locate) return null
    const capacity = [...farmWorkSlots].find(([, name]) => name === slot)?.[0]
    const labor = tables.get('home_labor_capacity').find((row) => row.laborCapacityId === capacity)?.laborType
    const target = gridPosition(field.locate.anchor)
    const candidates = (state.home?.builds || []).flatMap((house) => {
        const guid = house.auto_info?.[slot],
            pet = state.pets?.find((p) => p.guid === guid)
        if (
            !guid ||
            guid === '0' ||
            !house.locate ||
            house.status !== 1 ||
            pet?.work_status !== 5 ||
            pet.work_build !== house.guid ||
            pet.capacity_id !== capacity ||
            (house.auto_info.block_id && house.auto_info.block_id !== field.locate.block_id) ||
            !pet.labor_infos?.some((info) => info.labor_id === labor && info.labor_grade > 0)
        )
            return []
        const pos = gridPosition(house.locate.anchor)
        return [{ house, pet, distance: (pos.x - target.x) ** 2 + (pos.y - target.y) ** 2 }]
    })
    return candidates.sort((a, b) => a.distance - b.distance || a.house.guid - b.house.guid)[0] || null
}
