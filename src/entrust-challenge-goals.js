import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { currentMapFormation } from './current-map-member.js'
const standardFamilies = new Map([
    ['entrust', 'dungeon_entrust'],
    ['material', 'dungeon_material'],
    ['weekly', 'dungeon_weekly'],
])

// Current SquadAliveCountCond0602c530 counts myPlayerData.formationHeroes
// whose live state is nonzero at DungeonSettle,not cumulative death events.
export function disabledFormationHeroCount(state) {
    const { heroes } = currentMapFormation(state)
    return heroes.reduce((count, hero) => {
        const rows = state.player.heros_info.battle_infos.filter((row) => row.hero_id === String(hero.guid))
        ensure(
            rows.length === 1 &&
                Number.isSafeInteger(rows[0].alive_state) &&
                rows[0].alive_state >= 0 &&
                rows[0].alive_state <= 0xffffffff,
            'Settlement formation hero life state is unavailable',
            ErrorCode.GameConfig,
        )
        return count + (rows[0].alive_state === 0 ? 0 : 1)
    }, 0)
}

// Current DungeonTargetComponent0602be5c consumes
// TDDungeon.GetChallengeConditionList060237d5.
// All current standard commissions/material/weekly modes read the dungeon
// list. Scene groups remain only for separate mode producers not covered here.
export function entrustChallengeGoals(tables, run, scene, dungeon) {
    const family = standardFamilies.get(run.kind ?? 'entrust')
    if (!family) {
        ensure(run.kind === 'repeat', 'Dungeon star source mode is not implemented', ErrorCode.FunctionClosed)
        return tables
            .get('common_challenge')
            .filter((row) => row.group === scene.challengeGroup && row.type === 1)
            .sort((a, b) => a.id - b.id)
    }
    ensure(tables.find(family, run.entrust_id), 'Dungeon challenge target source is unavailable', ErrorCode.GameConfig)
    ensure(
        typeof dungeon.challenge === 'string' && /^\d+(#\d+)+(\|\d+(#\d+)+)*$/.test(dungeon.challenge),
        'Dungeon challenge list is missing or malformed',
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
        ensure(
            [3006, 60007, 60010].includes(kind),
            'Commission dungeon star goal requires support',
            ErrorCode.FunctionClosed,
        )
        ensure(
            !extra.length &&
                ((kind === 3006 && a > 0 && b === undefined) ||
                    (kind === 60007 && a >= 0 && b > 0) ||
                    (kind === 60010 && a >= 0 && (b === undefined || Number.isSafeInteger(b)))),
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
