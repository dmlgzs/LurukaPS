import policy from '../configs/pet-catch-policy.json' with { type: 'json' }
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

// 11914 uses integer basis points; the current client displays this value /100.
// Keep the existing offline settlement policy and its information probe identical.
export function petCatchOutcome(value = policy) {
    ensure(
        value?.version === 1 &&
            value.origin === 'LOCAL' &&
            value.notOfficial === true &&
            value.probabilityUnit === 'basis-points' &&
            Number.isInteger(value.probability) &&
            value.probability >= 0 &&
            value.probability <= 10000,
        'Invalid local catch policy',
        ErrorCode.GameConfig,
    )
    // A probabilistic failure path needs authoritative inputs, failure settlement
    // and pity history. Changing only the displayed probability cannot enable it.
    ensure(
        value.strategy === 'guaranteed-success' && value.probability === 10000,
        'Probabilistic catch settlement is not implemented',
        ErrorCode.FunctionClosed,
    )
    return { probability: value.probability, success: true, randRate: value.probability / 10000 }
}

export function catchCardDefinition(tables, itemId) {
    ensure(
        Number.isInteger(itemId) && itemId > 0 && itemId <= 0xffffffff,
        'Invalid catch card identifier',
        ErrorCode.CatchParamErr,
    )
    const item = tables.find('common_item', itemId)
    ensure(item, 'Missing catch card item configuration', ErrorCode.GameConfig)
    ensure(item.type === 410, 'Item is not a catch card', ErrorCode.CatchParamErr)
    ensure(
        Number.isInteger(item.subId) && item.subId > 0,
        'Invalid catch card configuration reference',
        ErrorCode.GameConfig,
    )
    // This current table has no `id` column. TDPetCatchitem.GetData keys by type.
    const rows = tables.get('pet_catchitem').filter((row) => row.type === item.subId)
    ensure(rows.length === 1, 'Missing or ambiguous catch card type configuration', ErrorCode.GameConfig)
    return { item, config: rows[0] }
}
