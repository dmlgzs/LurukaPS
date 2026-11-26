import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

// This reader never infers or installs a marker on an
// existing save, and never changes ownership, unlocks, progress or balances.
export function starterProfileMode(state) {
    ensure(
        state && typeof state === 'object' && !Array.isArray(state),
        'Starter profile state is invalid',
        ErrorCode.GameConfig,
    )
    if (!Object.hasOwn(state, 'starterProfile')) return 'legacy'
    const marker = state.starterProfile
    ensure(
        marker &&
            typeof marker === 'object' &&
            !Array.isArray(marker) &&
            Object.keys(marker).length === 3 &&
            Object.keys(marker).every((key) => ['schemaVersion', 'mode', 'clientVersion'].includes(key)) &&
            marker.schemaVersion === 1 &&
            marker.clientVersion === '1.0.0' &&
            ['normal', 'sandbox'].includes(marker.mode),
        'Starter profile marker is unavailable or unsupported',
        ErrorCode.GameConfig,
    )
    return marker.mode
}

// Caller must be a trusted NEW-account factory, not a login migration or a
// client-supplied mode. No open_id/name/test heuristic is accepted here.
export function newStarterProfile(mode) {
    ensure(['normal', 'sandbox'].includes(mode), 'Unknown new-account starter mode', ErrorCode.GameConfig)
    return { schemaVersion: 1, mode, clientVersion: '1.0.0' }
}

export function isNormalStarterProfile(state) {
    return starterProfileMode(state) === 'normal'
}
