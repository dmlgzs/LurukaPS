import { ensure, syncPlayer } from './handlers/common.js'
import { activateMonthlyEntitlement } from './entitlement-benefits.js'
import { grantRewards, parseRewards } from './rewards.js'
export function monthlyPayload(state, isFirst = false) {
    return {
        monthly_card_info: {
            monthly_card_endtime: String(state.monthlyCard?.end_time ?? 0),
            monthly_card_client_reward_endtime: String(state.monthlyCard?.claim_until ?? 0),
        },
        is_first: isFirst,
    }
}
export function purchaseMonthly(c, config, count) {
    return activateMonthlyEntitlement(c, config, count)
}
export function registerMonthly(on, tables) {
    const hour = Number(tables.get('game').find((x) => x.title === 'DAILY_REFRESH_TIME')?.value ?? 4)
    on('MonthlyCardReward', (c) => {
        const card = c.state.monthlyCard
        ensure(card && card.end_time > c.now, 'Monthly card is not active')
        if (card.claim_until > c.now) return { rewards: [] }
        const config = tables.find('monthly_card', card.config_id)
        ensure(config, 'Monthly card configuration missing')
        const rewards = grantRewards(c.tables, c.state, parseRewards(config.dailyReward))
        card.claim_until = (Math.floor((c.now + 8 * 3600 - hour * 3600) / 86400) + 1) * 86400 - 8 * 3600 + hour * 3600
        syncPlayer({ ...c, push: c.pushBefore })
        c.pushBefore('SCProtoMonthlyCardInfoSync', monthlyPayload(c.state))
        return { rewards }
    })
}
