import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

// Fixed ranch/world-collection containers share the SCHomeSync.home_builds
// identity domain with placed and stored buildings, despite not being placeable.
export function allocateHomeGuid(home) {
    const entries = [
        ...(home.builds || []),
        ...(home.storedBuilds || []),
        ...Object.values(home.ranches || {}),
        ...Object.values(home.worldCollections || {}),
    ]
    ensure(
        entries.every((entry) => Number.isSafeInteger(entry.guid) && entry.guid > 0 && entry.guid <= 0xffffffff),
        'Invalid saved home identity',
        ErrorCode.GameConfig,
    )
    const counter = home.nextBuildGuid ?? 1
    ensure(Number.isSafeInteger(counter) && counter > 0, 'Invalid saved home identity counter', ErrorCode.GameConfig)
    const guid = Math.max(counter, entries.reduce((max, entry) => Math.max(max, entry.guid), 0) + 1)
    ensure(guid <= 0xffffffff, 'Home identity space exhausted', ErrorCode.InvalidLogic)
    home.nextBuildGuid = guid + 1
    return guid
}
