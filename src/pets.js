import { recordPetAcquisition } from './pet-catalog.js'
import fs from 'node:fs'
import { randomInt } from 'node:crypto'
import { initialPetSkills } from './skills.js'
import { ensure } from './handlers/common.js'
import { pairs } from './battle.js'
import { initialPetComprehension, repairPetComprehension } from './pet-comprehension.js'
import { randomMountSpeed } from './mounts.js'
import { refreshPetCaressPeriod } from './pet-caress.js'

// The localized export corrupts pet.gradeScore. Use the numeric CBT3 table.
const petScores = new Map(
    JSON.parse(fs.readFileSync(new URL('../configs/pet-tables/pet.json', import.meta.url), 'utf8')).map((row) => [
        row.id,
        row.gradeScore,
    ]),
)
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
    const row = tables.find('pet_home_talent', configId)
    if (!row) return []
    const types = String(row.laborType || '')
        .split('|')
        .filter(Boolean)
        .map(Number)
    const scoreRanges = String(row.laborScoreLimit || '').split('|')
    const maximum = Math.max(...tables.get('home_labor_train').map((x) => x.id))
    return [...new Set(types)]
        .filter((id) => tables.find('home_labor_type', id))
        .map((labor_id, index) => {
            const range = scoreRanges[index] || scoreRanges[0] || '1#1'
            const grade = Math.max(1, Math.min(maximum, Number(range.split('#')[0]) || 1))
            return { labor_id, labor_grade: grade, upper_labor_grade: maximum, labor_exp: 0 }
        })
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
    ensure(config && typeof config.name === 'string' && config.name.trim(), 'Missing pet name', 1007)
    pet.pet_name = Buffer.from(config.name, 'utf8').toString('base64')
    return true
}
export function petData(tables, configId, guid, box, builderRuleId = 1001) {
    const config = tables.find('pet', configId)
    ensure(config && tables.find('template_value', configId), 'Missing pet configuration', 1007)
    const pet = {
        guid: String(guid),
        pet_name: Buffer.from(config.name, 'utf8').toString('base64'),
        config_id: configId,
        feature: 1,
        color: 0,
        comprehension: initialPetComprehension(tables, builderRuleId),
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
        satiety_val: 10000,
        hero_id: '0',
        roulette_pos: 0,
    }
    if (tables.find('mount', configId)) pet.speed = randomMountSpeed(tables)
    pet.gene_infos = initialPetGenes(tables, config)
    pet.gene_state = Math.ceil(pet.gene_infos.length / 2)
    pet.grade = petGrade(tables, pet)
    pet.labor_infos = initialPetLabor(tables, configId)
    pet.talent_id = initialPetTalents(tables, configId)
    return pet
}
export function createPets(tables, state, configId, count, builderRuleId = 1001) {
    const boxCount = Number(tables.get('game').find((r) => r.title === 'PET_BOX_NUM')?.value),
        boxSize = Number(tables.get('game').find((r) => r.title === 'PET_BOX_LIMIT')?.value)
    ensure(
        Number.isInteger(boxCount) && boxCount > 0 && Number.isInteger(boxSize) && boxSize > 0 && boxSize < 100,
        'Invalid pet box limits',
        1007,
    )
    ensure(
        Number.isInteger(count) && count > 0 && state.pets.length + count <= boxCount * boxSize,
        'Pet boxes are full',
    )
    const used = new Set(state.pets.map((p) => p.box_id)),
        slots = []
    for (let box = 1; box <= boxCount; box++)
        for (let slot = 1; slot <= boxSize; slot++) {
            const id = box * 100 + slot
            if (!used.has(id)) slots.push(id)
        }
    ensure(slots.length >= count, 'No free pet slot')
    let sequence = state.nextPetSequence || 1
    for (const pet of state.pets) {
        const id = BigInt(pet.guid)
        if (id >> 56n === 2n) sequence = Math.max(sequence, Number(id & 0xffffffffn) + 1)
    }
    ensure(Number.isSafeInteger(sequence) && sequence + count - 1 <= 0xffffffff, 'Pet identity space exhausted')
    const created = []
    for (let i = 0; i < count; i++) {
        const guid = ((2n << 56n) | (BigInt(configId) << 32n) | BigInt(sequence++)).toString()
        const pet = petData(tables, configId, guid, slots[i], builderRuleId)
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
export function createCustomizedPets(tables, state, customizedId, count) {
    const config = tables.find('pet_customized', customizedId)
    ensure(
        config &&
            tables.find('pet', config.petId) &&
            Number.isInteger(config.level) &&
            config.level > 0 &&
            config.skillType === 0 &&
            config.skillCountType === 0 &&
            [0, 1].includes(config.talentDnaType) &&
            [0, 1].includes(config.dnaType),
        'Unsupported customized pet configuration',
        1007,
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
        1007,
    )
    const upgrades = tables.get('pet_talent_upgrade')
    const comprehension = attributes.map((attr_id) => {
        const level = levels.get(attr_id),
            row = upgrades.find((x) => x.attrId === attr_id && x.level === level)
        ensure(
            row && Number.isInteger(row.InterA) && Number.isInteger(row.InterB) && row.InterA <= row.InterB,
            'Invalid customized pet aptitude value',
            1007,
        )
        const value = row.InterA === row.InterB ? row.InterA : randomInt(row.InterA, row.InterB + 1)
        return { attr_id, value, level, init_level: level, cur_exp: 0 }
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
        1007,
    )
    const pets = createPets(tables, state, config.petId, count, config.builderRule || 1001)
    for (const pet of pets) {
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
        pet.grade = petGrade(tables, pet)
    }
    return pets
}
