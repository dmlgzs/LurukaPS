import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'
import { findFarmWork } from './farm-work-context.js'

function matches(row, crop) {
    const terms = String(row.buffCondition || '')
        .split('|')
        .filter(Boolean)
        .map((text) => text.split('#').map(Number))
    if (!terms.length) return true
    // These crop talents list alternative cropType values under one key.
    if (terms.every(([kind]) => kind === 1021)) return terms.some(([, type]) => type === crop.cropType)
    return false // Do not apply unknown condition semantics to a crop.
}
function values(tables, rows, crop, id) {
    const result = [0, 0]
    for (const row of rows) {
        if (!matches(row, crop)) continue
        const ids = String(row.buffId || '')
                .split('|')
                .map(Number),
            params = String(row.buffParams || '').split('|')
        ids.forEach((value, index) => {
            if (value !== id) return
            const config = tables.find('home_buff', id)
            ensure(config, 'Missing crop buff configuration', ErrorCode.GameConfig)
            ensure(
                config.type === 2 && config.algorithmType === 3,
                'Unsupported crop buff algorithm',
                ErrorCode.FunctionClosed,
            )
            ensure(typeof params[index] === 'string', 'Missing crop buff parameters', ErrorCode.GameConfig)
            const pair = params[index].split('#').map(Number)
            ensure(
                pair.length <= 2 && pair.every((n) => Number.isSafeInteger(n) && n >= 0),
                'Invalid crop buff parameters',
                ErrorCode.GameConfig,
            )
            result[0] += pair[0]
            result[1] += pair[1] || 0
        })
    }
    return result
}
function talents(tables, state, build, slot) {
    const worker = findFarmWork(tables, state, build, slot)
    return (worker?.pet.talent_id || [])
        .map((id) => tables.get('home_talent').find((row) => row.talentId === id))
        .filter(Boolean)
}
export function cropBuffs(tables, state, build, crop) {
    const rows = tables
        .get('home_technology')
        .filter((row) => state.home?.technology?.levels[row.type]?.level === row.level)
    const harvest = talents(tables, state, build, 'harvest_pet')
    const extra = values(tables, rows, crop, 1049)
    return {
        growthReduction: values(tables, rows, crop, 1048)[0],
        extraChance: extra[0],
        extraCount: extra[1],
        goldenChance: values(tables, harvest, crop, 1041)[0],
    }
}
export function waterUpgradeChance(tables, state, build, crop) {
    return values(tables, talents(tables, state, build, 'water_pet'), crop, 1040)[0]
}
