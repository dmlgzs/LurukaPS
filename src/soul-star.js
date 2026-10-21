import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

export function planSoulStar(tables, state, request) {
    const all = state.player.soulessence_infos.soulessences
    const target = all.find((item) => item.guid === request.guid)
    ensure(target, 'Soul essence is not owned', ErrorCode.SoulEssenceNotExist)
    ensure(!target.zombie, 'Preview soul essence cannot be refined', ErrorCode.SoulEssenceComCostEmpty)
    const config = tables.find('soulessence', target.id)
    ensure(config, 'Soul essence configuration unavailable', ErrorCode.SoulEssenceConfNotExist)
    const maximum = Number(tables.get('game').find((row) => row.title === 'SOULESSENCE_MAX_GRADE')?.value)
    ensure(
        Number.isInteger(maximum) &&
            maximum > 0 &&
            Number.isInteger(target.advance) &&
            target.advance >= 1 &&
            target.advance <= maximum,
        'Invalid soul essence star configuration or state',
        ErrorCode.GameConfig,
    )
    ensure(target.advance < maximum, 'Soul essence star cap reached', ErrorCode.SoulEssenceStartMax)
    // Current ProceedStarUpRequest uses cost_items and guids. Unlocks happen
    // through 6048 first. Legacy flags need separate evidence, never bypass locks.
    ensure(
        !request.item_num && !request.use_unlock,
        'Legacy soul star parameters not implemented',
        ErrorCode.FunctionClosed,
    )
    const guids = request.guids ?? [],
        items = request.cost_items ?? []
    ensure(guids.length <= 100 && items.length <= 100, 'Too many soul refinement materials')
    const consumed = new Set(),
        costs = new Map()
    let contribution = 0
    for (const guid of guids) {
        ensure(guid !== target.guid && !consumed.has(guid), 'Duplicate or self soul refinement material')
        const item = all.find((item) => item.guid === guid)
        ensure(item, 'Soul refinement material not owned', ErrorCode.SoulEssenceCostNotEnough)
        ensure(item.id === target.id, 'Refinement requires a same-name soul essence', ErrorCode.SoulEssenceIdErr)
        ensure(!item.zombie, 'Preview soul essence cannot be consumed', ErrorCode.SoulEssenceComCostEmpty)
        ensure(!item.lock, 'Soul refinement material is locked', ErrorCode.SoulEssenceCostLock)
        ensure(
            (!item.wear_hero || item.wear_hero === '0') &&
                !state.player.heros_info.heros.some((hero) => hero.wguid === guid),
            'Soul refinement material is equipped',
            ErrorCode.WearSoulEssence,
        )
        ensure(
            Number.isInteger(item.advance) && item.advance >= 1 && item.advance <= maximum,
            'Invalid soul refinement material stars',
            ErrorCode.GameConfig,
        )
        // Native GetSelectItemStarContribution uses the complete one-based
        // advance value, so a previously refined copy contributes all its copies.
        contribution += item.advance
        consumed.add(guid)
    }
    for (const line of items) {
        ensure(config.gradeItem > 0, 'Soul essence has no configured star material', ErrorCode.SoulEssenceStarNotItem)
        ensure(
            line.id === config.gradeItem,
            'Star material does not match this soul essence',
            ErrorCode.SoulEssenceAdvCostSame,
        )
        ensure(
            tables.find('common_item', line.id),
            'Soul star material configuration unavailable',
            ErrorCode.GameConfig,
        )
        ensure(Number.isInteger(line.num) && line.num > 0, 'Invalid soul star material count')
        const total = (costs.get(line.id) ?? 0) + line.num
        ensure(Number.isSafeInteger(total) && total <= 0xffffffff, 'Soul star material count overflow')
        costs.set(line.id, total)
        contribution += line.num
    }
    ensure(
        Number.isSafeInteger(contribution) && contribution > 0,
        'No soul star materials selected',
        ErrorCode.SoulEssenceAdvNoCost,
    )
    const advance = Math.min(maximum, target.advance + contribution)
    ensure(
        tables.get('soulessence_grade').some((row) => row.soulessenceId === target.id && row.grade === advance - 1),
        'Soul refinement skill tier unavailable',
        ErrorCode.GameConfig,
    )
    // The current UI explicitly confirms over-cap/strengthened material loss.
    // No refund formula was found; cap the result and track this local policy
    // in the evidence/TODO rather than inventing a compensation reward.
    return { target, advance, costs, consumed, surplus: target.advance + contribution - advance }
}
