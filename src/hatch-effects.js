import appearancePolicy from '../configs/hatch-appearance-policy.json' with { type: 'json' }
import { createHash, randomInt } from 'node:crypto'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { constrainedEggPools } from './egg-pools.js'
const uint = (v) => Number.isSafeInteger(v) && v >= 0 && v <= 0xffffffff
function privateMap(state, key) {
    const value = state[key]
    ensure(
        value === undefined || (value && typeof value === 'object' && !Array.isArray(value)),
        'Invalid saved ' + key,
        ErrorCode.GameConfig,
    )
    return value ?? {}
}
export function hatchEffects(tables, egg) {
    const ids = egg.egg_affix ?? []
    ensure(
        Array.isArray(ids) && ids.every((id) => uint(id) && id > 0) && new Set(ids).size === ids.length,
        'Invalid egg affix list',
        ErrorCode.GameConfig,
    )
    ensure(
        !egg.main_parents && !egg.secondary_parents,
        'Inherited hatch generation is not yet implemented',
        ErrorCode.FunctionClosed,
    )
    const result = { flash: false, variant: false, star: false, triggered: [] },
        groups = new Set()
    for (const id of ids) {
        const row = tables.find('egg_affix', id)
        ensure(row, 'Missing egg affix configuration', ErrorCode.GameConfig)
        ensure(!row.mutexgroup || !groups.has(row.mutexgroup), 'Conflicting egg affixes', ErrorCode.GameConfig)
        groups.add(row.mutexgroup)
        ensure(
            row.type === 2 && [2, 3, 4].includes(row.affixtype) && !row.effectvalue2,
            'Affix probability/aptitude/rare generation is not yet implemented',
            ErrorCode.FunctionClosed,
        )
        result[row.affixtype === 2 ? 'variant' : row.affixtype === 3 ? 'flash' : 'star'] = true
        result.triggered.push(id)
    }
    return result
}
function variantPool(tables, id, allowAbsent = false) {
    const pet = tables.find('pet', id),
        unit = pet && tables.find('unit', pet.unitId)
    ensure(unit, 'Missing hatch pet unit', ErrorCode.GameConfig)
    const raw = unit.specialParm_id ?? unit.specialParm
    const count = !raw ? 0 : Array.isArray(raw) ? raw.length : String(raw).split('|').filter(Boolean).length
    if (!count && allowAbsent) return []
    ensure(count > 0, 'Forced variant has no configured unit model', ErrorCode.FunctionClosed)
    const listed = String(pet.petSpecial_id ?? pet.petSpecial ?? '')
        .split('|')
        .filter(Boolean)
        .map(Number)
    const rows = String(pet.petSpecialWeight_id ?? pet.petSpecialWeight ?? '')
        .split('|')
        .filter(Boolean)
        .map((token) => {
            const [id, weight, ...rest] = token.split('#').map(Number)
            ensure(
                !rest.length && uint(id) && id > 0 && id <= count && Number.isSafeInteger(weight) && weight >= 0,
                'Invalid hatch variant weight',
                ErrorCode.GameConfig,
            )
            return { id, weight }
        })
    ensure(
        listed.length > 0 &&
            listed.every((id) => uint(id) && id > 0 && id <= count) &&
            new Set(listed).size === listed.length &&
            rows.length === listed.length &&
            new Set(rows.map((r) => r.id)).size === rows.length &&
            rows.every((r) => listed.includes(r.id)),
        'Hatch variant list/weight/model mismatch',
        ErrorCode.GameConfig,
    )
    ensure(
        rows.some((row) => row.weight > 0),
        'Empty hatch variant weight pool',
        ErrorCode.GameConfig,
    )
    return rows
}
function chooseHatchWeight(rows, rng, label) {
    const total = rows.reduce((n, r) => n + r.weight, 0)
    ensure(
        Number.isSafeInteger(total) && total > 0 && total < 2 ** 48,
        'Invalid hatch ' + label + ' weight total',
        ErrorCode.GameConfig,
    )
    let value = rng(total)
    ensure(
        Number.isSafeInteger(value) && value >= 0 && value < total,
        'Invalid hatch ' + label + ' random source',
        ErrorCode.GameConfig,
    )
    for (const row of rows) {
        if (value < row.weight) return row.id
        value -= row.weight
    }
    ensure(false, 'Invalid hatch ' + label + ' draw', ErrorCode.GameConfig)
}
function palettes(tables, id, allowAbsent = false) {
    const raw = tables.find('pet', id)?.petColorParam,
        available = new Set(tables.get('pet_color').map((r) => r.starcolorId))
    if (!raw && allowAbsent) return []
    const list = String(raw ?? '')
        .split('|')
        .filter(Boolean)
        .map((s) => {
            const [id, weight, ...rest] = s.split('#').map(Number)
            ensure(
                !rest.length && uint(id) && id > 0 && available.has(id) && Number.isSafeInteger(weight) && weight > 0,
                'Invalid hatch star-color pool',
                ErrorCode.GameConfig,
            )
            return { id, weight }
        })
    ensure(
        list.length > 0 && new Set(list.map((r) => r.id)).size === list.length,
        'Missing hatch star-color pool',
        ErrorCode.GameConfig,
    )
    return list
}
export function validateHatchEffects(tables, egg, constraints, { baseEnabled = true } = {}) {
    const plan = { ...hatchEffects(tables, egg), eggId: egg.configid, baseEnabled }
    // Do not filter or reweight species to hide missing appearance resources.
    const { groups } = constrainedEggPools(tables, egg.configid, constraints)
    for (const candidate of groups.flatMap((g) => g.candidates)) {
        if (plan.variant) {
            if (!baseEnabled) legacyVariant(tables, candidate.id)
            else variantPool(tables, candidate.id)
        }
        if (plan.star) palettes(tables, candidate.id)
        if (baseEnabled) hatchAppearanceProfile(tables, egg.configid, candidate.id)
    }
    return plan
}
export function hatchAppearanceProfile(tables, eggId, petId) {
    ensure(
        ['table-special-enum', 'disabled'].includes(appearancePolicy.baseMode) &&
            ['fallback-normal', 'reject'].includes(appearancePolicy.missingAppearance),
        'Invalid hatch appearance policy',
        ErrorCode.GameConfig,
    )
    if (appearancePolicy.baseMode === 'disabled') return null
    const config = tables.find('pet_egg', eggId)
    ensure(config, 'Missing egg appearance probability', ErrorCode.EggConfNotExist)
    const parsed = String(config.petProb ?? '')
        .split('|')
        .filter(Boolean)
        .map((token) => {
            const [type, weight, ...rest] = token.split('#').map(Number)
            ensure(
                !rest.length &&
                    Number.isInteger(type) &&
                    type >= 0 &&
                    type <= 5 &&
                    Number.isSafeInteger(weight) &&
                    weight >= 0,
                'Invalid egg appearance probability row',
                ErrorCode.GameConfig,
            )
            return { type, weight }
        })
    ensure(
        parsed.length > 0 &&
            new Set(parsed.map((row) => row.type)).size === parsed.length &&
            parsed.reduce((sum, row) => sum + row.weight, 0) === 10000,
        'Invalid egg appearance probability total',
        ErrorCode.GameConfig,
    )
    const original = Array.from({ length: 6 }, (_, type) => ({
            type,
            weight: parsed.find((row) => row.type === type)?.weight ?? 0,
        })),
        effective = original.map((row) => ({ ...row })),
        transfers = []
    const variant = original.some((r) => [1, 3].includes(r.type) && r.weight > 0)
        ? variantPool(tables, petId, true).length > 0
        : true
    const star = original.some((r) => [4, 5].includes(r.type) && r.weight > 0)
        ? palettes(tables, petId, true).length > 0
        : true
    for (const row of original) {
        const reason =
            [1, 3].includes(row.type) && !variant
                ? 'missing-variant-model'
                : [4, 5].includes(row.type) && !star
                  ? 'missing-star-palette'
                  : null
        if (!reason || !row.weight) continue
        ensure(
            appearancePolicy.missingAppearance === 'fallback-normal',
            'Hatch appearance outcome has no configured resource',
            ErrorCode.FunctionClosed,
        )
        effective[row.type].weight = 0
        effective[0].weight += row.weight
        transfers.push({ from: row.type, to: 0, weight: row.weight, reason })
    }
    return {
        egg_id: eggId,
        pet_id: petId,
        policy: appearancePolicy.missingAppearance,
        original_weights: original,
        effective_weights: effective,
        transfers,
    }
}
function legacyVariant(tables, id) {
    const pet = tables.find('pet', id),
        unit = pet && tables.find('unit', pet.unitId)
    ensure(unit, 'Missing hatch pet unit', ErrorCode.GameConfig)
    const raw = unit.specialParm_id ?? unit.specialParm
    const count = !raw ? 0 : Array.isArray(raw) ? raw.length : String(raw).split('|').filter(Boolean).length
    ensure(count === 1, 'Legacy forced variant requires one unambiguous configured model', ErrorCode.FunctionClosed)
}
export function applyHatchEffects(tables, pet, plan, rng) {
    // v1 accepted seeds must retain the original number/order of appearance draws.
    if (plan.baseEnabled === false) {
        if (plan.variant) {
            legacyVariant(tables, pet.config_id)
            pet.color = 1
        }
        if (plan.star) pet.colorful = chooseHatchWeight(palettes(tables, pet.config_id), rng, 'palette')
        pet.special = plan.star ? (plan.flash ? 5 : 4) : plan.variant ? (plan.flash ? 3 : 1) : plan.flash ? 2 : 0
        return null
    }
    const profile =
        plan.eggId && plan.baseEnabled !== false ? hatchAppearanceProfile(tables, plan.eggId, pet.config_id) : null
    const rolled = profile
        ? chooseHatchWeight(
              profile.original_weights.map((row) => ({ id: row.type, weight: row.weight })),
              rng,
              'base appearance',
          )
        : 0
    const routed = profile?.transfers.some((row) => row.from === rolled) ? 0 : rolled
    const flash = plan.flash || [2, 3, 5].includes(routed)
    const star = plan.star || (!plan.variant && [4, 5].includes(routed))
    const variant = plan.variant || (!star && [1, 3].includes(routed))
    pet.color = variant ? chooseHatchWeight(variantPool(tables, pet.config_id), rng, 'variant') : 0
    pet.colorful = star ? chooseHatchWeight(palettes(tables, pet.config_id), rng, 'palette') : 0
    pet.special = star ? (flash ? 5 : 4) : variant ? (flash ? 3 : 1) : flash ? 2 : 0
    return profile
        ? {
              ...profile,
              rolled_special: rolled,
              routed_special: routed,
              final_special: pet.special,
              color: pet.color,
              colorful: pet.colorful,
          }
        : null
}
export function hatchSeed(c, eggGuid, job) {
    const saved = privateMap(c.state, 'eggGenerationSeeds')[eggGuid]
    if (saved !== undefined) {
        ensure(
            typeof saved === 'string' && /^(?:[0-9a-f]{32}|[0-9a-f]{64})$/.test(saved),
            'Invalid saved hatch seed',
            ErrorCode.GameConfig,
        )
        return saved
    }
    if (job)
        return createHash('sha256')
            .update(JSON.stringify([c.id ?? c.state.player.basic_info.id, job.guid, job.eggGuid, job.petId]))
            .digest('hex')
    return Array.from({ length: 4 }, () => {
        const n = (c.randomInt ?? randomInt)(0x100000000)
        ensure(uint(n), 'Invalid hatch seed random source', ErrorCode.GameConfig)
        return n.toString(16).padStart(8, '0')
    }).join('')
}
export function hatchRandom(seed) {
    let index = 0
    return (max) => {
        ensure(
            Number.isSafeInteger(max) && max > 0 && max < 2 ** 48,
            'Invalid hatch random range',
            ErrorCode.GameConfig,
        )
        const limit = Math.floor(2 ** 48 / max) * max
        let n
        do {
            n = createHash('sha256')
                .update(seed + ':' + index++)
                .digest()
                .readUIntBE(0, 6)
        } while (n >= limit)
        return n % max
    }
}
export function hatchReceipt(state, buildGuid, eggGuid) {
    const value = privateMap(state, 'hatchReceipts')[buildGuid + ':' + eggGuid]
    if (!value) return null
    ensure(
        value.buildGuid === buildGuid &&
            value.eggGuid === eggGuid &&
            uint(value.productGuid) &&
            value.productGuid > 0 &&
            typeof value.petGuid === 'string' &&
            /^[1-9][0-9]*$/.test(value.petGuid) &&
            uint(value.petId) &&
            Array.isArray(value.triggered) &&
            value.triggered.every((id) => uint(id) && id > 0),
        'Invalid saved hatch receipt',
        ErrorCode.GameConfig,
    )
    return value
}
export function recordHatchReceipt(state, value) {
    state.hatchReceipts = { ...privateMap(state, 'hatchReceipts'), [value.buildGuid + ':' + value.eggGuid]: value }
    const keys = Object.keys(state.hatchReceipts)
    for (const key of keys.slice(0, Math.max(0, keys.length - 256))) delete state.hatchReceipts[key]
}

export function hatchProductReceipt(state, buildGuid, productGuid) {
    for (const value of Object.values(privateMap(state, 'hatchReceipts'))) {
        ensure(value && typeof value === 'object', 'Invalid saved hatch receipt record', ErrorCode.GameConfig)
        if (value.buildGuid === buildGuid && value.productGuid === productGuid)
            return hatchReceipt(state, buildGuid, value.eggGuid)
    }
    return null
}

export function hatchGenerationVersion(state, eggGuid, starting = false) {
    const version = privateMap(state, 'eggGenerationVersions')[eggGuid]
    if (version !== undefined) {
        ensure(version === 1 || version === 2, 'Invalid hatch generation version', ErrorCode.GameConfig)
        ensure(
            version !== 2 ||
                Object.prototype.hasOwnProperty.call(privateMap(state, 'eggGenerationSeeds'), String(eggGuid)),
            'Missing v2 hatch generation seed',
            ErrorCode.GameConfig,
        )
        return version
    }
    const existing = Object.prototype.hasOwnProperty.call(privateMap(state, 'eggGenerationSeeds'), String(eggGuid))
    return starting && !existing ? 2 : 1
}
export function retainHatchSeed(c, eggGuid, job) {
    const version = hatchGenerationVersion(c.state, eggGuid, job === undefined),
        seed = hatchSeed(c, eggGuid, job)
    c.state.eggGenerationSeeds = { ...privateMap(c.state, 'eggGenerationSeeds'), [eggGuid]: seed }
    c.state.eggGenerationVersions = { ...privateMap(c.state, 'eggGenerationVersions'), [eggGuid]: version }
    return seed
}
