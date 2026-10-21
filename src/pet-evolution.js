import rows from '../configs/pet-rank-tables/pet_rank.json' with { type: 'json' }
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { initialPetSkills } from './skills.js'
import { initialPetLabor, initialPetTalents, petGrade } from './pets.js'
import { randomMountSpeed } from './mounts.js'

const rules = new Map(rows.map((row) => [row.petId, row]))
export const petEvolutionRule = (id) => rules.get(Number(id))

function evolvedSkills(tables, pet, next) {
    const previous = pet.inherent_skills ?? [],
        byId = new Map(),
        bySlot = new Map()
    ensure(Array.isArray(previous), 'Invalid saved pet skills', ErrorCode.GameConfig)
    for (const skill of previous) {
        ensure(
            Number.isInteger(skill.skill_id) &&
                skill.skill_id > 0 &&
                Number.isInteger(skill.skill_slot) &&
                skill.skill_slot >= 0 &&
                Number.isInteger(skill.skill_lv) &&
                skill.skill_lv > 0 &&
                !bySlot.has(skill.skill_slot),
            'Invalid or duplicate saved pet skill slot',
            ErrorCode.GameConfig,
        )
        bySlot.set(skill.skill_slot, skill)
        if (!byId.has(skill.skill_id) || byId.get(skill.skill_id).skill_lv < skill.skill_lv)
            byId.set(skill.skill_id, skill)
    }
    let template
    try {
        template = initialPetSkills(next)
    } catch (error) {
        ensure(false, 'Malformed evolved pet skill configuration: ' + error.message, ErrorCode.GameConfig)
    }
    return template.map((skill) => {
        ensure(
            tables.get('skill_level').some((row) => row.skillId === skill.skill_id && row.level === skill.skill_lv),
            'Evolved pet skill configuration unavailable',
            ErrorCode.GameConfig,
        )
        const same = byId.get(skill.skill_id)
        // Same skills can move active slots. Fixed/signature replacements keep
        // their trained level only when the new skill defines that exact level.
        // Unrelated newly unlocked active skills use their initial level.
        const old = same ?? (skill.skill_slot >= 200 ? bySlot.get(skill.skill_slot) : null)
        const level = old?.skill_lv ?? skill.skill_lv
        const defined = tables.get('skill_level').some((row) => row.skillId === skill.skill_id && row.level === level)
        ensure(defined || !same, 'Evolved pet skill training level unavailable', ErrorCode.GameConfig)
        return { ...skill, skill_lv: defined ? level : skill.skill_lv }
    })
}
function evolvedLabor(tables, pet, nextId) {
    const old = new Map((pet.labor_infos ?? []).map((row) => [row.labor_id, row]))
    return initialPetLabor(tables, nextId).map((row) => (old.has(row.labor_id) ? { ...old.get(row.labor_id) } : row))
}
function evolvedTalents(tables, pet, nextId) {
    const defaults = initialPetTalents(tables, nextId)
    const byId = new Map(tables.get('home_talent').map((row) => [row.talentId, row]))
    const allowed = new Set(
        String(tables.find('pet_home_talent', nextId)?.talentGroupId || '')
            .split('|')
            .filter(Boolean)
            .map((token) => Number(token.split('#')[0])),
    )
    const retained = [],
        groups = new Set()
    for (const id of [...(pet.talent_id ?? []), ...defaults]) {
        const group = byId.get(id)?.talentGroupId
        if (allowed.has(group) && !groups.has(group)) {
            retained.push(id)
            groups.add(group)
        }
    }
    return retained.slice(0, defaults.length)
}
export function planPetEvolution(tables, state, pet, random) {
    const row = petEvolutionRule(pet.config_id),
        old = tables.find('pet', pet.config_id)
    ensure(old && row, 'Pet evolution configuration unavailable', ErrorCode.GameConfig)
    ensure(Number.isInteger(row.nextPetId) && row.nextPetId >= 0, 'Invalid pet evolution target', ErrorCode.GameConfig)
    ensure(row.nextPetId > 0, 'Pet has no next evolution stage', ErrorCode.PetRankUpFail)
    const next = tables.find('pet', row.nextPetId)
    ensure(
        next && tables.find('template_value', row.nextPetId),
        'Evolved pet definition unavailable',
        ErrorCode.PetConfNotExist,
    )
    ensure(
        Number.isInteger(pet.lv) && pet.lv > 0 && Number.isInteger(row.levelNeed) && row.levelNeed >= 0,
        'Invalid pet evolution level requirement',
        ErrorCode.GameConfig,
    )
    ensure(pet.lv >= row.levelNeed, 'Pet evolution level requirement not met', ErrorCode.PetRankUpFail)
    const rank = pet.rank ?? 1
    ensure(
        Number.isInteger(rank) && rank >= 1 && rank < 0xffffffff,
        'Invalid saved pet evolution count',
        ErrorCode.GameConfig,
    )
    ensure(
        (pet.labor_infos === undefined || Array.isArray(pet.labor_infos)) &&
            (pet.talent_id === undefined || Array.isArray(pet.talent_id)),
        'Invalid saved pet work abilities',
        ErrorCode.GameConfig,
    )
    // Local compatibility guard: do not change a live building/tour worker's
    // labor qualification underneath an active job. Unassign it first.
    ensure(!pet.work_build && !pet.tour_state, 'Assigned pet cannot evolve during work', ErrorCode.PetInWork)
    ensure(
        Number.isSafeInteger(row.rankBreakthroughCoin) && row.rankBreakthroughCoin >= 0,
        'Invalid pet evolution gold cost',
        ErrorCode.GameConfig,
    )
    const costs = []
    for (const token of String(row.rankBreakthroughItem || '')
        .split('|')
        .filter(Boolean)) {
        const tuple = token.split('#').map(Number)
        const [itemtype, itemid, itemnum] = tuple.length === 2 ? [3, ...tuple] : tuple
        ensure(
            [2, 3].includes(tuple.length) &&
                [itemtype, itemid, itemnum].every((n) => Number.isSafeInteger(n) && n > 0 && n <= 0xffffffff),
            'Malformed pet evolution material cost',
            ErrorCode.GameConfig,
        )
        ensure([3, 10].includes(itemtype), 'Pet evolution resource category not implemented', ErrorCode.FunctionClosed)
        ensure(
            tables.find(itemtype === 3 ? 'common_item' : 'currency', itemid),
            'Pet evolution cost configuration unavailable',
            ErrorCode.GameConfig,
        )
        costs.push({ itemtype, itemid, itemnum })
    }
    const update = {
        config_id: next.id,
        // Existing CBT3 release calculation uses rank as an ancestry-step
        // budget; a completed evolution adds one step without changing GUID.
        rank: rank + 1,
        inherent_skills: evolvedSkills(tables, pet, next),
        labor_infos: evolvedLabor(tables, pet, next.id),
        talent_id: evolvedTalents(tables, pet, next.id),
    }
    const oldDefault = Buffer.from(old.name, 'utf8').toString('base64')
    if (!pet.pet_name || pet.pet_name === oldDefault)
        update.pet_name = Buffer.from(next.name, 'utf8').toString('base64')
    if (tables.find('mount', next.id) && !(Number.isInteger(pet.speed) && pet.speed > 0))
        update.speed = randomMountSpeed(tables, random)
    update.grade = petGrade(tables, { ...pet, ...update })
    return { from: old.id, to: next.id, update, costs, gold: row.rankBreakthroughCoin }
}
