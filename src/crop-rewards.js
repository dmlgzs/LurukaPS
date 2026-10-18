import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'
import { homeCondition } from './home-grid.js'
import { cropBuffs, waterUpgradeChance } from './crop-buffs.js'

const catalogs = new WeakMap()
const ids = (value) =>
    String(value ?? '')
        .split('|')
        .filter(Boolean)
        .map(Number)
function catalog(tables) {
    if (!catalogs.has(tables))
        catalogs.set(tables, new Map(tables.get('game').map((row) => [row.title, Number(row.value)])))
    return catalogs.get(tables)
}
function draw(rng, max) {
    const n = rng(max)
    ensure(Number.isSafeInteger(n) && n >= 0 && n < max, 'Invalid crop random result', ErrorCode.InvalidLogic)
    return n
}
function row(tables, id) {
    const drop = tables.find('home_drop', id)
    ensure(drop, 'Missing crop drop configuration', ErrorCode.GameConfig)
    ensure(
        /^[1-9]\d*$/.test(String(drop.itemId)) &&
            Number.isInteger(drop.rate) &&
            drop.rate >= 0 &&
            drop.rate <= 10000 &&
            Number.isInteger(drop.minValue) &&
            Number.isInteger(drop.maxValue) &&
            drop.minValue >= 0 &&
            drop.maxValue >= drop.minValue,
        'Invalid crop drop configuration',
        ErrorCode.GameConfig,
    )
    return drop
}
function canUpgrade(tables, state, config) {
    if (!config.nextLevelSeedId || !config.harvestUpgrade || !config.homeDropNextSeedId) return false
    const next = tables.find('home_seeds', config.nextLevelSeedId)
    ensure(next, 'Missing upgraded seed configuration', ErrorCode.HomeSeedIdNotInSeedConf)
    // home_level.unlockCropUpgrade names the seed being unlocked (e.g. row3
    // at level20), so the target seed's gate applies to an upgrade into it.
    if (!next.upgradeCondition) return true
    return String(next.upgradeCondition)
        .split('|')
        .every((term) => {
            const [kind, target] = term.split('#').map(Number)
            return kind === 15017 ? (state.home.level || 1) >= target : homeCondition(term, state)
        })
}

export function cropGrowth(config, tables, state, build) {
    const phases = String(config.growParam)
        .split('|')
        .map((phase) => phase.split('#').map(Number))
    const pre = Number(String(config.preHarvestParam).split('|')[1])
    ensure(
        phases.length &&
            phases.every((phase) => phase.length === 2 && phase.every(Number.isInteger) && phase[1] > 0) &&
            Number.isInteger(pre) &&
            pre >= 0,
        'Invalid crop growth time',
        ErrorCode.GameConfig,
    )
    const base = phases.reduce((n, phase) => n + phase[1], 0)
    const reduction = tables && state ? cropBuffs(tables, state, build, config).growthReduction : 0
    const factor = Math.max(0, 10000 - reduction) / 10000
    return { grow: Math.max(1, Math.floor(base * factor)), pre: Math.max(0, Math.floor(pre * factor)) }
}

export function applyWateringUpgrade(tables, state, build, rng) {
    const config = tables.find('home_seeds', build.crop_info.seed_id)
    ensure(config, 'Missing planted crop configuration', ErrorCode.HomeSeedIdNotInSeedConf)
    const chance = waterUpgradeChance(tables, state, build, config)
    if (chance > 0 && canUpgrade(tables, state, config) && draw(rng, 10000) < Math.min(chance, 10000)) {
        build.crop_info.seed_id = config.nextLevelSeedId
        return true
    }
    return false
}

export function planCropHarvest(tables, state, seedId, fieldType, rng, { build } = {}) {
    const config = tables.find('home_seeds', seedId)
    ensure(config, 'Missing planted crop configuration', ErrorCode.HomeSeedIdNotInSeedConf)
    ensure(
        config.harvestType === 1,
        'Perennial crop harvest requires its dedicated lifecycle',
        ErrorCode.FunctionClosed,
    )
    const parameters = catalog(tables)
    const buffs = cropBuffs(tables, state, build, config)
    const fertile = fieldType === 3
    // Derived mapping, documented in crop-system-20261017.md: the first slot
    // vanishes at the highest star alongside both next-star drop columns.
    // Rates come exclusively from corpUpgrade/home_drop and field parameters.
    const weights = ids(config.corpUpgrade)
    ensure(
        weights.length === 3 &&
            weights.every((n) => Number.isInteger(n) && n >= 0) &&
            weights.reduce((n, w) => n + w, 0) === 10000,
        'Invalid crop outcome weights',
        ErrorCode.GameConfig,
    )
    if (fertile) {
        weights[0] += parameters.get('HOME_FIELD_BUFF_FERTILE_STAR') || 0
        weights[1] += parameters.get('HOME_FIELD_BUFF_FERTILE_SEED') || 0
        weights[2] = 10000 - weights[0] - weights[1]
        ensure(
            weights.every((n) => Number.isInteger(n) && n >= 0),
            'Invalid fertile crop weights',
            ErrorCode.GameConfig,
        )
    }
    if (!canUpgrade(tables, state, config)) {
        weights[2] += weights[0]
        weights[0] = 0
    }
    const pick = draw(rng, 10000)
    const branch = pick < weights[0] ? 'upgrade' : pick < weights[0] + weights[1] ? 'seed' : 'normal'
    const seedDrops =
        branch === 'upgrade' ? ids(config.homeDropNextSeedId) : branch === 'seed' ? ids(config.homeDropSeedId) : []
    let productDrops = branch === 'upgrade' ? ids(config.harvestUpgrade) : ids(config.homeDropId)
    const golden = []
    for (const id of ids(config.harvestSurprise)) {
        const drop = row(tables, id)
        const chance = Math.min(
            10000,
            drop.rate + buffs.goldenChance + (fertile ? parameters.get('HOME_FIELD_BUFF_FERTILE_SURPRISE') || 0 : 0),
        )
        if (chance > 0 && draw(rng, 10000) < chance) golden.push(id)
    }
    if (golden.length) productDrops = golden
    ensure(productDrops.length, 'Crop has no harvest reward', ErrorCode.GameConfig)
    const visual = [],
        rewards = []
    const add = (id, isProduct = false, guaranteed = false) => {
        const drop = row(tables, id)
        if (!guaranteed && drop.rate < 10000 && draw(rng, 10000) >= drop.rate) return
        let count = drop.minValue + (drop.maxValue > drop.minValue ? draw(rng, drop.maxValue - drop.minValue + 1) : 0)
        if (isProduct && fertile && count > 0) {
            const chance = parameters.get('HOME_FIELD_BUFF_FERTILE_HARVESTRATE') || 0
            const bonus = parameters.get('HOME_FIELD_BUFF_FERTILE_HARVESTNUM') || 0
            if (chance > 0 && bonus > 0 && draw(rng, 10000) < chance) count += Math.floor((count * bonus) / 10000)
        }
        if (
            isProduct &&
            buffs.extraChance > 0 &&
            buffs.extraCount > 0 &&
            draw(rng, 10000) < Math.min(10000, buffs.extraChance)
        )
            count += buffs.extraCount
        if (!count) return
        rewards.push({ itemtype: drop.itemType, itemid: Number(drop.itemId), itemnum: count })
        if (drop.dropPath) visual.push(id)
    }
    for (const id of productDrops) add(id, true, golden.includes(id))
    for (const id of seedDrops) add(id)
    const exp = golden.length ? config.harvestSurprise_exp : config.homeDropId_exp
    if (exp > 0 && !productDrops.includes(exp) && !seedDrops.includes(exp)) add(exp)
    return { version: 1, seed_id: seedId, branch, golden: !!golden.length, modifiers: buffs, rewards, drop_ids: visual }
}

export function ensureCropOutcome(tables, state, build, rng) {
    const crop = build.crop_info
    if (!crop?.seed_id || crop.state !== 2) return null
    const config = tables.find('home_seeds', crop.seed_id)
    if (config?.harvestType !== 1) return null
    const plans = (state.home.cropOutcomes ??= {})
    let plan = plans[build.guid]
    if (!plan || plan.seed_id !== crop.seed_id || plan.started !== crop.state_start_time) {
        plan = {
            ...planCropHarvest(tables, state, crop.seed_id, crop.field_type, rng, { build }),
            started: crop.state_start_time,
        }
        plans[build.guid] = plan
        state.homeRevision = (state.homeRevision || 0) + 1
    }
    crop.drop_result = { build_guid: build.guid, reward: { rewards: plan.rewards }, drop_ids: plan.drop_ids }
    return plan
}

export function prepareCropOutcomes(tables, state, rng) {
    for (const build of state.home?.builds ?? []) ensureCropOutcome(tables, state, build, rng)
}
