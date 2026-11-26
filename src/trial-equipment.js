import trialPolicy from '../configs/trial-equipment-policy.json' with { type: 'json' }
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { soulEssenceValue } from './soul-values.js'
import { ornamentEntryEffects } from './ornament-entry-effects.js'
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

// Current TDHeroInterim.GetAccessorySet (06023b81) reads each entry as
// accessory configId # level # grade # quality, with omitted tail fields zero.
// These are virtual base-accessory items, never accessory_interim IDs or owned
// inventory grants. getAccessoryListAttDic_trial (0602970d) preserves all four
// values and creates an empty infos list.
export function trialOrnaments(tables, interim) {
    const text = String(interim?.accessorySet ?? '')
    if (!text || text === '0') return []
    const ids = new Set()
    const items = text.split('|').map((token) => {
        const parts = token.split('#')
        ensure(
            parts.length >= 1 &&
                parts.length <= 4 &&
                parts.every(
                    (part) =>
                        /^(0|[1-9]\d*)$/.test(part) && Number.isSafeInteger(Number(part)) && Number(part) <= 0xffffffff,
                ),
            'Invalid trial ornament tuple',
            ErrorCode.GameConfig,
        )
        const [id, level = 0, grade = 0, quality = 0] = parts.map(Number)
        ensure(id > 0 && !ids.has(id), 'Duplicate or invalid trial ornament identity', ErrorCode.GameConfig)
        ids.add(id)
        const config = tables.find('accessory', id)
        ensure(config, 'Trial ornament configuration unavailable', ErrorCode.OrnamentConfFail)
        const mains = tables
            .get('accessory_main')
            .filter((row) => row.groupId === config.mainAttr && row.level === level)
        ensure(mains.length > 0, 'Trial ornament level attributes unavailable', ErrorCode.OrnamentConfFail)
        ensure(
            mains.every(
                (row) =>
                    Number.isFinite(row.value) &&
                    Number.isSafeInteger(Number(String(row.battleInfo).split('|')[0])) &&
                    Number(String(row.battleInfo).split('|')[0]) > 0,
            ),
            'Invalid trial ornament main attributes',
            ErrorCode.GameConfig,
        )
        ensure(
            quality === 0 || Number.isFinite(tables.find('accessory_quality', quality)?.value),
            'Trial ornament quality unavailable',
            ErrorCode.OrnamentConfFail,
        )
        ensure(
            grade === 0 ||
                tables.get('accessory_upgrade').some((row) => row.rarity === config.rarity && row.grade === grade),
            'Trial ornament star is not configured',
            ErrorCode.GameConfig,
        )
        return { id, lv: level, grade, quality, infos: [] }
    })
    // Validate configured grade entries and any battle skills before accepting
    // the temporary actor; the shared equipment projection later consumes them.
    ornamentEntryEffects(tables, items)
    return items
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
