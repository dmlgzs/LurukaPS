import { preparedSystemAccess } from './system-access.js'
import policy from '../configs/pet-potential-training-policy.json' with { type: 'json' }
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { parseRewards } from './rewards.js'
import { requirePlayerOutOfBattle } from './player-battle-state.js'
import { temporaryPets } from './trial-actors.js'
import { taskResourcePlan } from './task-resource-consumption.js'

const catalogs = new WeakMap()
const uint = (x) => Number.isSafeInteger(x) && x >= 0 && x <= 0xffffffff
const positive = (x) => uint(x) && x > 0
export function validatePetPotentialPolicy(value = policy) {
    ensure(
        value?.schemaVersion === 1 &&
            value.policyId === 'pet-potential-train-current-1.0.0-v1' &&
            value.origin === 'LOCAL' &&
            value.targetVersion === '1.0.0' &&
            value.packageVersion === '3217420' &&
            value.requestType === 2 &&
            value.sampling === 'normalized-positive-current-client-table-weights-within-current-to-partner' &&
            value.officialBackendSamplingRecovered === false &&
            value.requireGuaranteedCurrentTier === true &&
            value.partialExperience === 'preserve-below-cap-zero-at-cap' &&
            value.refunds === 'current-release-preview-derived' &&
            value.colorRefunds === 'existing-world-relative-weights-per-current-color-flag' &&
            Number.isInteger(value.receiptLimit) &&
            value.receiptLimit >= 1 &&
            value.receiptLimit <= 256,
        'Malformed local potential-training policy',
        ErrorCode.GameConfig,
    )
    return value
}
validatePetPotentialPolicy()
function catalog(tables) {
    if (catalogs.has(tables)) return catalogs.get(tables)
    const attrs = new Map(),
        weights = new Map(),
        costs = new Map()
    for (const dimension of tables.get('pet_learningenum')) {
        ensure(
            positive(dimension.id) && positive(dimension.attributeEnum) && !attrs.has(dimension.attributeEnum),
            'Malformed potential attribute catalog',
            ErrorCode.PetTrainConfig,
        )
        const levels = tables
                .get('pet_talent_upgrade')
                .filter((row) => row.attrId === dimension.attributeEnum)
                .sort((a, b) => a.level - b.level),
            cap = Math.max(
                ...tables
                    .get('pet_learningtalent')
                    .filter((row) => row.enumId === dimension.id)
                    .map((row) => row.type),
            )
        ensure(
            levels.length > 0 &&
                levels.length === cap &&
                levels.every(
                    (row, index) =>
                        row.level === index + 1 &&
                        uint(row.InterA) &&
                        row.InterA === row.InterB &&
                        uint(row.nextExpVal) &&
                        (row.level === cap ? row.nextExpVal === 0 : row.nextExpVal > 0),
                ),
            'Malformed current potential value curve',
            ErrorCode.PetTrainConfig,
        )
        attrs.set(dimension.attributeEnum, levels)
    }
    ensure(attrs.size === 6, 'Current potential dimensions are incomplete', ErrorCode.PetTrainConfig)
    const caps = new Set([...attrs.values()].map((rows) => rows.length))
    ensure(caps.size === 1, 'Nonuniform potential tier catalogs are unsupported', ErrorCode.FunctionClosed)
    const cap = [...caps][0]
    for (const row of tables.get('pet_train')) {
        const key = row.petrare + ':' + row.starsoulgroupid,
            list = typeof row.weight === 'string' ? row.weight.split('|').map(Number) : []
        ensure(
            positive(row.petrare) &&
                positive(row.starsoulgroupid) &&
                row.starsoulgroupid < cap &&
                !weights.has(key) &&
                list.length === cap &&
                list.every(uint),
            'Malformed potential training weights',
            ErrorCode.PetTrainConfig,
        )
        weights.set(key, list)
    }
    for (const row of tables.get('pet_train_cost')) {
        ensure(
            positive(row.id) && !costs.has(row.id),
            'Malformed potential training cost key',
            ErrorCode.PetTrainConfig,
        )
        const parse = (text) => {
            ensure(
                typeof text === 'string' && text.length > 0,
                'Missing potential training cost',
                ErrorCode.PetTrainConfig,
            )
            const items = parseRewards(text)
            ensure(items.length > 0, 'Empty potential training cost', ErrorCode.PetTrainConfig)
            ensure(
                items.every((item) => item.itemtype === 3),
                'Potential training resource kind is unsupported',
                ErrorCode.FunctionClosed,
            )
            return items
        }
        costs.set(row.id, {
            recommended: parse(row.recommendAttributeCost),
            other: parse(row.notRecommendAttributeCost),
        })
    }
    const result = { attrs, cap, weights, costs }
    catalogs.set(tables, result)
    return result
}
export function potentialTrainingRequest(request) {
    ensure(request.type === 2, 'Unsupported potential training type', ErrorCode.PetTrainTypeErr)
    const identity = (value) => {
        ensure(
            typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 0xffffffffffffffffn,
            'Malformed potential training pet identity',
            ErrorCode.PetTrainClientParam,
        )
        return BigInt(value).toString()
    }
    const train = identity(request.train_pet),
        partner = identity(request.partner_train_pet)
    ensure(
        train !== partner && positive(request.choose_type),
        'Invalid potential training selection',
        ErrorCode.PetTrainClientParam,
    )
    return { type: 2, train_pet: train, partner_train_pet: partner, choose_type: request.choose_type }
}
export function petPotentialDistribution(tables, petrare, currentLevel, partnerLevel) {
    const model = catalog(tables)
    ensure(
        positive(petrare) &&
            positive(currentLevel) &&
            currentLevel < model.cap &&
            positive(partnerLevel) &&
            partnerLevel > currentLevel &&
            partnerLevel <= model.cap,
        'Selected potential attribute cannot be trained',
        ErrorCode.PetPetTrainCantTrainId,
    )
    const weights = model.weights.get(petrare + ':' + currentLevel)
    ensure(weights, 'Potential training weights missing', ErrorCode.PetTrainConfig)
    ensure(
        weights[currentLevel - 1] === 0,
        'Nonguaranteed potential training is not implemented',
        ErrorCode.FunctionClosed,
    )
    const outcomes = weights.flatMap((weight, index) =>
            index + 1 > currentLevel && index + 1 <= partnerLevel && weight > 0 ? [{ level: index + 1, weight }] : [],
        ),
        total = outcomes.reduce((sum, row) => sum + row.weight, 0)
    ensure(positive(total), 'Potential training outcome weights are empty', ErrorCode.PetTrainConfig)
    return { outcomes, total, cap: model.cap }
}
function currentComprehension(model, pet) {
    ensure(
        Array.isArray(pet.comprehension) && pet.comprehension.length === model.attrs.size,
        'Pet potential dimensions are incomplete',
        ErrorCode.PetComprehensionNotExist,
    )
    const rows = new Map()
    for (const row of pet.comprehension) {
        const curve = model.attrs.get(row.attr_id),
            exp = row.cur_exp ?? 0
        ensure(
            curve &&
                !rows.has(row.attr_id) &&
                positive(row.level) &&
                row.level <= curve.length &&
                uint(row.init_level) &&
                row.init_level >= 1 &&
                row.init_level <= row.level &&
                row.value === curve[row.level - 1].InterA &&
                uint(exp) &&
                (row.level === curve.length ? exp === 0 : exp < curve[row.level - 1].nextExpVal),
            'Malformed saved potential dimension',
            ErrorCode.GameConfig,
        )
        rows.set(row.attr_id, row)
    }
    return rows
}
function requireUnrestricted(tables, state, pet) {
    const suppression = pet.suppress_lv ?? 0,
        force = BigInt(state.player.attr_infos.attrs.find((row) => row.attr_id === 22)?.attr_val ?? '0')
    ensure(uint(suppression) && force >= 0n, 'Malformed pet ability restriction', ErrorCode.GameConfig)
    if (force >= BigInt(suppression)) return
    const row = tables.get('pet_level_decay').find((item) => item.lvDif === Number(BigInt(suppression) - force))
    if (!row) return // Current petItem.getPetAbilityAllAttriDecay exact missing-row behavior.
    const value =
        row[pet.original_type === 1 ? 'bossAttriDown' : pet.original_type === 2 ? 'eliteAttriDown' : 'normalAttriDown']
    ensure(uint(value), 'Malformed pet ability restriction curve', ErrorCode.GameConfig)
    ensure(value === 0, 'Pet potential training is restricted', ErrorCode.PetPetTrainCantTrainId)
}
function requireSystem(c) {
    const system = c.tables.find('system_unlock', 510)
    ensure(
        system && system.homeUnlock === 0 && typeof system.unlockCondi === 'string',
        'Potential training system configuration missing',
        ErrorCode.PetTrainConfig,
    )
    const prepared = preparedSystemAccess(c.tables, c.state, 510)
    if (prepared === undefined) {
        const parts = system.unlockCondi.split('#').map(Number)
        ensure(
            parts.length === 2 && parts[0] === 2004 && positive(parts[1]),
            'Potential training unlock condition is unsupported',
            ErrorCode.FunctionClosed,
        )
        ensure(c.state.player.basic_info.lv >= parts[1], 'Potential training system is locked', ErrorCode.SystemLock)
    } else ensure(prepared, 'Potential training system is locked', ErrorCode.SystemLock)
    requirePlayerOutOfBattle(c, 1032)
}
export function petPotentialTrainingPlan(c, rawRequest) {
    requireSystem(c)
    const request = potentialTrainingRequest(rawRequest),
        model = catalog(c.tables),
        target = c.state.pets.find((pet) => pet.guid === request.train_pet),
        partner = c.state.pets.find((pet) => pet.guid === request.partner_train_pet)
    ensure(target && partner, 'Potential training pet is not owned', ErrorCode.PetNotExist)
    ensure(
        !target.trial && !target.trail && !temporaryPets(c.state).some((pet) => pet.guid === target.guid),
        'Temporary pet cannot receive potential training',
        ErrorCode.PetPetTrainCantTrainId,
    )
    const config = c.tables.find('pet', target.config_id),
        partnerConfig = c.tables.find('pet', partner.config_id)
    ensure(config && partnerConfig, 'Potential training pet configuration missing', ErrorCode.PetConfNotExist)
    ensure(
        target.config_id === partner.config_id,
        'Potential training requires the same pet species',
        ErrorCode.PetTrainClientParam,
    )
    ensure(
        config.isSpecial !== 1 && config.petrare > 0,
        'Pet species cannot receive potential training',
        ErrorCode.PetPetTrainCantTrainId,
    )
    ensure(
        partnerConfig.isRelease === 1 && partnerConfig.isRename !== 0 && !partner.can_not_release,
        'Potential training partner cannot be consumed',
        ErrorCode.PetTrainCantDel,
    )
    requireUnrestricted(c.tables, c.state, target)
    // Reuse the existing exact instance-removal/reference protection and
    // mutation-source cancellation; rewards and release counters are separate.
    let removePartner
    try {
        removePartner = taskResourcePlan(c, [
            { item_type: 5, item_id: partner.config_id, item_count: 1, item_guid: partner.guid },
        ])
    } catch (error) {
        // Generic instance-assignment/protection failures must not expose the
        // unrelated task-delivery UI code through the training protocol.
        ensure(
            error.code !== ErrorCode.TaskSubmitItemChoseError,
            'Potential training partner cannot be consumed: ' + error.message,
            ErrorCode.PetTrainCantDel,
        )
        throw error
    }
    const targetRows = currentComprehension(model, target),
        partnerRows = currentComprehension(model, partner),
        current = targetRows.get(request.choose_type),
        higher = partnerRows.get(request.choose_type)
    ensure(current && higher, 'Unknown potential attribute enum', ErrorCode.PetPetTrainCantTrainId)
    ensure(
        current.level < model.cap && higher.level > current.level,
        'Selected potential attribute cannot be trained',
        ErrorCode.PetPetTrainCantTrainId,
    )
    const distribution = petPotentialDistribution(c.tables, config.petrare, current.level, higher.level),
        costRow = model.costs.get(config.petrare)
    ensure(costRow, 'Potential training cost row missing', ErrorCode.PetTrainConfig)
    // The current 324 legal combinations are Guaranteed. A future nonzero
    // current-tier weight has no implemented failure/partner charging policy.
    const recommendations = String(config.attrRecommend ?? '')
        .split('|')
        .filter(Boolean)
        .map(Number)
    ensure(
        recommendations.every((id) => model.attrs.has(id)),
        'Malformed pet recommended attributes',
        ErrorCode.PetTrainConfig,
    )
    const costs = new Map()
    for (const item of recommendations.slice(0, 2).includes(request.choose_type) ? costRow.recommended : costRow.other)
        costs.set(item.itemid, (costs.get(item.itemid) ?? 0) + item.itemnum)
    return {
        request,
        target,
        partner,
        current,
        costs,
        ...distribution,
        curve: model.attrs.get(request.choose_type),
        removePartner,
    }
}
export function selectPetPotentialOutcome(plan, randomInt) {
    ensure(typeof randomInt === 'function', 'Potential training random source missing', ErrorCode.GameConfig)
    let roll = randomInt(plan.total)
    ensure(
        Number.isSafeInteger(roll) && roll >= 0 && roll < plan.total,
        'Potential training random source returned an invalid sample',
        ErrorCode.GameConfig,
    )
    for (const outcome of plan.outcomes) {
        if (roll < outcome.weight) return outcome.level
        roll -= outcome.weight
    }
    ensure(false, 'Potential training random sample outside outcomes', ErrorCode.GameConfig)
}
