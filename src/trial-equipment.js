import trialPolicy from '../configs/trial-equipment-policy.json' with { type: 'json' }
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { soulEssenceValue } from './soul-values.js'
export function trialSoulEssence(tables, interim) {
    const text = String(interim?.soulessence ?? '')
    if (!text || text === '0') return null
    const parts = text.split('|').map(Number),
        [id, grade, level] = parts
    ensure(
        parts.length === 3 && parts.every(Number.isSafeInteger) && id > 0 && grade >= 0 && level > 0,
        'Invalid trial soul essence configuration',
        ErrorCode.GameConfig,
    )
    const soul = tables.find('soulessence', id)
    ensure(
        soul && soulEssenceValue(tables, soul, level),
        'Trial soul essence attributes unavailable',
        ErrorCode.SoulEssenceConfNotExist,
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
        ErrorCode.GameConfig,
    )
    return { id, lv: level, advance: grade + 1, rank: rank.rank }
}
export function heroTrialSoulEssence(tables, hero) {
    if (!hero.trail || BigInt(hero.guid) >> 56n !== 5n) return null
    const id = Number((BigInt(hero.guid) >> 32n) & 0xffffffn)
    return trialSoulEssence(tables, tables.find('hero_interim', id))
}

// Trial ornaments are derived from the interim catalogue, never added to the
// owned bag. Current CBT3 getPackAtt ignores legacy interim group/infos fields:
// it reads accessoryId + level + quality, and evaluates current grade entries.
export function trialOrnaments(tables, interim) {
    const text = String(interim?.accessorySet ?? '')
    if (!text || text === '0') return []
    const ids = text.split('|').map(Number)
    ensure(
        ids.every((id) => Number.isSafeInteger(id) && id > 0) && new Set(ids).size === ids.length,
        'Invalid trial ornament configuration',
        ErrorCode.GameConfig,
    )
    return ids.map((id) => {
        const row = tables.find('accessory_interim', id)
        ensure(
            row && tables.find('accessory', row.accessoryid),
            'Trial ornament configuration unavailable',
            ErrorCode.OrnamentConfFail,
        )
        ensure(Number.isSafeInteger(row.level) && row.level >= 0, 'Invalid trial ornament level', ErrorCode.GameConfig)
        return { id: row.accessoryid, lv: row.level, quality: 0, grade: 0, infos: [] }
    })
}
export function heroTrialOrnaments(tables, hero) {
    if (!hero.trail || BigInt(hero.guid) >> 56n !== 5n) return null
    const id = Number((BigInt(hero.guid) >> 32n) & 0xffffffn)
    return trialOrnaments(tables, tables.find('hero_interim', id))
}

// TODO(CBT3 trial talents): flag1's official meaning is server-side and remains
// unproved by current client consumers. This explicit local compatibility mode
// lights only the current table rank; runeBonuses already includes lower ranks.
// Set talentRunePolicy to closed to reject that unverified compatibility.
export function trialRuneIds(tables, interim, heroConfigId = interim.heroId, policy = trialPolicy.talentRunePolicy) {
    if (!interim.talentrune) return []
    ensure(interim.talentrune === 1, 'Trial talent mode not implemented', ErrorCode.FunctionClosed)
    ensure(
        policy === 'all_available_at_trial_rank' || policy === 'closed',
        'Invalid trial talent policy',
        ErrorCode.GameConfig,
    )
    ensure(policy !== 'closed', 'Trial talent compatibility disabled', ErrorCode.FunctionClosed)
    const rank = tables.get('talent_rank').find((row) => row.heroId === heroConfigId && row.rank === interim.rank)
    ensure(rank, 'Trial hero talent rank unavailable', ErrorCode.HeroRankConfNotExist)
    const ids = String(rank.rankBreakthroughItem ?? '')
        .split('|')
        .map(Number)
    ensure(
        ids.length > 0 && ids.every((id) => Number.isSafeInteger(id) && id > 0),
        'Invalid trial talent rune configuration',
        ErrorCode.GameConfig,
    )
    for (const id of ids)
        ensure(tables.find('talent_rune', id), 'Trial rune unavailable', ErrorCode.RuneBreakItemInvilid)
    // Duplicate IDs are distinct rank slots and must not be deduplicated.
    return ids
}
