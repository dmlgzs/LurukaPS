import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const positive = (value) => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff

// New quality jobs seal every serving once. Older homogeneous jobs keep their
// original rewards; loading them must not infer or reroll a newer recipe.
export function productionJobOutput(job, from, count) {
    ensure(
        Number.isSafeInteger(from) && from >= 0 && positive(count) && from + count <= job.count,
        'Invalid production output range',
        ErrorCode.GameConfig,
    )
    if (job.cookingUnits === undefined)
        return {
            rewards: job.rewards.map((reward) => {
                const itemnum = reward.itemnum * count
                ensure(positive(itemnum), 'Production output overflow', ErrorCode.GameConfig)
                return { ...reward, itemnum }
            }),
            productCounts: new Map([[job.productId, count]]),
        }
    ensure(
        job.kind === 'cook' &&
            Array.isArray(job.cookingUnits) &&
            job.cookingUnits.length === job.count &&
            job.cookingUnits.every(
                (unit) =>
                    unit &&
                    positive(unit.productId) &&
                    Number.isSafeInteger(unit.grade) &&
                    unit.grade >= 0 &&
                    Array.isArray(unit.rewards) &&
                    unit.rewards.length === 1 &&
                    unit.rewards.every(
                        (reward) => reward.itemtype === 3 && positive(reward.itemid) && reward.itemnum === 1,
                    ),
            ),
        'Malformed sealed cooking output',
        ErrorCode.GameConfig,
    )
    const rewards = [],
        productCounts = new Map()
    for (const unit of job.cookingUnits.slice(from, from + count)) {
        rewards.push(...unit.rewards.map((reward) => ({ ...reward })))
        productCounts.set(unit.productId, (productCounts.get(unit.productId) ?? 0) + 1)
    }
    return { rewards, productCounts }
}
