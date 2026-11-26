import { readTable } from './table-source.js'
import { ErrorCode } from './error-codes.js'
import { recordPetAcquisition } from './pet-catalog.js'
import { randomInt } from 'node:crypto'
import { initialPetSkills } from './skills.js'
import { ensure } from './handlers/common.js'
import { pairs } from './battle.js'
import { initialPetComprehension, repairPetComprehension } from './pet-comprehension.js'
import { randomMountSpeed } from './mounts.js'
import { refreshPetCaressPeriod } from './pet-caress.js'
import { lockedPetBoxes } from './pet-box-locks.js'
import { initialPetSatiety } from './pet-initial-satiety.js'
import { petStarSoulAllocationFloor } from './pet-star-soul-progress.js'
import { requirePetModel } from './pet-model-eligibility.js'
import { initialPetLaborFromPolicy, fixedPetLabor } from './pet-labor.js'
import laborPolicy from '../configs/pet-labor-policy.json' with { type: 'json' }

// Scores and localized fields come from the same validated versioned export.
const petScores = new Map(readTable('pet').map((row) => [row.id, row.gradeScore]))
const fixedPetFactors = new Set([1, 3, 4, 5, 201, 229, 230])
const skillIdsByTables = new WeakMap()
function validGeneSkills(tables) {
    let ids = skillIdsByTables.get(tables)
    if (!ids) {
        ids = new Set(
            tables
                .get('skill_level')
                .filter((row) => row.level === 1)
                .map((row) => row.skillId),
        )
        skillIdsByTables.set(tables, ids)
    }
    return ids
}
function candidates(tables, text, rarity) {
    const ids = String(text || '')
            .split('|')
            .filter(Boolean)
            .map(Number),
        selected = []
    for (let i = 0; i < ids.length;) {
        const first = tables.find('pet_dna', ids[i])
        if (!first) {
            i++
            continue
        }
        const variants = [ids[i]]
        if (
            first.rarity === 3 &&
            ids.length >= i + 3 &&
            [4, 5].every((r, j) => tables.find('pet_dna', ids[i + j + 1])?.rarity === r)
        )
            variants.push(ids[i + 1], ids[i + 2])
        const preferred = variants[Math.min(variants.length - 1, Math.max(0, rarity - 3))]
        if (validGeneSkills(tables).has(preferred) && tables.find('skill', preferred)) selected.push(preferred)
        i += variants.length
    }
    return selected
}
export function initialPetGenes(tables, config) {
    const max = Number(tables.get('game').find((row) => row.title === 'PET_DNA_MAX_NUM')?.value) || 8
    const rarity = Number(config.petrare) || 3
    const talent = candidates(tables, config.petTalentDna, rarity),
        recommended = candidates(tables, config.dnaRecommend, rarity)
    return [...new Set([...talent, ...recommended])]
        .slice(0, max)
        .map((gene_id, index) => ({ pos: index + 1, gene_id, gene_lv: 1 }))
}
export function initialPetLabor(tables, configId) {
    return initialPetLaborFromPolicy(tables, configId, laborPolicy)
}
export function initialPetTalents(tables, configId) {
    const row = tables.find('pet_home_talent', configId)
    if (!row) return []
    const groups = String(row.talentGroupId || '')
        .split('|')
        .filter(Boolean)
        .map((token) => Number(token.split('#')[0]))
    return [...new Set(groups)]
        .slice(0, 3)
        .map(
            (group) =>
                tables.get('home_talent').find((t) => t.talentGroupId === group && t.talentLevel === 1)?.talentId,
        )
        .filter(Boolean)
}
export function petGrade(tables, pet) {
    const config = tables.find('pet', pet.config_id)
    if (!config) return 1
    const base = pairs(tables.find('template_value', config.id)?.baseAttribute)
    const growth = pairs(tables.find('template_value', 5001000 + (pet.lv || 1))?.baseAttribute)
    const values = new Map()
    for (const [id, value] of base)
        if (growth.has(id)) values.set(id, (value * growth.get(id)) / (fixedPetFactors.has(id) ? 10000 : 1))
    let score = Number(petScores.get(config.id)) || 0
    const game = tables.get('game'),
        coefficients = pairs(game.find((row) => row.title === 'PET_GRADE_ATTR_SCORE')?.value)
    const ratios = new Set(
        tables
            .get('battle_info')
            .filter((row) => row.isRatio > 0)
            .map((row) => row.attrVal),
    )
    for (const [id, weight] of coefficients) {
        let value = values.get(id) || 0
        if (ratios.has(id)) value /= 10000
        if (id === 8) value = Math.max(0, value - 1)
        score += (value * weight) / 10000
    }
    const elementWeight = Number(game.find((row) => row.title === 'PET_GRADE_ATTR_ELE_SCORE')?.value) || 0
    const elementIds = String(game.find((row) => row.title === 'PET_GRADE_ATTR_ELE_BATTLEINFO_ID')?.value || '')
        .split('|')
        .map(Number)
    for (const id of elementIds) {
        let value = values.get(id) || 0
        if (ratios.has(id)) value /= 10000
        score += (value * elementWeight) / 10000
    }
    for (const gene of pet.gene_infos || []) score += Number(tables.find('pet_dna', gene.gene_id)?.gradeScore) || 0
    const minimum = Number(game.find((row) => row.title === 'PET_GRADE_SCORE_MIN')?.value) || 1
    return Math.min(99999, Math.max(minimum, Math.floor(score)))
}
export function repairPetProfiles(tables, state, now) {
    let changed = false
    for (const pet of state.pets) {
        const config = tables.find('pet', pet.config_id)
        if (!config) continue
        if (ensurePetName(tables, pet, config)) changed = true
        if (now !== undefined && refreshPetCaressPeriod(tables, state, pet, now)) changed = true
        // PetDuelStore.getPetName indexes by PetItem:isSpecialPet(), which returns
        // this numeric color field directly. An omitted normal color becomes nil.
        if (!Number.isInteger(pet.color)) {
            pet.color = 0
            changed = true
        }
        if (repairPetComprehension(tables, pet)) changed = true
        if (!Array.isArray(pet.gene_infos) || pet.gene_infos.length === 0) {
            const genes = initialPetGenes(tables, config)
            if (!Array.isArray(pet.gene_infos) || genes.length) {
                pet.gene_infos = genes
                changed = true
            }
        }
        const unlocked = Math.ceil(Math.max(0, ...pet.gene_infos.map((g) => g.pos)) / 2)
        if (!Number.isInteger(pet.gene_state) || pet.gene_state < unlocked) {
            pet.gene_state = unlocked
            changed = true
        }
        if (!Number.isInteger(pet.grade) || pet.grade <= 0) {
            pet.grade = petGrade(tables, pet)
            changed = true
        }
        if (!Array.isArray(pet.labor_infos)) {
            pet.labor_infos = initialPetLabor(tables, pet.config_id)
            changed = true
        }
        if (!Array.isArray(pet.talent_id)) {
            pet.talent_id = initialPetTalents(tables, pet.config_id)
            changed = true
        }
        if (tables.find('mount', pet.config_id) && (!Number.isInteger(pet.speed) || pet.speed <= 0)) {
            pet.speed = randomMountSpeed(tables)
            changed = true
        }
    }
    if (changed) state.petRevision = (state.petRevision || 0) + 1
    return changed
}
export function ensurePetName(tables, pet, config = tables.find('pet', pet.config_id)) {
    if (pet.pet_name) return false
    ensure(config, 'Missing pet name configuration', ErrorCode.PetConfNotExist)
    ensure(typeof config.name === 'string' && config.name.trim(), 'Missing pet name', ErrorCode.GameConfig)
    pet.pet_name = Buffer.from(config.name, 'utf8').toString('base64')
    return true
}
export function petData(tables, configId, guid, box, builderRuleId = 1001, rng = randomInt, context = {}) {
    const config = tables.find('pet', configId)
    ensure(config && tables.find('template_value', configId), 'Missing pet configuration', ErrorCode.PetConfNotExist)
    const pet = {
        guid: String(guid),
        pet_name: Buffer.from(config.name, 'utf8').toString('base64'),
        config_id: configId,
        feature: 1,
        color: 0,
        comprehension: initialPetComprehension(tables, builderRuleId, rng),
        inherent_skills: initialPetSkills(config),
        lv: 1,
        rank: 1,
        exp: 0,
        base_lv: 1,
        favor_lv: 1,
        favor_val: 0,
        is_lock: true,
        box_id: box,
        type: 1,
        satiety_val: initialPetSatiety(tables, configId, context),
        hero_id: '0',
        roulette_pos: 0,
    }
    if (tables.find('mount', configId)) pet.speed = randomMountSpeed(tables, rng)
    pet.gene_infos = initialPetGenes(tables, config)
    pet.gene_state = Math.ceil(pet.gene_infos.length / 2)
    pet.grade = petGrade(tables, pet)
    pet.labor_infos = initialPetLabor(tables, configId)
    pet.talent_id = initialPetTalents(tables, configId)
    return pet
}
function allocatePets(tables, state, configId, count, factory) {
    requirePetModel(tables, { config_id: configId })
    const boxCount = Number(tables.get('game').find((r) => r.title === 'PET_BOX_NUM')?.value),
        boxSize = Number(tables.get('game').find((r) => r.title === 'PET_BOX_LIMIT')?.value)
    ensure(
        Number.isInteger(boxCount) && boxCount > 0 && Number.isInteger(boxSize) && boxSize > 0 && boxSize < 100,
        'Invalid pet box limits',
        ErrorCode.GameConfig,
    )
    ensure(Number.isInteger(count) && count > 0, 'Invalid pet creation count')
    ensure(state.pets.length + count <= boxCount * boxSize, 'Pet boxes are full', ErrorCode.BagPetFullForAdd)
    const used = new Set(state.pets.map((p) => p.box_id)),
        locked = new Set(lockedPetBoxes(tables, state)),
        slots = []
    for (let box = 1; box <= boxCount; box++)
        for (let slot = 1; slot <= boxSize; slot++) {
            const id = box * 100 + slot
            if (!locked.has(box) && !used.has(id)) slots.push(id)
        }
    ensure(slots.length >= count, 'No free unlocked pet slot', ErrorCode.BagPetFullForAdd)
    let sequence = state.nextPetSequence ?? 1
    ensure(Number.isSafeInteger(sequence) && sequence > 0, 'Invalid saved pet allocation counter', ErrorCode.GameConfig)
    sequence = Math.max(sequence, petStarSoulAllocationFloor(tables, state))
    for (const pet of state.pets) {
        const id = BigInt(pet.guid)
        if (id >> 56n === 2n) sequence = Math.max(sequence, Number(id & 0xffffffffn) + 1)
    }
    ensure(
        Number.isSafeInteger(sequence) && sequence + count - 1 <= 0xffffffff,
        'Pet identity space exhausted',
        ErrorCode.GameConfig,
    )
    const created = []
    for (let i = 0; i < count; i++) {
        const guid = ((2n << 56n) | (BigInt(configId) << 32n) | BigInt(sequence++)).toString()
        const pet = factory(guid, slots[i])
        created.push(pet)
        const box = Math.floor(slots[i] / 100)
        if (!state.petBoxes.some((b) => b.id === box))
            state.petBoxes.push({ id: box, box_name: Buffer.from(`奇波小屋${box}`).toString('base64') })
    }
    state.pets.push(...created)
    recordPetAcquisition(tables, state, configId)
    state.nextPetSequence = sequence
    state.petRevision = (state.petRevision || 0) + 1
    return created
}
export function createPets(tables, state, configId, count, builderRuleId = 1001, rng = undefined) {
    return allocatePets(tables, state, configId, count, (guid, box) =>
        petData(tables, configId, guid, box, builderRuleId, rng),
    )
}
// A wild specimen has already been rolled and published. Allocation must not
// roll another pet (including invisible labor/mount data) and then overwrite it.
export function createPetFromSpecimen(tables, state, specimen) {
    ensure(
        specimen && typeof specimen === 'object' && !Array.isArray(specimen),
        'Invalid catch specimen',
        ErrorCode.GameConfig,
    )
    const profile = structuredClone(specimen),
        attributes = tables.get('pet_learningenum').map((row) => row.attributeEnum),
        comprehension = profile.comprehension,
        genes = profile.gene_infos,
        maxGenes = Number(tables.get('game').find((row) => row.title === 'PET_DNA_MAX_NUM')?.value)
    ensure(
        Number.isSafeInteger(profile.config_id) &&
            profile.config_id > 0 &&
            Array.isArray(comprehension) &&
            comprehension.length === attributes.length &&
            new Set(comprehension.map((row) => row.attr_id)).size === attributes.length &&
            attributes.every((id) =>
                comprehension.some(
                    (row) =>
                        row.attr_id === id &&
                        Number.isSafeInteger(row.level) &&
                        row.level >= 1 &&
                        row.level <= 9 &&
                        Number.isSafeInteger(row.value) &&
                        row.value >= 0,
                ),
            ) &&
            Array.isArray(genes) &&
            Number.isSafeInteger(maxGenes) &&
            maxGenes > 0 &&
            genes.length <= maxGenes &&
            new Set(genes.map((gene) => gene.pos)).size === genes.length &&
            genes.every(
                (gene) =>
                    Number.isSafeInteger(gene.pos) &&
                    gene.pos >= 1 &&
                    gene.pos <= maxGenes &&
                    Number.isSafeInteger(gene.gene_lv) &&
                    gene.gene_lv > 0 &&
                    tables.find('pet_dna', gene.gene_id) &&
                    tables.find('skill', gene.gene_id),
            ) &&
            profile.grade === petGrade(tables, profile),
        'Invalid published catch specimen attributes',
        ErrorCode.GameConfig,
    )
    return allocatePets(tables, state, profile.config_id, 1, (guid, box_id) => ({ ...profile, guid, box_id }))[0]
}
export function customizedPetRewardDefinition(tables, customizedId) {
    const config = tables.find('pet_customized', customizedId)
    ensure(
        config &&
            tables.find('pet', config.petId) &&
            tables.find('template_value', config.petId) &&
            tables.find('pet_builder_rule', config.builderRule || 1001) &&
            Number.isInteger(config.level) &&
            config.level > 0 &&
            config.skillType === 0 &&
            config.skillCountType === 0 &&
            [0, 1].includes(config.talentDnaType) &&
            [0, 1].includes(config.dnaType),
        'Unsupported customized pet configuration',
        ErrorCode.GameConfig,
    )
    const levels = new Map(
        String(config.petAttr || '')
            .split('|')
            .filter(Boolean)
            .map((token) => token.split('#').map(Number)),
    )
    const attributes = tables.get('pet_learningenum').map((row) => row.attributeEnum)
    ensure(
        levels.size === attributes.length && attributes.every((id) => Number.isInteger(levels.get(id))),
        'Invalid customized pet aptitudes',
        ErrorCode.GameConfig,
    )
    const upgrades = tables.get('pet_talent_upgrade')
    const comprehensionRows = attributes.map((attr_id) => {
        const level = levels.get(attr_id),
            row = upgrades.find((x) => x.attrId === attr_id && x.level === level)
        ensure(
            row && Number.isInteger(row.InterA) && Number.isInteger(row.InterB) && row.InterA <= row.InterB,
            'Invalid customized pet aptitude value',
            ErrorCode.GameConfig,
        )
        return { attr_id, level, minimum: row.InterA, maximum: row.InterB }
    })
    const fixedGenes = [
        ...(config.talentDnaType === 1 ? [config.talentDna] : []),
        ...(config.dnaType === 1
            ? String(config.dna || '')
                  .split('|')
                  .filter(Boolean)
                  .map(Number)
            : []),
    ]
    const maxGenes = Number(tables.get('game').find((row) => row.title === 'PET_DNA_MAX_NUM')?.value) || 8
    ensure(
        new Set(fixedGenes).size === fixedGenes.length &&
            fixedGenes.length <= maxGenes &&
            fixedGenes.every((id) => Number.isInteger(id) && tables.find('pet_dna', id) && tables.find('skill', id)),
        'Invalid customized pet genes',
        ErrorCode.GameConfig,
    )
    ensure(
        [config.laborScoreType, config.mountType].every(
            (mode) => Number.isSafeInteger(mode) && mode >= 0 && mode <= 0xffffffff,
        ),
        'Malformed customized pet labor or mount mode',
        ErrorCode.GameConfig,
    )
    ensure(
        [0, 1].includes(config.laborScoreType) && [0, 1].includes(config.mountType),
        'Customized pet labor or mount mode is not implemented',
        ErrorCode.InvalidProtoID,
    )
    let labor
    if (config.laborScoreType === 1) {
        labor = fixedPetLabor(tables, config.petId, config.laborScore, laborPolicy)
    }
    if (config.mountType === 1)
        ensure(
            Number.isSafeInteger(config.mountSpeed) && config.mountSpeed > 0 && config.mountSpeed <= 0xffffffff,
            'Invalid customized pet mount speed',
            ErrorCode.GameConfig,
        )
    ensure(
        config.homeTalent === undefined || (Number.isSafeInteger(config.homeTalent) && config.homeTalent >= 0),
        'Malformed customized pet home talent',
        ErrorCode.GameConfig,
    )
    if (config.homeTalent > 0)
        ensure(
            tables.get('home_talent').some((row) => row.talentId === config.homeTalent),
            'Customized pet home talent is unavailable',
            ErrorCode.GameConfig,
        )
    return { config, comprehensionRows, fixedGenes, maxGenes, labor }
}
function customizedComprehension(comprehensionRows) {
    return comprehensionRows.map(({ attr_id, level, minimum, maximum }) => ({
        attr_id,
        level,
        value: minimum === maximum ? minimum : randomInt(minimum, maximum + 1),
        init_level: level,
        cur_exp: 0,
    }))
}
function decorateCustomizedPet(tables, pet, { config, fixedGenes, maxGenes, labor }, comprehension) {
    pet.customized_id = config.id
    pet.lv = config.level
    pet.comprehension = comprehension.map((row) => ({ ...row }))
    if (config.talentDnaType === 1 || config.dnaType === 1) {
        const ids =
            config.dnaType === 1
                ? fixedGenes
                : [...new Set([...fixedGenes, ...pet.gene_infos.map((g) => g.gene_id)])].slice(0, maxGenes)
        pet.gene_infos = ids.map((gene_id, index) => ({ pos: index + 1, gene_id, gene_lv: 1 }))
        pet.gene_state = Math.ceil(ids.length / 2)
    }
    pet.can_not_release = config.isRelease === 0
    if (labor) pet.labor_infos = labor.map((row) => ({ ...row }))
    // Explicit template field; home_talent is keyed by talentId, not id.
    // This local generation rule replaces the base random/default list.
    if (config.homeTalent > 0) pet.talent_id = [config.homeTalent]
    if (config.mountType === 1) pet.speed = config.mountSpeed
    pet.grade = petGrade(tables, pet)
    return pet
}
// Pure profile construction: no account, slot, GUID sequence or acquisition
// record is touched. Uses the same customization rules as actual rewards.
export function customizedPetData(tables, customizedId, guid = '0', box = 0) {
    const definition = customizedPetRewardDefinition(tables, customizedId)
    return decorateCustomizedPet(
        tables,
        petData(tables, definition.config.petId, guid, box, definition.config.builderRule || 1001),
        definition,
        customizedComprehension(definition.comprehensionRows),
    )
}
export function createCustomizedPets(tables, state, customizedId, count) {
    const definition = customizedPetRewardDefinition(tables, customizedId),
        comprehension = customizedComprehension(definition.comprehensionRows),
        { config } = definition,
        pets = createPets(tables, state, config.petId, count, config.builderRule || 1001)
    for (const pet of pets) decorateCustomizedPet(tables, pet, definition, comprehension)
    return pets
}
