import contract from '../configs/teaching-scene-contract.json' with { type: 'json' }
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
function parts(text, separator) {
    const tokens = String(text ?? '').split(separator),
        values = tokens.map(Number)
    ensure(
        tokens.every((s) => /^(0|[1-9]\d*)$/.test(s)) &&
            values.length === 5 &&
            values.every((n) => Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff) &&
            values[1] > 0 &&
            values[4] > 0,
        'Invalid teaching scene victory configuration',
        ErrorCode.GameConfig,
    )
    ensure(values[0] === 2500, 'Teaching scene victory rule is not supported', ErrorCode.InvalidLogic)
    return values
}
export function teachingSceneVictory(tables, scene) {
    const base = parts(scene?.victoryCondition, '#')
    const blueprint = tables.find('world_blueprint', scene.blueprintId)
    ensure(!scene.blueprintId || blueprint, 'Teaching blueprint configuration is missing', ErrorCode.GameConfig)
    const path = blueprint?.path
    ensure(
        contract.schema_version === 1 && Array.isArray(contract.bindings),
        'Teaching blueprint contract is malformed',
        ErrorCode.GameConfig,
    )
    const bindings = contract.bindings.filter((b) => b.blueprintPath === path)
    ensure(bindings.length <= 1, 'Duplicate teaching blueprint contract', ErrorCode.GameConfig)
    if (!bindings.length) return base
    const binding = bindings[0]
    ensure(
        typeof binding.primaryConditionParameter === 'string' &&
            binding.primaryConditionParameter.length > 0 &&
            /^[0-9a-f]{64}$/.test(binding.sourceSha256),
        'Teaching target binding is malformed',
        ErrorCode.GameConfig,
    )
    const rows = String(scene.stringParam ?? '')
        .split('|')
        .filter((s) => s.split('#')[0] === binding.primaryConditionParameter)
    ensure(rows.length <= 1, 'Duplicate teaching primary target parameter', ErrorCode.GameConfig)
    if (!rows.length) return base
    const tokens = rows[0].split('#')
    ensure(
        tokens.length === 2 && tokens[1].length > 0,
        'Malformed teaching primary target parameter',
        ErrorCode.GameConfig,
    )
    const actual = parts(tokens[1], ',')
    ensure(
        actual.slice(0, 4).every((n, i) => n === base[i]),
        'Teaching primary target identity differs from scene',
        ErrorCode.GameConfig,
    )
    return actual
}
