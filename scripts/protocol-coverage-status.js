export const protocolCoverageStatuses = [
    'registered-local',
    'transport-core-declared',
    'request-schema-unregistered',
    'request-schema-unknown',
    'no-request-schema',
]

// A handler registration is not proof of functional completeness. Likewise,
// an absent request schema is not proof of a server-only message: preserve
// explicit uncertainty and do not infer direction from a CS/SC name prefix.
export function protocolCoverageStatus(entry, registered, declaredCore) {
    if (entry.reqUnknown === true) return 'request-schema-unknown'
    if (registered.has(entry.id)) return 'registered-local'
    if (declaredCore.has(entry.id)) return 'transport-core-declared'
    if (entry.req !== undefined) return 'request-schema-unregistered'
    return 'no-request-schema'
}
