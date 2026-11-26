import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { repairMountSelection, mountPayload } from './mounts.js'

const uint = (n) => Number.isInteger(n) && n > 0 && n <= 0xffffffff
const validGuid = (id) => typeof id === 'string' && /^[1-9]\d*$/.test(id) && BigInt(id) < 1n << 64n
const slots = 8 // Current mountManager.lua maxRouletteCount; vehicle and Kibo wheels are separate.

export function vehicleDefinition(tables, id) {
    const row = tables.find('vehicle', id)
    ensure(row, 'Vehicle configuration is unavailable', ErrorCode.GameConfig)
    ensure(
        uint(row.unitId) && tables.find('unit', row.unitId) && tables.find('template_value', row.baseAttributeId),
        'Vehicle model or base attributes are unavailable',
        ErrorCode.GameConfig,
    )
    return row
}

export function vehicleSnapshot(tables, state) {
    const vehicles = state.vehicles ?? []
    ensure(Array.isArray(vehicles), 'Invalid vehicle ownership state', ErrorCode.GameConfig)
    const identities = new Set(),
        definitions = new Set(),
        occupied = new Set()
    for (const vehicle of vehicles) {
        vehicleDefinition(tables, vehicle.conf_id)
        ensure(
            validGuid(vehicle.guid) &&
                BigInt(vehicle.guid) >> 56n === 32n &&
                !identities.has(vehicle.guid) &&
                !definitions.has(vehicle.conf_id) &&
                Number.isInteger(vehicle.roulette_pos) &&
                vehicle.roulette_pos >= 0 &&
                vehicle.roulette_pos <= slots &&
                (!vehicle.roulette_pos || !occupied.has(vehicle.roulette_pos)) &&
                uint(vehicle.speed),
            'Invalid vehicle ownership or roulette state',
            ErrorCode.GameConfig,
        )
        identities.add(vehicle.guid)
        definitions.add(vehicle.conf_id)
        if (vehicle.roulette_pos) occupied.add(vehicle.roulette_pos)
    }
    return {
        owned_vehicles: vehicles.map((vehicle) => ({ ...vehicle })),
    }
}

export function grantVehicle(tables, state, id) {
    vehicleDefinition(tables, id)
    const owned = vehicleSnapshot(tables, state).owned_vehicles
    if (owned.some((vehicle) => vehicle.conf_id === id)) return null
    const sequence = state.nextVehicleGuid ?? 1
    ensure(uint(sequence), 'Vehicle identity sequence is exhausted', ErrorCode.GameConfig)
    const guid = ((32n << 56n) | (BigInt(id) << 32n) | BigInt(sequence)).toString()
    ensure(!owned.some((vehicle) => vehicle.guid === guid), 'Vehicle identity collision', ErrorCode.GameConfig)
    // Local neutral ratio: the current IL stores speed but GetVehicleShowSpeed
    // uses template attribute 35 instead. No official backend speed roll is known.
    const vehicle = { guid, conf_id: id, roulette_pos: 0, speed: 10000 }
    state.vehicles = [...owned, vehicle]
    state.nextVehicleGuid = sequence + 1
    state.vehicleRevision = (state.vehicleRevision ?? 0) + 1
    return vehicle
}

export function ownedVehicle(tables, state, guid) {
    const vehicle = (state.vehicles ?? []).find((entry) => entry.guid === String(guid))
    ensure(vehicle, 'Vehicle is not owned', ErrorCode.VehicleNotOwned)
    vehicleDefinition(tables, vehicle.conf_id)
    return vehicle
}

export function vehicleBattleAttributes(tables, state) {
    return vehicleSnapshot(tables, state).owned_vehicles.map((vehicle) => {
        const row = vehicleDefinition(tables, vehicle.conf_id)
        const attrs = String(tables.find('template_value', row.baseAttributeId).baseAttribute)
            .split('|')
            .filter(Boolean)
            .map((pair) => {
                const [id, value, ...rest] = pair.split('#'),
                    attr_id = Number(id),
                    amount = Number(value)
                ensure(
                    !rest.length &&
                        uint(attr_id) &&
                        value !== undefined &&
                        value !== '' &&
                        Number.isFinite(amount) &&
                        Number.isSafeInteger(Math.trunc(amount)),
                    'Invalid vehicle base attribute',
                    ErrorCode.GameConfig,
                )
                return { attr_id, attr_val: String(Math.trunc(amount)) }
            })
        ensure(
            attrs.length && new Set(attrs.map((attr) => attr.attr_id)).size === attrs.length,
            'Duplicate or empty vehicle base attributes',
            ErrorCode.GameConfig,
        )
        // Current VehicleData.RefreshAttributes flattens module/submodule attrs.
        // Keep fixed template values in one base module, without pet growth/DNA.
        return {
            hero_guid: vehicle.guid,
            hero_conf_id: vehicle.conf_id,
            type: 32,
            modules: [
                { module_type: 0, sub_modules: [{ sub_module_id: 0, attrs: { attrs }, skills: { skills: [] } }] },
            ],
        }
    })
}

export function registerVehicles(on) {
    on('SetVehicleRoulettePos', (c, r) => {
        vehicleSnapshot(c.tables, c.state)
        const vehicle = ownedVehicle(c.tables, c.state, r.guid),
            pos = r.pos ?? 0
        ensure(
            Number.isInteger(pos) && pos > 0 && pos <= slots,
            'Invalid vehicle roulette slot',
            ErrorCode.VehicleRoulettePosLimit,
        )
        // The current edit page sends the selected occupied slot directly;
        // as with the Kibo wheel, assigning a new member replaces its occupant.
        for (const entry of c.state.vehicles ?? [])
            if (entry.guid !== vehicle.guid && entry.roulette_pos === pos) entry.roulette_pos = 0
        if (vehicle.roulette_pos !== pos) {
            vehicle.roulette_pos = pos
            c.state.vehicleRevision = (c.state.vehicleRevision ?? 0) + 1
        }
        if (repairMountSelection(c.tables, c.state))
            c.pushBefore('CSProtoRideMountInfo', mountPayload(c.tables, c.state))
        // Game publishes this revision's ownership and attributes together,
        // before ACK; do not append a second ownership-only snapshot here.
        return {}
    })
    on('RemoveVehicleRoulettePos', (c, r) => {
        vehicleSnapshot(c.tables, c.state)
        const pos = r.u32 ?? 0
        ensure(
            Number.isInteger(pos) && pos > 0 && pos <= slots,
            'Invalid vehicle roulette slot',
            ErrorCode.VehicleRoulettePosLimit,
        )
        const vehicle = (c.state.vehicles ?? []).find((entry) => entry.roulette_pos === pos)
        ensure(vehicle, 'Vehicle roulette slot is empty', ErrorCode.VehicleNotInRoulette)
        vehicle.roulette_pos = 0
        c.state.vehicleRevision = (c.state.vehicleRevision ?? 0) + 1
        if (repairMountSelection(c.tables, c.state))
            c.pushBefore('CSProtoRideMountInfo', mountPayload(c.tables, c.state))
        return {}
    })
}
