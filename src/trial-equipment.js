import { ensure } from './handlers/common.js'
export function trialSoulEssence(tables, interim) {
    const text = String(interim?.soulessence ?? '')
    if (!text || text === '0') return null
    const parts = text.split('|').map(Number),
        [id, grade, level] = parts
    ensure(
        parts.length === 3 && parts.every(Number.isSafeInteger) && id > 0 && grade >= 0 && level > 0,
        'Invalid trial soul essence configuration',
        1007,
    )
    const soul = tables.find('soulessence', id)
    ensure(
        soul && tables.find('soulessence_value', soul.attribute * 1000 + level),
        'Trial soul essence attributes unavailable',
        1007,
    )
    // Interim triples have no breakthrough rank. Use the first table rank whose
    // level limit permits the configured level; keep this compatibility choice documented.
    const rank = tables
        .get('soulessence_rank')
        .filter((r) => r.relatedId === id && r.rankLevelLimit >= level)
        .sort((a, b) => a.rank - b.rank)[0]
    ensure(
        rank && tables.get('soulessence_grade').some((r) => r.soulessenceId === id && r.grade === grade),
        'Trial soul essence rank or grade unavailable',
        1007,
    )
    return { id, lv: level, advance: grade + 1, rank: rank.rank }
}
export function heroTrialSoulEssence(tables, hero) {
    if (!hero.trail || BigInt(hero.guid) >> 56n !== 5n) return null
    const id = Number((BigInt(hero.guid) >> 32n) & 0xffffffn)
    return trialSoulEssence(tables, tables.find('hero_interim', id))
}
