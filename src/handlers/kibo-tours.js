import { ErrorCode } from '../error-codes.js'
import { ensure, syncPets, syncPlayer } from './common.js'
import { maximumLevel, advanceLevel } from './progression.js'
import { grantRewards } from '../rewards.js'
import { rewardSource } from '../reward-source.js'
import { syncBattle } from '../battle.js'
import { recordActiveProgress } from '../daily-active.js'

export function registerKiboTours(on, catalog) {
    on('StartKiboTour', (c, r) => {
        const row = catalog.rows.find(row => row.id === r.activity_id)
        ensure(row, 'Kibo tour activity configuration missing', ErrorCode.NoActivityConf)
        ensure(row.type === 80, 'Activity does not support Kibo tours', ErrorCode.ActivityTypeNotEqual)
        ensure(catalog.unlocked(row, c.state), 'Kibo tour activity prerequisite is not complete', ErrorCode.ActivityConditionNone)
        const result = catalog.tours.start(c.state, catalog.entry(c.state, row.id), row, r, c.now, catalog.window(row, c.now))
        if (result.created) syncPets({ ...c, push: c.pushBefore })
        catalog.notify(c, true)
        return {}
    })
    on('KiboTourCancel', (c, r) => {
        const row = catalog.rows.find(row => row.id === r.activity_id)
        ensure(row, 'Kibo tour activity configuration missing', ErrorCode.NoActivityConf)
        ensure(row.type === 80, 'Activity does not support Kibo tours', ErrorCode.ActivityTypeNotEqual)
        const changed = catalog.tours.cancel(c.state, catalog.entry(c.state, row.id), row, r, c.now)
        if (changed) syncPets({ ...c, push: c.pushBefore })
        catalog.notify(c, true)
        return {}
    })
    on('KiboTourReward', (c, r) => {
        const row = catalog.rows.find(row => row.id === r.activity_id)
        ensure(row, 'Kibo tour activity configuration missing', ErrorCode.NoActivityConf)
        ensure(row.type === 80, 'Activity does not support Kibo tours', ErrorCode.ActivityTypeNotEqual)
        const prepared = catalog.tours.prepareReward(c.state, catalog.entry(c.state, row.id), row, r, c.now)
        if (prepared.replay) {
            catalog.notify(c, true)
            return { rewards: [] }
        }
        const levels = c.tables.get('pet_level'), cap = maximumLevel(levels, c.state.player.basic_info.lv)
        const plans = prepared.experience.map(({ pet, gain }) => {
            ensure(Number.isSafeInteger(pet.lv) && pet.lv > 0 && Number.isSafeInteger(pet.exp ?? 0) &&
                (pet.exp ?? 0) >= 0 && (pet.exp ?? 0) <= 0xffffffff,
                'Saved tour pet level or experience is malformed', ErrorCode.GameConfig)
            const result = gain > 0 && pet.lv < cap
                ? advanceLevel(levels, pet.lv, pet.exp ?? 0, gain, cap)
                : { level: pet.lv, exp: pet.exp ?? 0 }
            return { pet, pet_id: pet.guid, requested_gain: gain, before_level: pet.lv, before_exp: pet.exp ?? 0,
                after_level: result.level, after_exp: result.exp }
        })
        const rewards = grantRewards(c.tables, c.state, prepared.run.rewards)
        for (const plan of plans) {
            plan.pet.lv = plan.after_level
            plan.pet.exp = plan.after_exp
            if (plan.after_level > plan.before_level) recordActiveProgress(c.tables, c.state, 15002, 1, c.now)
        }
        if (plans.some(plan => plan.after_level !== plan.before_level || plan.after_exp !== plan.before_exp))
            c.state.petRevision = (c.state.petRevision ?? 0) + 1
        const experience = plans.map(({ pet, ...record }) => record)
        catalog.tours.finishReward(c.state, prepared, rewards, experience, c.now)
        syncPets({ ...c, push: c.pushBefore })
        syncPlayer({ ...c, push: c.pushBefore })
        syncBattle({ ...c, push: c.pushBefore })
        catalog.notify(c, true)
        return { rewards, src: rewardSource(c.tables, 'kiboTourReward') }
    })
}
