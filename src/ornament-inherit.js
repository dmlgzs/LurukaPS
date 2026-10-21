import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

export function ornamentInheritPlan(tables, state, request) {
    // The client passes its selected higher-quality candidate first and the
    // currently viewed item second. Both instances survive the quality swap.
    const candidate = state.ornaments?.find((item) => item.guid === request.target_quality_guid)
    const current = state.ornaments?.find((item) => item.guid === request.source_quality_guid)
    ensure(candidate && current, 'Ornament not owned', ErrorCode.OrnamentNotExist)
    ensure(candidate !== current, 'Select two distinct ornaments')
    ensure(candidate.id === current.id, 'Inherited ornaments must be the same item')
    ensure(tables.find('accessory', current.id), 'Ornament configuration unavailable', ErrorCode.OrnamentConfFail)
    for (const item of [current, candidate]) {
        ensure(
            Number.isSafeInteger(item.quality) && item.quality >= 0,
            'Invalid saved ornament quality',
            ErrorCode.GameConfig,
        )
        ensure(item.quality > 0, 'Ornament has no inheritable quality')
        const quality = tables.find('accessory_quality', item.quality)
        ensure(quality, 'Ornament quality configuration unavailable', ErrorCode.OrnamentConfFail)
        ensure(
            Number.isSafeInteger(quality.value) && quality.value >= 0,
            'Invalid ornament quality value',
            ErrorCode.GameConfig,
        )
    }
    ensure(candidate.quality > current.quality, 'Candidate quality must exceed current quality')
    ensure(
        (!candidate.wear_hero || candidate.wear_hero === '0') &&
            !state.player.heros_info.heros.some((hero) => hero.oguid?.includes(candidate.guid)),
        'Quality candidate is equipped',
        ErrorCode.EquipOrnament,
    )
    // isFliterLock=false in the current inheritance UI: neither instance is
    // consumed, so locked candidates and a worn receiver are valid selections.
    const cost = tables.get('game').find((row) => row.title === 'ACCESSORY_INHERIT_CURRENCY_COST')
    ensure(cost && cost.type === 'int', 'Ornament inheritance cost unavailable', ErrorCode.GameConfig)
    const gold = Number(cost.value)
    ensure(
        Number.isSafeInteger(gold) && gold >= 0 && String(cost.value).trim() !== '',
        'Invalid ornament inheritance cost',
        ErrorCode.GameConfig,
    )
    return { current, candidate, gold }
}
