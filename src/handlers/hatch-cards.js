import { hatchCardSyncFields, setDefaultHatchCard, setEggHatchCard } from '../hatch-cards.js'
import { releaseFields } from '../release-ledger.js'
export function registerHatchCards(on) {
    const sync = (c) => {
        const reset = Number(c.tables.get('game').find((row) => row.title === 'DAILY_REFRESH_TIME')?.value ?? 4)
        c.pushBefore('CSProtoPetEggInfoSync', {
            ...releaseFields(c.state, 'egg', c.now, reset),
            ...hatchCardSyncFields(c.tables, c.state),
            egg_infos: { eggs: c.state.petEggs ?? [] },
        })
    }
    on('SetEggCatchCard', (c, r) => {
        setEggHatchCard(c, r.egg_guid, r.catch_card_id)
        sync(c)
        return {}
    })
    on('SetDefaultCatchCard', (c, r) => {
        setDefaultHatchCard(c, r.catch_card_id)
        sync(c)
        return {}
    })
}
