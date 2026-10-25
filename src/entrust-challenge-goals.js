import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

// CBT3 DungeonTargetComponent.GetDungeonChallenge060288c5 and the entrust
// settlement page consume TDDungeon.GetChallengeConditionList060202a2.
// Preserve existing scene groups; only normal commissions explicitly declaring
// no scene group use their own dungeon list. Other modes retain their rules.
export function entrustChallengeGoals(tables, run, scene, dungeon) {
    const goals = tables
        .get('common_challenge')
        .filter((row) => row.group === scene.challengeGroup && row.type === 1)
        .sort((a, b) => a.id - b.id)
    const normal = (run.kind === undefined || run.kind === 'entrust') && tables.find('dungeon_entrust', run.entrust_id)
    if (!normal) return goals
    if (scene.challengeGroup !== 0) {
        ensure(goals.length > 0, 'Commission scene challenge group has no star goals', ErrorCode.GameConfig)
        return goals
    }
    ensure(
        typeof dungeon.challenge === 'string' && /^\d+(#\d+)+(\|\d+(#\d+)+)*$/.test(dungeon.challenge),
        'Commission dungeon challenge list is missing or malformed',
        ErrorCode.GameConfig,
    )
    const conditions = dungeon.challenge.split('|')
    ensure(conditions.length > 0 && conditions.length <= 3, 'Invalid commission star goal count', ErrorCode.GameConfig)
    return conditions.map((condition) => {
        const [kind, a, b, ...extra] = condition.split('#').map(Number)
        ensure(
            [kind, a, ...(b === undefined ? [] : [b]), ...extra].every(Number.isSafeInteger),
            'Invalid commission star goal parameters',
            ErrorCode.GameConfig,
        )
        ensure([3006, 60007].includes(kind), 'Commission dungeon star goal requires support', ErrorCode.FunctionClosed)
        ensure(
            !extra.length && ((kind === 3006 && a > 0 && b === undefined) || (kind === 60007 && a >= 0 && b > 0)),
            'Invalid commission star goal shape',
            ErrorCode.GameConfig,
        )
        ensure(
            kind !== 60007 || a === 0,
            'Commission star goal actor selector requires support',
            ErrorCode.FunctionClosed,
        )
        return { challengeCondition: condition }
    })
}
