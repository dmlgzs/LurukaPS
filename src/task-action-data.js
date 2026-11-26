import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

// Current TaskActiveMetadata exports the concrete action under its typed
// base wrapper. dataType inside that wrapper is a numeric discriminator.
// Older explicitly-selected graph directories used an object dataType union.
export function taskActionData(action) {
    ensure(action && typeof action === 'object', 'Invalid task action', ErrorCode.GameConfig)
    const data = Object.hasOwn(action, '__type_TaskActionBaseData') ? action.__type_TaskActionBaseData : action.dataType
    ensure(
        data && typeof data === 'object' && !Array.isArray(data),
        'Invalid task action payload',
        ErrorCode.GameConfig,
    )
    return data
}

export function taskOverrideNodeIds(data, legacyField = 'field_530003') {
    const ids = Object.hasOwn(data, 'overrideNodeIds') ? data.overrideNodeIds : data[legacyField]
    if (ids === undefined) return []
    const result = Array.isArray(ids) ? ids : [ids]
    ensure(
        result.every((id) => Number.isInteger(id) && id > 0),
        'Invalid task override node IDs',
        ErrorCode.GameConfig,
    )
    return result
}
