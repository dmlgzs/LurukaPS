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
function variantCount(tables, id) {
    const pet = tables.find('pet', id),
        unit = pet && tables.find('unit', pet.unitId)
    ensure(unit, 'Missing hatch pet unit', ErrorCode.GameConfig)
    const raw = unit.specialParm_id ?? unit.specialParm
    return !raw ? 0 : Array.isArray(raw) ? raw.length : String(raw).split('|').filter(Boolean).length
}
function palettes(tables, id) {
    const raw = tables.find('pet', id)?.petColorParam,
        available = new Set(tables.get('pet_color').map((r) => r.starcolorId))
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
export function validateHatchEffects(tables, egg, constraints) {
    const plan = hatchEffects(tables, egg)
    if (!plan.variant && !plan.star) return plan
    // Do not filter or reweight species to hide missing appearance resources.
    const { groups } = constrainedEggPools(tables, egg.configid, constraints)
    for (const candidate of groups.flatMap((g) => g.candidates)) {
        if (plan.variant)
            ensure(
                variantCount(tables, candidate.id) === 1,
                'Forced variant requires one unambiguous configured model',
                ErrorCode.FunctionClosed,
            )
        if (plan.star) palettes(tables, candidate.id)
    }
    return plan
}
export function applyHatchEffects(tables, pet, plan, rng) {
    if (plan.variant) {
        ensure(
            variantCount(tables, pet.config_id) === 1,
            'Forced variant requires one unambiguous configured model',
            ErrorCode.FunctionClosed,
        )
        pet.color = 1
    }
    if (plan.star) {
        const rows = palettes(tables, pet.config_id),
            total = rows.reduce((n, r) => n + r.weight, 0)
        ensure(
            Number.isSafeInteger(total) && total > 0 && total < 2 ** 48,
            'Invalid hatch palette weight total',
            ErrorCode.GameConfig,
        )
        let value = rng(total)
        ensure(
            Number.isSafeInteger(value) && value >= 0 && value < total,
            'Invalid hatch palette random source',
            ErrorCode.GameConfig,
        )
        for (const row of rows) {
            if (value < row.weight) {
                pet.colorful = row.id
                break
            }
            value -= row.weight
        }
        ensure(availablePalette(tables, pet.colorful), 'Hatch palette draw failed', ErrorCode.GameConfig)
    }
    // Actual PetSpecialType enum: normal0/color1/flash2/flashColor3/star4/flashStar5.
    pet.special = plan.star ? (plan.flash ? 5 : 4) : plan.variant ? (plan.flash ? 3 : 1) : plan.flash ? 2 : 0
}
function availablePalette(tables, id) {
    return tables.get('pet_color').some((r) => r.starcolorId === id)
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

export function retainHatchSeed(c, eggGuid, job) {
    const seed = hatchSeed(c, eggGuid, job)
    c.state.eggGenerationSeeds = { ...privateMap(c.state, 'eggGenerationSeeds'), [eggGuid]: seed }
    return seed
}
