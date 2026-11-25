import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
const positive = (value) => uint(value) && value > 0

export function petLaborDefinitions(tables, configId) {
    const row = tables.find('pet_home_talent', configId)
    // Pets without a home profile have no configured work types.
    if (!row) return []
    ensure(
        typeof row.laborType === 'string' && typeof row.laborScoreLimit === 'string',
        'Missing pet labor definition fields',
        ErrorCode.GameConfig,
    )
    const types = row.laborType === '' ? [] : row.laborType.split('|').map(Number)
    const ranges = row.laborScoreLimit === '' ? [] : row.laborScoreLimit.split('|')
    ensure(
        types.length === ranges.length && new Set(types).size === types.length,
        'Mismatched or duplicate pet labor definitions',
        ErrorCode.GameConfig,
    )
    return types.map((laborId, index) => {
        const tokens = ranges[index].split('#'),
            [minimum, maximum] = tokens.map(Number)
        ensure(
            positive(laborId) && tables.find('home_labor_type', laborId),
            'Invalid pet labor type configuration',
            ErrorCode.GameConfig,
        )
        ensure(
            tokens.length === 2 &&
                tokens.every((token) => /^\d+$/.test(token)) &&
                positive(minimum) &&
                positive(maximum) &&
                minimum <= maximum,
            'Invalid pet initial labor score range',
            ErrorCode.GameConfig,
        )
        // Efficiency IDs are scores in the current client, not a training cap.
        const scores = new Set(
            tables
                .get('home_labor_efficiency')
                .filter((entry) => positive(entry.id) && entry.id >= minimum && entry.id <= maximum)
                .map((entry) => entry.id),
        )
        ensure(
            scores.size === maximum - minimum + 1,
            'Pet labor score has no efficiency configuration',
            ErrorCode.GameConfig,
        )
        return { laborId, minimum, maximum }
    })
}

// Explicit local policy: no official creation distribution or training ceiling
// has been recovered. Keep the deterministic range minimum and freeze training
// at that value. Never substitute a missing training table with the global max.
function requireLocalPolicy(policy) {
    ensure(
        policy?.version === 1 &&
            policy.mode === 'local' &&
            policy.userApproved === true &&
            policy.notOfficial === true &&
            policy.training === 'not-implemented' &&
            policy.officiallyVerified === false &&
            policy.initialGrade === 'configured-minimum' &&
            policy.upperGrade === 'initial-grade' &&
            policy.initialExp === 0 &&
            policy.existingRecords === 'preserve',
        'Pet labor initialization policy is unavailable',
        ErrorCode.GameConfig,
    )
}

export function initialPetLaborFromPolicy(tables, configId, policy) {
    requireLocalPolicy(policy)
    return petLaborDefinitions(tables, configId).map(({ laborId, minimum }) => ({
        labor_id: laborId,
        labor_grade: minimum,
        upper_labor_grade: minimum,
        labor_exp: policy.initialExp,
    }))
}

export function fixedPetLabor(tables, configId, text, policy) {
    requireLocalPolicy(policy)
    const definitions = petLaborDefinitions(tables, configId)
    ensure(typeof text === 'string', 'Missing customized pet labor scores', ErrorCode.GameConfig)
    const tokens = text === '' ? [] : text.split('|'),
        scores = tokens.map(Number)
    ensure(
        tokens.length === definitions.length &&
            tokens.every((token) => /^\d+$/.test(token)) &&
            scores.every((score) => positive(score) && tables.find('home_labor_efficiency', score)),
        'Invalid customized pet labor scores',
        ErrorCode.GameConfig,
    )
    return definitions.map(({ laborId }, index) => ({
        labor_id: laborId,
        labor_grade: scores[index],
        upper_labor_grade: scores[index],
        labor_exp: 0,
    }))
}
