import { createHash } from 'node:crypto'
import programs from '../configs/pet-gene-element-programs.json' with { type: 'json' }
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const caches = new WeakMap(),
    validated = new WeakSet()
const canonical = (value) =>
    Array.isArray(value)
        ? value.map(canonical)
        : value && typeof value === 'object'
          ? Object.fromEntries(
                Object.keys(value)
                    .sort()
                    .map((key) => [key, canonical(value[key])]),
            )
          : value
const hash = (value) =>
    createHash('sha256')
        .update(JSON.stringify(canonical(value)))
        .digest('hex')
function freeze(value) {
    if (value && typeof value === 'object') {
        for (const item of Object.values(value)) freeze(item)
        Object.freeze(value)
    }
    return value
}
freeze(programs)
function data(tables) {
    if (caches.has(tables)) return caches.get(tables)
    const index = (table, key = 'id') => new Map(tables.get(table).map((row) => [row[key], row]))
    const result = {
        dna: index('pet_dna'),
        skills: index('skill'),
        logic: index('skillsub_logic', 'skillId'),
        numeric: index('skillsub_attrup'),
        levels: new Map(tables.get('skill_level').map((row) => [row.skillId + ':' + row.level, row])),
    }
    caches.set(tables, result)
    return result
}
function elementProgram(tables, config, geneId) {
    if (!validated.has(tables)) {
        const bindings = [...config.dna.keys()]
            .sort((a, b) => a - b)
            .filter((id) => config.skills.get(id)?.skillType === 2 && !config.numeric.has(id))
            .map((id) => ({
                id,
                level: 1,
                skillType: 2,
                subSkillId: config.levels.get(id + ':1')?.subSkillId,
                skillLogicType: config.logic.get(id)?.skillLogicType,
            }))
        const { sourceFingerprint, ...core } = programs
        ensure(
            programs.version === 1 &&
                programs.clientVersion === '1.0.0' &&
                programs.mode === 'current-native-gene-elements' &&
                sourceFingerprint === hash(core),
            'Invalid gene element projection source',
            ErrorCode.GameConfig,
        )
        ensure(
            programs.bindingsFingerprint === hash(bindings),
            'Current gene element projection binding is unavailable',
            ErrorCode.GeneConfIsNull,
        )
        ensure(
            Object.keys(programs.programs).length === bindings.length &&
                bindings.every((row) => {
                    const program = programs.programs[row.id]
                    return (
                        program &&
                        hash(program.binding) === hash(row) &&
                        program.elements.length > 0 &&
                        program.projection === 'native-slot0-elements-not-flat-attributes'
                    )
                }),
            'Current gene element projection domain is incomplete',
            ErrorCode.GeneConfIsNull,
        )
        const formulae = new Map(tables.get('element_formula').map((row) => [row.id, row]))
        for (const program of Object.values(programs.programs))
            for (const element of program.elements) {
                const current = formulae.get(element.formula.id)
                ensure(current, 'Gene element formula is unavailable', ErrorCode.GeneConfIsNull)
                ensure(typeof current.functionOutput === 'string', 'Invalid gene element formula', ErrorCode.GameConfig)
                ensure(
                    current.functionOutput === element.formula.functionOutput,
                    'Current gene element formula changed since projection export',
                    ErrorCode.GeneConfIsNull,
                )
            }
        validated.add(tables)
    }
    const program = programs.programs[geneId]
    ensure(program, 'Gene element projection is unavailable', ErrorCode.GeneConfIsNull)
    return program
}

// skillType remains the current table's effect1/number2 discriminator. A number
// with a proven executable native program is not reclassified as type1.
export function isElementBackedGene(tables, geneId) {
    const config = data(tables)
    return config.dna.has(geneId) && config.skills.get(geneId)?.skillType === 2 && !config.numeric.has(geneId)
}
export function petGeneProjection(tables, geneId, level = 1) {
    const config = data(tables),
        dna = config.dna.get(geneId),
        skill = config.skills.get(geneId)
    ensure(
        dna && skill && config.levels.has(geneId + ':' + level),
        'Gene projection definition unavailable',
        ErrorCode.GeneConfIsNull,
    )
    if (skill.skillType === 2 && config.numeric.has(geneId)) return { mode: 'numeric', skillType: 2 }
    ensure(
        level === 1 && config.logic.get(geneId)?.skillLogicType === 6,
        'Gene skill execution kind is unsupported',
        ErrorCode.FunctionClosed,
    )
    const descriptor = { skill_id: geneId, skill_lv: 1, skill_slot: 0, type: 0 }
    if (skill.skillType === 1) return { mode: 'effect', skillType: 1, descriptor }
    ensure(skill.skillType === 2, 'Gene projection skill kind is unsupported', ErrorCode.FunctionClosed)
    return {
        mode: 'element',
        skillType: 2,
        descriptor,
        sourceFingerprint: programs.sourceFingerprint,
        program: elementProgram(tables, config, geneId),
    }
}
