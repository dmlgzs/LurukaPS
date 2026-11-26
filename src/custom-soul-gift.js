import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

export function requireCustomSoulGiftCapacity(tables, state, rewards) {
    const row = tables.get('game').find((r) => r.title === 'BAG_LIMIT_SOULESSENCE'),
        limit = Number(row?.value)
    ensure(
        Number.isSafeInteger(limit) && limit > 0,
        'Custom soul gift capacity configuration is missing',
        ErrorCode.GameConfig,
    )
    const bag = state.player.soulessence_infos?.soulessences
    ensure(Array.isArray(bag), 'Custom soul gift destination bag is malformed', ErrorCode.GameConfig)
    const amount = rewards.filter((r) => r.itemtype === 9).reduce((sum, r) => sum + r.itemnum, 0)
    ensure(
        Number.isSafeInteger(amount) && amount > 0,
        'Custom soul gift has no valid soul reward',
        ErrorCode.GameConfig,
    )
    // Current PageBattlePassSoulEssenceSelect checks this published capacity
    // before confirmation; preserve oversized historical bags, never truncate.
    ensure(bag.length + amount <= limit, 'Soul essence bag is full', ErrorCode.SoulEssenceBagFull)
}
