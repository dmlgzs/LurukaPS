import defaults from '../configs/gacha-probability-models.json' with { type: 'json' }
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const uint = (value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff
// This is the user's selected, configurable model, not an independently
// verified official curve. The ordinary masses/hard counts remain table data.
export function bindGachaProbabilityModel(config, rules, scale, settings = defaults) {
    ensure(
        settings?.schema_version === 1 && Array.isArray(settings.profiles),
        'Invalid gacha probability model settings',
        ErrorCode.GameConfig,
    )
    const types = new Set(),
        ids = new Set()
    for (const row of settings.profiles) {
        ensure(
            row &&
                typeof row.id === 'string' &&
                row.id.length > 0 &&
                !ids.has(row.id) &&
                Array.isArray(row.gacha_types) &&
                row.gacha_types.length > 0 &&
                row.gacha_types.every((type) => uint(type) && type > 0 && !types.has(type)) &&
                new Set(row.gacha_types).size === row.gacha_types.length &&
                [
                    row.expected_scale,
                    row.expected_base_mass,
                    row.expected_hard_pity,
                    row.soft_start_after,
                    row.increment_mass,
                ].every(uint) &&
                row.expected_scale > 0 &&
                row.expected_base_mass > 0 &&
                row.increment_mass > 0 &&
                row.soft_start_after + 1 < row.expected_hard_pity,
            'Malformed or ambiguous gacha probability profile',
            ErrorCode.GameConfig,
        )
        ids.add(row.id)
        row.gacha_types.forEach((type) => types.add(type))
    }
    const profile = settings.profiles.find((row) => row.gacha_types.includes(config.gachaType))
    if (!profile) return null
    const top = rules.filter((rule) => rule.minimum === 4 && rule.probability_mass > 0)
    ensure(top.length === 1, 'Gacha probability profile requires one five-star guarantee', ErrorCode.GameConfig)
    const rule = top[0]
    ensure(
        scale === profile.expected_scale &&
            rule.isRepeatable === 1 &&
            [1, 2].includes(rule.guaranteeType) &&
            rule.probability_mass === profile.expected_base_mass &&
            rule.guaranteeCount === profile.expected_hard_pity,
        'Gacha probability profile does not match its table guarantee',
        ErrorCode.GameConfig,
    )
    const maximumExtra = (rule.guaranteeCount - 1 - profile.soft_start_after) * profile.increment_mass
    ensure(
        Number.isSafeInteger(maximumExtra) && maximumExtra <= rules.at(-1).probability_mass,
        'Gacha soft probability exhausts the ordinary remainder',
        ErrorCode.GameConfig,
    )
    return {
        id: profile.id,
        rule_id: rule.guaranteeId,
        base_mass: rule.probability_mass,
        hard_pity: rule.guaranteeCount,
        soft_start_after: profile.soft_start_after,
        increment_mass: profile.increment_mass,
        scale,
    }
}

export function gachaRulesForDraw(model, entry) {
    const profile = model.probabilityModel
    if (!profile) return model.rules
    ensure(Array.isArray(entry?.pity), 'Invalid saved gacha probability ledger', ErrorCode.GameConfig)
    const count = entry.pity.find((row) => row.pity_id === profile.rule_id)?.pity_count
    ensure(uint(count), 'Invalid saved gacha probability count', ErrorCode.GameConfig)
    const draw = count + 1,
        hard = draw >= profile.hard_pity
    const extra = Math.max(0, draw - profile.soft_start_after) * profile.increment_mass
    const top = hard ? model.scale : profile.base_mass + extra
    let threshold = 0
    return model.rules.map((rule, index) => {
        const mass = hard
            ? rule.guaranteeId === profile.rule_id
                ? model.scale
                : 0
            : rule.guaranteeId === profile.rule_id
              ? top
              : index === model.rules.length - 1
                ? rule.probability_mass - extra
                : rule.probability_mass
        ensure(
            Number.isSafeInteger(mass) && mass >= 0 && threshold + mass <= model.scale,
            'Invalid gacha draw probability mass',
            ErrorCode.GameConfig,
        )
        threshold += mass
        const fixed = rule.guaranteeCount === 1 && !rule.isRepeatable && rule.probability_base === model.scale
        return { ...rule, probability_mass: mass, probability_threshold: fixed ? 0 : threshold }
    })
}
