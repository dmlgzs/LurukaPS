import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const positive = (value) => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff

// Current commission/material rewardShow explicitly guarantees currency10.
// Its other preview tokens may be ranges/sentinels, not grantRewards syntax.
// Read only the fixed XP quote and cross-check it against the current cost rule.
export function staminaChestExperience(tables, preview, costs, shares) {
    ensure(
        typeof preview === 'string' && Array.isArray(costs) && costs.length > 0 && positive(shares),
        'Invalid stamina chest experience context',
        ErrorCode.GameConfig,
    )
    ensure(
        costs.every((row) => row && positive(row.itemtype) && positive(row.itemid) && positive(row.itemnum)),
        'Invalid stamina chest experience costs',
        ErrorCode.GameConfig,
    )
    const experience = preview
        .split('|')
        .map((token) => token.split('#').map(Number))
        .filter(([type, id]) => type === 10 && id === 10)
    ensure(
        experience.length === 1 && experience[0].length === 3 && positive(experience[0][2]),
        'Fixed stamina chest experience preview is unavailable',
        ErrorCode.GameConfig,
    )
    const constants = tables.get('game').filter((row) => row.title === 'STAMINA_EXP')
    ensure(
        constants.length === 1 && constants[0].type === 'int' && /^[1-9]\d*$/.test(constants[0].value),
        'Stamina experience rule is unavailable',
        ErrorCode.GameConfig,
    )
    const rate = Number(constants[0].value),
        paid = costs
            .filter((row) => row.itemtype === 10 && row.itemid === 3)
            .reduce((sum, row) => sum + row.itemnum, 0),
        amount = experience[0][2] * shares
    ensure(
        positive(rate) &&
            positive(paid) &&
            Number.isSafeInteger(amount) &&
            amount > 0 &&
            amount <= 0x7fffffff &&
            amount === paid * rate,
        'Stamina chest experience preview and paid cost disagree',
        ErrorCode.GameConfig,
    )
    return { itemtype: 10, itemid: 10, itemnum: amount }
}
