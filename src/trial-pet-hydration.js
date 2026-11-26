import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { petGrade, initialPetGenes, initialPetLabor, initialPetTalents } from './pets.js'
import { initialPetSatiety } from './pet-initial-satiety.js'
import { requirePetModel } from './pet-model-eligibility.js'

const positive = (n) => Number.isSafeInteger(n) && n > 0 && n <= 0xffffffff
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const valid = (v, text) => ensure(v, text, ErrorCode.GameConfig)
const caches = new WeakMap()
function list(text, width, label) {
    valid(typeof text === 'string', 'Malformed trial pet ' + label)
    if (!text) return []
    return text.split('|').map((part) => {
        const row = part.split('#').map(Number)
        valid(
            row.length === width && row.every((n) => Number.isSafeInteger(n) && n >= 0),
            'Malformed trial pet ' + label,
        )
        return row
    })
}
function definition(tables, id) {
    valid(positive(id) && id <= 0xffffff, 'Trial customized identity is malformed')
    let cache = caches.get(tables)
    if (!cache) caches.set(tables, (cache = new Map()))
    if (cache.has(id)) return cache.get(id)
    const custom = tables.find('pet_customized', id)
    ensure(custom, 'Current trial customized template is missing', ErrorCode.TrialPetNotExist)
    const base = tables.find('pet', custom.petId)
    ensure(
        base && tables.find('template_value', custom.petId),
        'Current trial pet species is missing',
        ErrorCode.PetConfNotExist,
    )
    requirePetModel(tables, { config_id: custom.petId })
    valid(
        positive(custom.level) && tables.find('template_value', 5001000 + custom.level),
        'Current trial pet growth level is missing',
    )
    valid(
        [
            custom.skillType,
            custom.skillCountType,
            custom.talentDnaType,
            custom.dnaType,
            custom.laborScoreType,
            custom.mountType,
            custom.starsoul_group,
            custom.starsoul_node,
            custom.homeTalent,
            custom.petskin,
            custom.lightParam,
            custom.mountSpeed,
        ].every((n) => Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff) &&
            typeof custom.starColorParam === 'string' &&
            typeof custom.colorParam === 'string',
        'Current trial template mode is malformed',
    )
    ensure(
        [0, 1].includes(custom.skillType) && custom.skillCountType === 0,
        'Current trial skill selection mode is not implemented',
        ErrorCode.FunctionClosed,
    )
    ensure(
        [custom.talentDnaType, custom.dnaType].every((n) => [0, 1].includes(n)),
        'Current trial DNA selection mode is not implemented',
        ErrorCode.FunctionClosed,
    )
    ensure(
        custom.laborScoreType === 0 &&
            custom.mountType === 0 &&
            custom.starsoul_group === 0 &&
            custom.starsoul_node === 0 &&
            custom.homeTalent === 0 &&
            custom.petskin === 0 &&
            custom.lightParam === 0 &&
            custom.starColorParam === '' &&
            custom.colorParam === '',
        'Current trial template override is not implemented',
        ErrorCode.FunctionClosed,
    )
    const attributes = tables.get('pet_learningenum').map((r) => r.attributeEnum),
        rows = list(custom.petAttr, 2, 'aptitudes')
    valid(
        rows.length === attributes.length &&
            new Set(rows.map((r) => r[0])).size === rows.length &&
            rows.every(([attr]) => attributes.includes(attr)),
        'Trial aptitude dimensions do not match the current schema',
    )
    const comprehension = rows.map(([attr_id, level]) => {
        valid(level >= 1, 'Current trial aptitude level is malformed')
        ensure(level <= 9, 'Legacy absolute trial aptitude presets are not implemented', ErrorCode.FunctionClosed)
        const row = tables.get('pet_talent_upgrade').find((r) => r.attrId === attr_id && r.level === level)
        valid(
            row && Number.isSafeInteger(row.InterA) && Number.isSafeInteger(row.InterB) && row.InterA <= row.InterB,
            'Trial aptitude level configuration is missing',
        )
        ensure(
            row.InterA === row.InterB,
            'Non-fixed trial aptitude value realization is not implemented',
            ErrorCode.FunctionClosed,
        )
        return { attr_id, value: row.InterA, level, init_level: level, cur_exp: 0 }
    })
    const signatureSlot = Number(tables.get('game').find((r) => r.title === 'PET_SIGNATURESKILLLIST')?.value)
    valid(positive(signatureSlot), 'Current trial signature slot is missing')
    const skills = new Map()
    const add = (slot, skill_id) => {
        valid(
            positive(slot) &&
                positive(skill_id) &&
                tables.find('skill', skill_id) &&
                tables.get('skill_level').some((r) => r.skillId === skill_id && r.level === 1),
            'Current trial skill configuration is missing',
        )
        valid(!skills.has(slot) || skills.get(slot).skill_id === skill_id, 'Current trial skill slot is ambiguous')
        skills.set(slot, { skill_slot: slot, skill_id, skill_lv: 1, type: 0 })
    }
    const dict = (text, label) => {
        for (const [slot, skill] of list(text, 2, label)) add(slot, skill)
    }
    const triples = (text, label, override) => {
        for (const [slot, skill, enabled] of list(text, 3, label)) if (enabled) add(override ?? slot, skill)
    }
    // Current InitNormalPetSkill0600e22c: a nonempty server skill dictionary
    // suppresses its config fallback. Include base fixed/blink/property slots
    // explicitly, while custom skillType selects signature/common/break only.
    dict(base.fixedSkillList, 'base fixed skills')
    dict(base.fPropertyskillList, 'base fixed property skills')
    ensure(
        !base.rPropertyskillList,
        'Random base property skills are not implemented for this trial source',
        ErrorCode.FunctionClosed,
    )
    triples(base.blinkSkillList, 'base blink skills')
    const source = custom.skillType === 0 ? base : custom
    triples(source.signatureSkillList, 'signature skills', signatureSlot)
    dict(source.breakSkillList, 'break skills')
    triples(source.skillList, 'common skills')
    const fixedGenes = [
        ...(custom.talentDnaType ? [custom.talentDna] : []),
        ...(custom.dnaType ? String(custom.dna).split('|').filter(Boolean).map(Number) : []),
    ]
    const maxGenes = Number(tables.get('game').find((r) => r.title === 'PET_DNA_MAX_NUM')?.value)
    valid(
        positive(maxGenes) &&
            new Set(fixedGenes).size === fixedGenes.length &&
            fixedGenes.length <= maxGenes &&
            fixedGenes.every(
                (gene) =>
                    positive(gene) &&
                    tables.find('pet_dna', gene) &&
                    tables.find('skill', gene) &&
                    tables.get('skill_level').some((r) => r.skillId === gene && r.level === 1),
            ),
        'Current trial fixed DNA configuration is missing',
    )
    const result = { custom, base, comprehension, skills: [...skills.values()], fixedGenes, maxGenes }
    cache.set(id, result)
    return result
}
export function trialPetHydrationDefinition(tables, id) {
    return structuredClone(definition(tables, id))
}
export function hydrateTrialPet(tables, templateId, guid, existing = undefined) {
    const data = definition(tables, templateId),
        text = String(guid)
    valid(/^[1-9]\d*$/.test(text) && BigInt(text) <= 0xffffffffffffffffn, 'Trial pet GUID is malformed')
    const value = BigInt(text),
        owner = Number(value & 0xffffffffn),
        middle = Number((value >> 32n) & 0xffffffn)
    valid(
        Number(value >> 56n) === 9 && middle === templateId && owner > 0,
        'Trial pet GUID does not name its customized template',
    )
    valid(
        existing === undefined || (object(existing) && existing.type === 2),
        'Only temporary pet profiles may be hydrated',
    )
    const speciesChanged = !!existing && existing.config_id !== data.custom.petId
    // Reuse only established local temporary baseline fields. Aptitude and
    //skills come directly from this customized definition: no owned builder,
    //RNG, allocator or acquisition history is involved.
    const generic = {
        guid: text,
        pet_name: Buffer.from(data.base.name, 'utf8').toString('base64'),
        config_id: data.custom.petId,
        feature: 0,
        color: 0,
        lv: data.custom.level,
        rank: 1,
        exp: 0,
        base_lv: 1,
        favor_lv: 1,
        favor_val: 0,
        is_lock: false,
        box_id: 0,
        type: 2,
        hero_id: '0',
        roulette_pos: 0,
        satiety_val: initialPetSatiety(tables, data.custom.petId, { temporary: true }),
        labor_infos: initialPetLabor(tables, data.custom.petId),
        talent_id: initialPetTalents(tables, data.custom.petId),
        gene_infos: initialPetGenes(tables, data.base),
    }
    const pet = {
        ...generic,
        ...existing,
        guid: text,
        config_id: data.custom.petId,
        type: 2,
        lv: data.custom.level,
        rank: 1,
        exp: 0,
        base_lv: 1,
        soul_link_level: '0',
        feature: 0,
        is_lock: false,
        comprehension: data.comprehension.map((r) => ({ ...r })),
        inherent_skills: data.skills.map((r) => ({ ...r })),
        speed: data.custom.mountSpeed,
        customized_id: templateId,
    }
    if (data.fixedGenes.length)
        pet.gene_infos = data.fixedGenes.map((gene_id, index) => ({ pos: index + 1, gene_id, gene_lv: 1 }))
    else if (!existing || speciesChanged) pet.gene_infos = structuredClone(generic.gene_infos)
    else {
        valid(Array.isArray(existing.gene_infos), 'Trial wire DNA fallback is malformed')
        valid(
            existing.gene_infos.length <= data.maxGenes &&
                existing.gene_infos.every(
                    (r) =>
                        object(r) &&
                        positive(r.pos) &&
                        r.pos <= data.maxGenes &&
                        positive(r.gene_lv) &&
                        positive(r.gene_id) &&
                        tables.find('pet_dna', r.gene_id) &&
                        tables.find('skill', r.gene_id),
                ),
            'Trial wire DNA fallback references missing configuration',
        )
        valid(
            new Set(existing.gene_infos.map((r) => r.pos)).size === existing.gene_infos.length,
            'Trial wire DNA fallback positions are duplicated',
        )
        pet.gene_infos = structuredClone(existing.gene_infos)
    }
    if (speciesChanged) {
        pet.pet_name = generic.pet_name
        pet.labor_infos = structuredClone(generic.labor_infos)
        pet.talent_id = structuredClone(generic.talent_id)
        pet.color = 0
        pet.colorful = 0
        pet.special = 0
    }
    const minimumGeneState = Math.ceil(pet.gene_infos.reduce((max, row) => Math.max(max, row.pos), 0) / 2)
    if (!data.fixedGenes.length && existing && !speciesChanged && existing.gene_state !== undefined) {
        valid(
            Number.isSafeInteger(existing.gene_state) &&
                existing.gene_state >= minimumGeneState &&
                existing.gene_state <= Math.ceil(data.maxGenes / 2),
            'Trial wire DNA fallback unlock state is malformed',
        )
        pet.gene_state = existing.gene_state
    } else pet.gene_state = minimumGeneState
    pet.grade = petGrade(tables, pet)
    return pet
}
