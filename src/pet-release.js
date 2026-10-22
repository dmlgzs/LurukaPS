import { petSoulRefunds } from './pet-star-soul.js'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { parseRewards } from './rewards.js'
function value(t, key) {
    const v = t.get('game').find((x) => x.title === key)?.value
    ensure(v !== undefined, `Missing ${key}`, ErrorCode.GameConfig)
    return v
}
export function petReleaseRewards(tables, pet) {
    const rewards = []
    let expItemCount = 0
    rewards.push(...petSoulRefunds(tables, pet))
    if (Number(value(tables, 'PET_EXPERIENCE_RETURN'))) {
        const levels = new Map(tables.get('pet_level').map((r) => [r.lv, r]))
        ensure(
            Number.isInteger(pet.lv) &&
                Number.isInteger(pet.base_lv) &&
                pet.base_lv >= 1 &&
                pet.base_lv <= pet.lv &&
                pet.lv <= levels.size,
            'Invalid pet level history',
        )
        let exp = pet.exp || 0
        for (let lv = pet.base_lv; lv < pet.lv; lv++) {
            const row = levels.get(lv)
            ensure(
                row && Number.isInteger(row.exp) && row.exp >= 0,
                'Invalid pet experience curve',
                ErrorCode.GameConfig,
            )
            exp += row.exp
        }
        let refund = Math.floor((exp * Number(value(tables, 'PET_RETURN_RATIO'))) / 10000)
        ensure(Number.isSafeInteger(refund) && refund >= 0, 'Invalid experience refund')
        const materials = String(value(tables, 'PET_EXPITEMID'))
            .split('|')
            .map(Number)
            .map((id) => {
                const n = Number(tables.find('common_item', id)?.useFunction)
                ensure(Number.isSafeInteger(n) && n > 0, 'Invalid experience material', ErrorCode.GameConfig)
                return { id, exp: n }
            })
            .sort((a, b) => b.exp - a.exp)
        for (const mat of materials) {
            const count = Math.floor(refund / mat.exp)
            if (count) {
                rewards.push({ itemtype: 3, itemid: mat.id, itemnum: count })
                expItemCount += count
                refund -= count * mat.exp
            }
        }
    }
    if (Number(value(tables, 'PET_EVOLUTION_RETURNS'))) {
        const ranks = tables.get('pet_rank')
        let id = pet.config_id,
            remaining = pet.rank || 0
        const seen = new Set()
        while (remaining-- > 0) {
            const previous = ranks.find((row) => row.nextPetId === id)
            if (!previous) break
            ensure(!seen.has(previous.petId), 'Cyclic pet evolution data', ErrorCode.GameConfig)
            seen.add(previous.petId)
            rewards.push(...parseRewards(previous.rankBreakthroughItem))
            id = previous.petId
        }
    }
    return { rewards, bonusEligible: expItemCount === 0 && !!Number(value(tables, 'PET_EXPERIENCE_RETURN')) }
}
export function releaseBonus(tables, kind, record, count) {
    const prefix = kind === 'pet' ? 'PET_FREE' : 'PET_FREEEGG',
        limit = Number(value(tables, `${prefix}_DAYLY_TIME`))
    ensure(Number.isInteger(limit) && limit >= 0, 'Invalid release reward limit', ErrorCode.GameConfig)
    const eligible =
        kind === 'pet'
            ? Math.max(0, Math.min(count, limit - record.count))
            : limit > 0 && record.count + count < limit
              ? count
              : 0
    if (!eligible) return []
    const [id, num] = String(value(tables, `${prefix}REWARD`))
        .split('|')
        .map(Number)
    ensure(
        Number.isSafeInteger(id) && id > 0 && Number.isInteger(num) && num > 0,
        'Invalid release reward',
        ErrorCode.GameConfig,
    )
    record.count += eligible
    return [{ itemtype: 3, itemid: id, itemnum: num * eligible }]
}
