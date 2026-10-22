import { ecologyEvent, saveEcology, syncEcologyEvent } from './ecology-progress.js'
import { WorldObjectCatalog } from './world-objects.js'
import { grantRewards } from './rewards.js'
import { rewardSource } from './reward-source.js'
import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'
const catalogs = new WeakMap()
export function claimEcologyReward(c, request) {
    const { template, event, progress } = ecologyEvent(c, request.id)
    if (progress.claimed) return { rewards: [], src: rewardSource(c.tables, 'worldEcologyReward') }
    ensure(event.status === 0, 'Ecology event is already closed', ErrorCode.WorldEcologyAlreadyGet)
    ensure(progress.ready, 'Ecology reward checkpoint is not complete', ErrorCode.WorldEcologyCannotReward)
    const ids = String(template.dropID ?? '')
        .split('|')
        .filter(Boolean)
        .map(Number)
    ensure(
        ids.length <= 512 && ids.every((id) => Number.isSafeInteger(id) && id > 0 && id <= 0xffffffff),
        'Invalid ecology reward drop IDs',
        ErrorCode.WorldInvalidEcologyTemplate,
    )
    if (!catalogs.has(c.tables)) catalogs.set(c.tables, new WorldObjectCatalog(c.tables))
    const world = catalogs.get(c.tables),
        budget = { count: 0 }
    ensure(
        ids.every((id) => world.get('drop').some((r) => r.dropId === id)),
        'Ecology reward drop group is missing',
        ErrorCode.WorldInvalidEcologyTemplate,
    )
    const configured = ids.flatMap((id) => world.drops(id, c.randomInt, budget))
    const rewards = grantRewards(c.tables, c.state, configured, 0, { randomInt: c.randomInt })
    const received = { ...event, status: 1 }
    saveEcology(c, event.id, received, { ...progress, claimed: true, claimed_at: c.now })
    // Do not remove a unit still playing post-checkpoint actions. Native
    // step0 explicitly closes it; an already closed attempt can be removed now.
    syncEcologyEvent(c, received, { remove: progress.closed === true })
    return { rewards, src: rewardSource(c.tables, 'worldEcologyReward') }
}
