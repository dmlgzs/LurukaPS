import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { mutationPolicy } from './pet-mutation-policy.js'
import { mutationHash, mutationObject, mutationPositive, mutationUint } from './pet-mutation-state.js'

const dataCache = new WeakMap()
const ruleCache = new WeakMap()
function constant(tables, title) {
    const rows = tables.get('game').filter((r) => r.title === title)
    const value = rows.length === 1 ? Number(rows[0].value) : NaN
    ensure(mutationPositive(value), 'Invalid mutation constant: ' + title, ErrorCode.GameConfig)
    return value
}
function unique(rows, key, name) {
    const result = new Map()
    for (const row of rows) {
        ensure(
            mutationObject(row) && mutationPositive(row[key]) && !result.has(row[key]),
            'Invalid mutation table key: ' + name,
            ErrorCode.GameConfig,
        )
        result.set(row[key], row)
    }
    return result
}
function weights(text, name) {
    ensure(typeof text === 'string' && text.length > 0, 'Missing mutation weights: ' + name, ErrorCode.GameConfig)
    const result = []
    for (const field of text.split('|')) {
        const values = field.split('#').map(Number)
        ensure(
            values.length === 2 &&
                mutationPositive(values[0]) &&
                mutationUint(values[1]) &&
                !result.some((r) => r.value === values[0]),
            'Invalid mutation weights: ' + name,
            ErrorCode.GameConfig,
        )
        result.push({ value: values[0], weight: values[1] })
    }
    ensure(
        result.some((r) => r.weight > 0),
        'Empty positive mutation weights: ' + name,
        ErrorCode.GameConfig,
    )
    return result
}
function shared(tables) {
    if (dataCache.has(tables)) return dataCache.get(tables)
    const max = constant(tables, 'PET_DNA_MAX_NUM'),
        same = constant(tables, 'PET_SAME_DNA_NUM'),
        deviant = constant(tables, 'NESTCOOP_DEVIANT_PETDNA_LIMIT')
    const rawUnlock = tables.get('game').find((r) => r.title === 'PET_DNAUNLOCK_NEW')?.value
    ensure(typeof rawUnlock === 'string', 'Missing mutation slot unlock table', ErrorCode.GameConfig)
    const unlock = new Map()
    for (const field of rawUnlock.split('|')) {
        const values = field.split('#').map(Number)
        ensure(
            values.length === 2 && mutationPositive(values[0]) && mutationUint(values[1]) && !unlock.has(values[0]),
            'Invalid mutation slot unlock entry',
            ErrorCode.GameConfig,
        )
        unlock.set(values[0], values[1])
    }
    ensure(
        unlock.size === max && [...unlock.keys()].every((pos) => pos <= max),
        'Incomplete mutation slot unlock domain',
        ErrorCode.GameConfig,
    )
    const dna = unique(tables.get('pet_dna'), 'id', 'pet_dna'),
        skills = unique(tables.get('skill'), 'id', 'skill')
    const logic = unique(tables.get('skillsub_logic'), 'skillId', 'skillsub_logic'),
        numeric = unique(tables.get('skillsub_attrup'), 'id', 'skillsub_attrup')
    const levels = new Map()
    for (const row of tables.get('skill_level')) {
        if (!dna.has(row.skillId)) continue
        ensure(mutationPositive(row.level), 'Invalid DNA skill level row', ErrorCode.GameConfig)
        const key = row.skillId + ':' + row.level
        ensure(!levels.has(key), 'Duplicate DNA skill level row', ErrorCode.GameConfig)
        levels.set(key, row)
    }
    for (const row of dna.values())
        ensure(
            mutationPositive(row.rarity) &&
                [1, 2].includes(row.talentDnaType) &&
                mutationUint(row.evoDnaId) &&
                [0, 1].includes(row.nestCoopTag),
            'Malformed DNA definition',
            ErrorCode.GameConfig,
        )
    const result = {
        max,
        same,
        deviant,
        unlock,
        dna,
        skills,
        logic,
        numeric,
        levels,
        rules: unique(tables.get('pet_builder_rule'), 'id', 'pet_builder_rule'),
        builders: unique(tables.get('pet_builder'), 'ID', 'pet_builder'),
        pools: tables.get('pet_dnapool'),
    }
    dataCache.set(tables, result)
    return result
}
function definition(data, id, level = 1, { candidate = true } = {}) {
    const gene = data.dna.get(id),
        skill = data.skills.get(id),
        levelRow = data.levels.get(id + ':' + level)
    ensure(gene && skill, 'Mutation DNA definition unavailable', ErrorCode.GeneConfIsNull)
    ensure(levelRow, 'Legacy DNA level is outside the proven current definition', ErrorCode.FunctionClosed)
    ensure([1, 2].includes(skill.skillType), 'Unsupported mutation DNA skill kind', ErrorCode.FunctionClosed)
    if (skill.skillType === 2) {
        if (candidate)
            ensure(data.numeric.has(id), 'Mutation numeric DNA definition unavailable', ErrorCode.GeneConfIsNull)
    } else
        ensure(
            data.logic.get(id)?.skillLogicType === 6,
            'Unproven mutation effect DNA initialization kind',
            ErrorCode.FunctionClosed,
        )
    return { ...gene, skillType: skill.skillType, level }
}
export function mutationCatalog(tables, selectedRule = mutationPolicy().generation.defaultRule) {
    let cache = ruleCache.get(tables)
    if (!cache) ruleCache.set(tables, (cache = new Map()))
    if (cache.has(selectedRule)) return cache.get(selectedRule)
    const data = shared(tables)
    const rule = data.rules.get(selectedRule)
    ensure(rule, 'Mutation builder rule unavailable', ErrorCode.GeneConfIsNull)
    const builder = data.builders.get(rule.petBuilderId)
    ensure(builder, 'Mutation builder definition unavailable', ErrorCode.GeneConfIsNull)
    const quality = weights(builder.geneQuality, 'geneQuality')
    ensure(
        !quality.some((q) => q.value === 6 && q.weight > 0),
        'Positive quality6 mutation policy requires full review',
        ErrorCode.FunctionClosed,
    )
    const pool = data.pools.filter((r) => r.dnaGroup === rule.petDnaPoolId)
    ensure(pool.length > 0, 'Mutation gene pool unavailable', ErrorCode.GeneConfIsNull)
    const ids = new Set()
    for (const row of pool) {
        ensure(
            mutationPositive(row.id) && !ids.has(row.id) && mutationUint(row.weight) && data.dna.has(row.dna),
            'Malformed mutation pool row',
            ErrorCode.GameConfig,
        )
        ids.add(row.id)
        ensure(
            row.talentDnaType === data.dna.get(row.dna).talentDnaType,
            'Mutation pool and DNA kind disagree',
            ErrorCode.GameConfig,
        )
        if (
            row.weight > 0 &&
            row.talentDnaType === 2 &&
            quality.some((q) => q.value === data.dna.get(row.dna).rarity && q.weight > 0)
        )
            definition(data, row.dna)
    }
    // Every actual innate upgrade is compiled; no numeric-only fallback domain.
    for (const gene of data.dna.values()) {
        if (!gene.evoDnaId || gene.evoDnaId === gene.id) continue
        const next = definition(data, gene.evoDnaId)
        ensure(
            gene.talentDnaType === 1 && next.talentDnaType === 1 && next.rarity > gene.rarity,
            'Unsupported non-upgrading DNA evolution mapping',
            ErrorCode.FunctionClosed,
        )
    }
    const semantics = {
        strategy: {
            generation: mutationPolicy().generation,
            appearance: mutationPolicy().fieldsAndProjection.appearance,
            ur: mutationPolicy().fieldsAndProjection.acceptedReplacementOfMarkedRarity6,
            geneStateAppend: mutationPolicy().fieldsAndProjection.geneStateOnCommittedAppend,
        },
        limits: { max: data.max, same: data.same, deviant: data.deviant, unlock: [...data.unlock] },
        rule: {
            id: rule.id,
            builder: rule.petBuilderId,
            pool: rule.petDnaPoolId,
            elite: rule.petDnaElitePoolId,
            mutation: rule.petDnaMutation,
        },
        quality,
        pool: pool.map((r) => ({ id: r.id, dna: r.dna, kind: r.talentDnaType, weight: r.weight })),
        dna: [...data.dna.values()].map((r) => ({
            id: r.id,
            rarity: r.rarity,
            kind: r.talentDnaType,
            evo: r.evoDnaId,
            deviant: r.nestCoopTag,
            gradeScore: r.gradeScore,
        })),
        effects: [...data.dna.keys()]
            .filter((id) => data.skills.has(id))
            .map((id) => ({
                id,
                type: data.skills.get(id).skillType,
                level1: data.levels.get(id + ':1')?.subSkillId ?? null,
                logic: data.logic.get(id)?.skillLogicType ?? null,
                attrs: data.numeric.get(id)?.attributeList ?? null,
            })),
    }
    const result = {
        ...data,
        ruleId: selectedRule,
        quality,
        pool,
        fingerprint: mutationHash(semantics),
        definition: (id, level, options) => definition(data, id, level, options),
    }
    cache.set(selectedRule, result)
    return result
}
export function mutationGenome(catalog, pet) {
    const genes = pet.gene_infos ?? []
    ensure(
        Array.isArray(genes) && genes.length <= catalog.max && mutationUint(pet.lv ?? 1),
        'Invalid saved mutation gene layout',
        ErrorCode.GameConfig,
    )
    const canonical = genes.map((row, i) => {
        ensure(
            mutationObject(row) &&
                row.pos === i + 1 &&
                mutationPositive(row.gene_id) &&
                mutationPositive(row.gene_lv) &&
                Object.keys(row).every((k) => ['pos', 'gene_id', 'gene_lv'].includes(k)),
            'Invalid or aliased saved mutation gene slot',
            ErrorCode.GameConfig,
        )
        catalog.definition(row.gene_id, row.gene_lv, { candidate: false })
        ensure(row.gene_lv === 1, 'Legacy DNA level needs a complete projection contract', ErrorCode.FunctionClosed)
        return { ...row }
    })
    const count = new Map()
    for (const row of canonical) count.set(row.gene_id, (count.get(row.gene_id) ?? 0) + 1)
    ensure(
        [...count.values()].every((n) => n <= catalog.same),
        'Invalid duplicated saved DNA',
        ErrorCode.GameConfig,
    )
    ensure(
        canonical.filter((r) => catalog.dna.get(r.gene_id).nestCoopTag === 1).length <= catalog.deviant,
        'Invalid saved deviant DNA count',
        ErrorCode.GameConfig,
    )
    const marked = pet.ur_pos ?? 0
    ensure(
        mutationUint(marked) &&
            (marked === 0 ||
                (marked <= canonical.length && catalog.dna.get(canonical[marked - 1].gene_id).rarity === 6)),
        'Unverified legacy shining DNA marker',
        ErrorCode.FunctionClosed,
    )
    return canonical
}
export function mutationBaseHash(pet, genes) {
    return mutationHash({ guid: pet.guid, config_id: pet.config_id, genes, ur_pos: pet.ur_pos ?? 0 })
}
function legalResult(catalog, genes, pos, candidate) {
    const rest = genes.filter((r) => r.pos !== pos)
    return (
        rest.filter((r) => r.gene_id === candidate.id).length < catalog.same &&
        (candidate.nestCoopTag !== 1 ||
            rest.filter((r) => catalog.dna.get(r.gene_id).nestCoopTag === 1).length < catalog.deviant)
    )
}
export function mutationSlotDomain(catalog, pet, genes, pos) {
    if ((pet.lv ?? 1) < catalog.unlock.get(pos)) return null
    const old = genes[pos - 1]
    const innate = pos === 1 && old && catalog.dna.get(old.gene_id).talentDnaType === 1
    if (innate) {
        const source = catalog.dna.get(old.gene_id)
        if (!source.evoDnaId || source.evoDnaId === source.id) return null
        const target = catalog.definition(source.evoDnaId)
        if (!legalResult(catalog, genes, pos, target)) return null
        return { pos, innate: true, candidate: target.id }
    }
    const groups = []
    for (const q of catalog.quality) {
        if (!q.weight) continue
        const choices = catalog.pool.filter(
            (row) =>
                row.weight > 0 &&
                row.talentDnaType === 2 &&
                row.dna !== old?.gene_id &&
                catalog.dna.get(row.dna).rarity === q.value &&
                legalResult(catalog, genes, pos, catalog.dna.get(row.dna)),
        )
        if (choices.length) groups.push({ rarity: q.value, weight: q.weight, choices })
    }
    return groups.length ? { pos, innate: false, groups } : null
}
export function mutationDraw(rng, limit) {
    ensure(mutationPositive(limit), 'Mutation random domain overflow or empty', ErrorCode.GameConfig)
    const value = rng(limit)
    ensure(
        mutationUint(value) && value < limit,
        'Mutation random source returned an invalid value',
        ErrorCode.GameConfig,
    )
    return value
}
export function mutationWeighted(rng, values) {
    const total = values.reduce((n, r) => n + r.weight, 0)
    let roll = mutationDraw(rng, total)
    for (const row of values) {
        if (roll < row.weight) return row
        roll -= row.weight
    }
    ensure(false, 'Mutation weighted selection failed', ErrorCode.GameConfig)
}
