import policy from '../configs/pet-dna-skill-policy.json' with { type: 'json' }
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const uint = (value) => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff
const caches = new WeakMap()
const warnings = new WeakMap()
ensure(
    policy.version === 1 &&
        policy.mode === 'validated-effect-dna-initialization' &&
        policy.skillType === 1 &&
        policy.skillLogicType === 6 &&
        policy.supportedMaximum === 8 &&
        policy.supportedGeneLevel === 1 &&
        policy.legacyOtherLevels === 'preserve-diagnose-without-level-downgrade' &&
        policy.wire.skill_lv === 1 &&
        policy.wire.skill_slot === 0 &&
        policy.wire.type === 0 &&
        policy.legacyUnknown === 'preserve-raw-diagnose-and-do-not-initialize-unproven-skill' &&
        policy.liveSkillReplacementComplete === false &&
        policy.mutationProtocolsComplete === false,
    'Invalid effect DNA initialization policy',
    ErrorCode.GameConfig,
)

function data(tables) {
    if (caches.has(tables)) return caches.get(tables)
    const unique = (rows, field) => {
        const result = new Map()
        for (const row of rows) {
            ensure(uint(row[field]) && !result.has(row[field]), 'Invalid effect DNA table index', ErrorCode.GameConfig)
            result.set(row[field], row)
        }
        return result
    }
    const unlock = new Map()
    const raw = tables.get('game').find((row) => row.title === 'PET_DNAUNLOCK_NEW')?.value
    ensure(typeof raw === 'string', 'Gene unlock configuration unavailable', ErrorCode.GameConfig)
    for (const token of raw.split('|')) {
        const values = token.split('#').map(Number)
        ensure(
            values.length === 2 &&
                uint(values[0]) &&
                Number.isSafeInteger(values[1]) &&
                values[1] >= 0 &&
                !unlock.has(values[0]),
            'Invalid effect DNA unlock configuration',
            ErrorCode.GameConfig,
        )
        unlock.set(...values)
    }
    const result = {
        dna: unique(tables.get('pet_dna'), 'id'),
        skills: unique(tables.get('skill'), 'id'),
        logic: unique(tables.get('skillsub_logic'), 'skillId'),
        levelOne: new Set(
            tables
                .get('skill_level')
                .filter((row) => row.level === 1)
                .map((row) => row.skillId),
        ),
        unlock,
        maximum: Number(tables.get('game').find((row) => row.title === 'PET_DNA_MAX_NUM')?.value),
    }
    ensure(
        result.maximum === policy.supportedMaximum,
        'Unsupported effect DNA capacity configuration',
        ErrorCode.GameConfig,
    )
    ensure(
        Array.from({ length: result.maximum }, (_, index) => index + 1).every((pos) => unlock.has(pos)),
        'Incomplete effect DNA unlock configuration',
        ErrorCode.GameConfig,
    )
    caches.set(tables, result)
    return result
}

function diagnose(tables, pet, gene, reason) {
    let seen = warnings.get(tables)
    if (!seen) warnings.set(tables, (seen = new Set()))
    const key = `${reason}:${gene?.gene_id ?? 'invalid'}`
    if (seen.has(key) || seen.size >= 1024) return
    seen.add(key)
    try {
        console.warn(
            '[pet-dna-init]',
            JSON.stringify({
                reason,
                petGuid: String(pet.guid ?? ''),
                geneId: gene?.gene_id ?? null,
                action: 'preserve-raw-without-unproven-skill',
            }),
        )
    } catch {
        // Diagnostics do not turn a compatible legacy login into a failure.
    }
}

export function effectGeneSkills(tables, pet) {
    const config = data(tables)
    const result = new Map()
    for (const gene of pet.gene_infos ?? []) {
        if (!gene || typeof gene !== 'object' || !uint(gene.gene_id)) {
            diagnose(tables, pet, gene, 'invalid-legacy-gene-id')
            continue
        }
        const dna = config.dna.get(gene.gene_id)
        const skill = config.skills.get(gene.gene_id)
        if (!dna || !skill) {
            diagnose(tables, pet, gene, 'unknown-legacy-gene-reference')
            continue
        }
        if (skill.skillType === 2) continue
        if (
            skill.skillType !== policy.skillType ||
            !config.levelOne.has(gene.gene_id) ||
            config.logic.get(gene.gene_id)?.skillLogicType !== policy.skillLogicType
        ) {
            diagnose(tables, pet, gene, 'unproven-legacy-effect-configuration')
            continue
        }
        if (
            !uint(gene.pos) ||
            gene.pos > config.maximum ||
            !uint(gene.gene_lv) ||
            !Number.isSafeInteger(pet.lv ?? 1) ||
            (pet.lv ?? 1) < 0
        ) {
            diagnose(tables, pet, gene, 'invalid-legacy-effect-state')
            continue
        }
        if ((pet.lv ?? 1) < (config.unlock.get(gene.pos) ?? 0)) continue
        if (gene.gene_lv !== policy.supportedGeneLevel) {
            diagnose(tables, pet, gene, 'legacy-effect-level-not-proven')
            continue
        }
        if (result.has(gene.gene_id)) {
            diagnose(tables, pet, gene, 'duplicate-legacy-effect-id')
            continue
        }
        result.set(gene.gene_id, { skill_id: gene.gene_id, ...policy.wire })
    }
    return [...result.values()]
}
