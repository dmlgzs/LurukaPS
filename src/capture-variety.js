import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'

const catalogs = new WeakMap()
function successfulGuid(value) {
    if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0
    return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 0xffffffffffffffffn
}
export function capturedPetVarieties(tables, state) {
    if (!catalogs.has(tables)) {
        const rows = tables.get('pet_rank'),
            ids = new Set(rows.map((row) => row.petId))
        ensure(
            ids.size === rows.length && rows.every((row) => Number.isSafeInteger(row.petId) && row.petId > 0),
            'Invalid capture species configuration',
            ErrorCode.GameConfig,
        )
        catalogs.set(tables, ids)
    }
    const receipts = state.petCaptureResults ?? {}
    ensure(
        receipts && typeof receipts === 'object' && !Array.isArray(receipts),
        'Invalid capture species history',
        ErrorCode.GameConfig,
    )
    // petGroup is an evolution FAMILY (e.g.500297 ->500298), not one species.
    // Count actual configuration IDs from successful capture receipts only.
    // Seeded/GM/trial pets and current box size are not historical catches.
    return new Set(
        Object.values(receipts)
            .filter((row) => successfulGuid(row?.guid) && catalogs.get(tables).has(row.pet_id))
            .map((row) => row.pet_id),
    ).size
}
