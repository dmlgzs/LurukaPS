import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
const caches = new WeakMap()
function data(tables) {
    if (caches.has(tables)) return caches.get(tables)
    const unlock = new Map(),
        raw = tables.get('game').find((r) => r.title === 'PET_DNAUNLOCK_NEW')?.value
    ensure(typeof raw === 'string', 'Gene unlock configuration unavailable', ErrorCode.GameConfig)
    for (const token of raw.split('|')) {
        const a = token.split('#').map(Number)
        ensure(
            a.length === 2 &&
                Number.isInteger(a[0]) &&
                a[0] > 0 &&
                Number.isInteger(a[1]) &&
                a[1] >= 0 &&
                !unlock.has(a[0]),
            'Invalid gene unlock configuration',
            ErrorCode.GameConfig,
        )
        unlock.set(...a)
    }
    const result = {
        unlock,
        skills: new Map(tables.get('skill').map((r) => [r.id, r])),
        attrs: new Map(tables.get('skillsub_attrup').map((r) => [r.id, r])),
        battle: new Set(tables.get('battle_info').map((r) => r.attrVal)),
    }
    caches.set(tables, result)
    return result
}
export function numericGeneAttributes(tables, pet) {
    const { unlock, skills, attrs, battle } = data(tables),
        result = new Map()
    ensure(Array.isArray(pet.gene_infos ?? []), 'Invalid saved gene list', ErrorCode.GameConfig)
    for (const gene of pet.gene_infos ?? []) {
        if ((pet.lv ?? 1) < (unlock.get(gene.pos) ?? 0) || skills.get(gene.gene_id)?.skillType !== 2) continue
        // Matches getPetGeneExtraAttr: a missing numeric subtable contributes no
        // attribute. Current edible genes are checked strictly before consumption.
        for (const token of String(attrs.get(gene.gene_id)?.attributeList ?? '')
            .split('|')
            .filter(Boolean)) {
            const a = token.split('#').map(Number)
            ensure(
                a.length === 2 && Number.isInteger(a[0]) && battle.has(a[0]) && Number.isSafeInteger(a[1]),
                'Invalid numeric gene attribute',
                ErrorCode.GeneConfIsNull,
            )
            const total = (result.get(a[0]) ?? 0) + a[1]
            ensure(Number.isSafeInteger(total), 'Numeric gene attribute overflow', ErrorCode.GameConfig)
            result.set(a[0], total)
        }
    }
    return result
}
