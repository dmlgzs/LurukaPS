import { heroTrialOrnaments } from './trial-equipment.js'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { pairs } from './battle.js'
import { ornamentValueTables } from './ornament-values.js'
import { ornamentEntryEffects } from './ornament-entry-effects.js'

export function runeSkillPairs(text) {
    return new Map(
        String(text || '')
            .split('|')
            .filter(Boolean)
            .map((token) => {
                const [slot, level, ...extra] = token.split('#').map(Number)
                ensure(
                    !extra.length && Number.isInteger(slot) && slot >= 0 && Number.isInteger(level) && level > 0,
                    'Invalid rune skill bonus',
                    ErrorCode.GameConfig,
                )
                return [slot, level]
            }),
    )
}
const rankIndices = new WeakMap(),
    mainIndices = new WeakMap()
function ranksFor(tables, heroId) {
    let index = rankIndices.get(tables)
    if (!index) {
        index = new Map()
        for (const row of tables.get('talent_rank')) {
            if (!index.has(row.heroId)) index.set(row.heroId, [])
            index.get(row.heroId).push(row)
        }
        rankIndices.set(tables, index)
    }
    return index.get(heroId) ?? []
}
function mainsFor(tables, group, level) {
    let index = mainIndices.get(tables)
    if (!index) {
        index = new Map()
        for (const row of tables.get('accessory_main')) {
            const key = row.groupId + ':' + row.level
            if (!index.has(key)) index.set(key, [])
            index.get(key).push(row)
        }
        mainIndices.set(tables, index)
    }
    return index.get(group + ':' + level) ?? []
}
export function currentRunes(tables, hero) {
    const rank = ranksFor(tables, hero.conf_id).find((x) => x.rank === hero.hero_rank)
    ensure(rank, 'Hero talent rank unavailable', ErrorCode.HeroRankConfNotExist)
    const ids = String(rank.rankBreakthroughItem ?? '')
        .split('|')
        .filter(Boolean)
        .map(Number)
    ensure(
        ids.length && ids.every((id) => Number.isInteger(id) && id > 0),
        'Invalid hero rune configuration',
        ErrorCode.GameConfig,
    )
    return ids.map((id) => {
        const rune = tables.find('talent_rune', id)
        ensure(rune, 'Hero rune unavailable', ErrorCode.RuneBreakItemInvilid)
        return rune
    })
}
export function runeBonuses(tables, hero) {
    const attrs = new Map(),
        skills = new Map()
    const ranks = ranksFor(tables, hero.conf_id).filter((x) => x.rank <= hero.hero_rank)
    for (const rank of ranks) {
        // L_HeroManager.getHeroStarGiftByHeroIdAndRank includes each completed
        // rank's flat attributes as well as its runes; current rank is pending.
        if (rank.rank < hero.hero_rank)
            for (const [id, n] of pairs(rank.attribute)) attrs.set(id, (attrs.get(id) ?? 0) + n)
        const ids = String(rank.rankBreakthroughItem).split('|').map(Number)
        for (let slot = 0; slot < ids.length; slot++) {
            if (rank.rank === hero.hero_rank && !hero.rune_ids?.[slot]) continue
            const rune = tables.find('talent_rune', ids[slot])
            ensure(rune, 'Hero rune unavailable', ErrorCode.RuneBreakItemInvilid)
            for (const [id, n] of pairs(rune.runeAttribute)) attrs.set(id, (attrs.get(id) ?? 0) + n)
            for (const [slot, n] of runeSkillPairs(rune.runeSkill)) skills.set(slot, (skills.get(slot) ?? 0) + n)
        }
    }
    return { attrs, skills }
}
function wornOrnaments(tables, state, hero) {
    const trial = heroTrialOrnaments(tables, hero)
    if (trial) return trial
    return (hero.oguid ?? []).filter(Boolean).map((guid) => {
        const item = state.ornaments?.find((x) => x.guid === guid && x.wear_hero === hero.guid)
        ensure(item, 'Equipped ornament missing', ErrorCode.OrnamentNotExist)
        return item
    })
}
export function ornamentAttributes(tables, state, hero) {
    const external = tables
    tables = ornamentValueTables(tables)
    const attrs = new Map()
    const worn = wornOrnaments(external, state, hero)
    for (const item of worn) {
        const cfg = tables.find('accessory', item.id)
        ensure(cfg, 'Ornament configuration unavailable', ErrorCode.OrnamentConfFail)
        const mains = mainsFor(tables, cfg.mainAttr, item.lv)
        ensure(mains.length, 'Ornament main attributes unavailable', ErrorCode.OrnamentConfFail)
        const quality = item.quality ? tables.find('accessory_quality', item.quality)?.value : 0
        ensure(quality !== undefined, 'Ornament quality unavailable', ErrorCode.OrnamentConfFail)
        for (const row of mains) {
            const id = Number(String(row.battleInfo).split('|')[0])
            ensure(Number.isInteger(id) && id > 0, 'Ornament battle attribute unavailable', ErrorCode.GameConfig)
            const value = Math.trunc(row.value * (1 + quality / 10000))
            attrs.set(id, (attrs.get(id) ?? 0) + value)
        }
        for (const row of item.infos ?? []) {
            // OrnamentSecondAttr.key is the attribute ID, val its actual roll.
            ensure(row.key > 0 && Number.isFinite(row.val), 'Invalid ornament sub attribute', ErrorCode.GameConfig)
            attrs.set(row.key, (attrs.get(row.key) ?? 0) + row.val)
        }
    }
    for (const [id, value] of ornamentEntryEffects(external, worn).attrs) attrs.set(id, (attrs.get(id) ?? 0) + value)
    return attrs
}

export function ornamentSkills(tables, state, hero) {
    const counts = new Map(),
        skills = new Set()
    const worn = wornOrnaments(tables, state, hero)
    for (const item of worn) {
        const setId = tables.find('accessory', item.id)?.setId
        if (setId) counts.set(setId, (counts.get(setId) ?? 0) + 1)
    }
    for (const skill of ornamentEntryEffects(tables, worn).skills) skills.add(skill.skill_id)
    for (const [id, count] of counts) {
        const row = tables.find('accessory_set', id)
        ensure(row, 'Ornament set unavailable', ErrorCode.OrnamentConfFail)
        for (const [required, skill] of pairs(row.skill)) if (count >= required) skills.add(skill)
    }
    return [...skills].map((skill_id) => ({ skill_id, skill_lv: 1, skill_slot: 0, type: 0 }))
}
