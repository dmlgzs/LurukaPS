import { ErrorCode } from '../error-codes.js'
import { ensure, syncPlayer } from './common.js'
import { spend, spendCurrency } from '../inventory.js'
import { pairs, syncBattle } from '../battle.js'
import { currentRunes, runeSkillPairs } from '../hero-equipment.js'
import { parseRewards, grantRewards } from '../rewards.js'
import { rewardSource } from '../reward-source.js'
import { heroSkillUpgrade } from '../hero-skill-upgrades.js'
import { nextHeroGrade } from '../hero-grade.js'
import { nextHeroRank } from '../hero-rank.js'
import { nextSoulRank } from '../soul-rank.js'
import { planSoulStar } from '../soul-star.js'
import { soulDecomposePlan } from '../soul-decompose.js'
import { nextOrnamentLevel } from '../ornament-upgrade.js'

function ownedHero(state, id) {
    const result = state.player.heros_info.heros.find((item) => item.guid === String(id))
    ensure(result, 'Hero not owned', ErrorCode.HeroNotExist)
    return result
}
function counts(rows, fields) {
    const result = new Map()
    for (const row of rows) {
        const [type, id, num] = fields.map((f) => row[f])
        ensure(
            [3, 10].includes(type) && Number.isInteger(id) && id > 0 && Number.isSafeInteger(num) && num > 0,
            'Invalid equipment cost',
        )
        const key = `${type}:${id}`
        result.set(key, (result.get(key) ?? 0) + num)
    }
    return result
}
const canonical = (map) => JSON.stringify([...map].sort(([a], [b]) => a.localeCompare(b)))

function composedRuneCosts(c, itemIds, reserved = new Map()) {
    const used = new Map(reserved),
        visiting = new Set(),
        costs = []
    const recipes = new Map(c.tables.get('talent_rune_compose').map((row) => [row.id, row]))
    const expand = (id, amount, root = false) => {
        ensure(
            Number.isSafeInteger(amount) && amount > 0 && amount <= 0xffffffff,
            'Rune material overflow',
            ErrorCode.RuneCalcTimesLimit,
        )
        const owned =
            c.state.player.sbag_infos.items
                .filter((x) => x.itemid === id && (!x.deadtime || x.deadtime > c.now))
                .reduce((total, x) => total + x.itemnum, 0) - (used.get(id) ?? 0)
        // Matches the client's material-compose DFS: the requested top item
        // is crafted; intermediate items can come from the existing bag.
        const take = root ? 0 : Math.min(Math.max(0, owned), amount)
        if (take) {
            used.set(id, (used.get(id) ?? 0) + take)
            costs.push({ type: 3, id, num: take })
        }
        if (take === amount) return
        const recipe = recipes.get(id)
        ensure(recipe, 'Rune material recipe unavailable', ErrorCode.RuneComConfNotFound)
        ensure(
            !visiting.has(id) && visiting.size < 32,
            'Rune material recipe cyclic or too deep',
            ErrorCode.RuneCalcTimesLimit,
        )
        for (const condition of String(recipe.condition || '')
            .split('|')
            .filter(Boolean)) {
            const [kind, a, b] = condition.split('#').map(Number)
            ensure(
                [13044, 2004, 2007].includes(kind),
                'Rune material unlock condition is not supported',
                ErrorCode.InvalidLogic,
            )
            const unlocked =
                kind === 13044
                    ? (c.state.entrust?.records?.[a]?.entrust_star ?? 0) >= b
                    : kind === 2004
                      ? c.state.player.basic_info.lv >= a
                      : kind === 2007
                        ? c.state.taskRecords.some((x) => x.task_id === a && x.count > 0)
                        : false
            ensure(unlocked, 'Rune material recipe locked', ErrorCode.RuneConditionLimit)
        }
        visiting.add(id)
        const parts = parseRewards(recipe.items)
        ensure(parts.length, 'Empty rune material recipe', ErrorCode.GameConfig)
        for (const part of parts) {
            const num = part.itemnum * (amount - take)
            if (part.itemtype === 3 && recipes.has(part.itemid)) expand(part.itemid, num)
            else costs.push({ type: part.itemtype, id: part.itemid, num })
        }
        visiting.delete(id)
    }
    for (const id of itemIds) expand(id, 1, true)
    return costs
}

export function registerHeroEquipment(on, publishEquipment) {
    on('DecomposeSoulEssence', (c, r) => {
        const plan = soulDecomposePlan(c.tables, c.state, r.guids ?? [])
        c.state.player.soulessence_infos.soulessences = c.state.player.soulessence_infos.soulessences.filter(
            (item) => !plan.selected.has(item.guid),
        )
        const rewards = grantRewards(c.tables, c.state, plan.rewards)
        syncPlayer(
            { ...c, push: c.pushBefore },
            { soulessence_infos: { soulessences: [], del_pos: [...plan.selected] } },
        )
        return { rewards, src: rewardSource(c.tables, 'soulDecompose') }
    })
    on('RisingStarSoulEssence', (c, r) => {
        const plan = planSoulStar(c.tables, c.state, r)
        spend(c.state, plan.costs, 0, c.now)
        c.state.player.soulessence_infos.soulessences = c.state.player.soulessence_infos.soulessences.filter(
            (item) => !plan.consumed.has(item.guid),
        )
        plan.target.advance = plan.advance
        const before = { ...c, push: c.pushBefore }
        syncPlayer(before, { soulessence_infos: { soulessences: [plan.target], del_pos: [...plan.consumed] } })
        syncBattle(before)
        return { rewards: [] }
    })
    on('RankUpSoulEssence', (c, r) => {
        const item = c.state.player.soulessence_infos.soulessences.find((item) => item.guid === r.guid)
        ensure(item, 'Soul essence is not owned', ErrorCode.SoulEssenceNotExist)
        const next = nextSoulRank(c.tables, c.state, item)
        spend(c.state, next.costs, next.gold, c.now)
        item.rank = next.rank
        const before = { ...c, push: c.pushBefore }
        syncPlayer(before, { soulessence_infos: { soulessences: [item] } })
        syncBattle(before)
        return {}
    })
    on('HeroRuneLevelUp', (c, r) => {
        const hero = ownedHero(c.state, r.hero_id)
        ensure(!hero.trail, 'Temporary hero cannot permanently advance rank', ErrorCode.HeroNotExist)
        const next = nextHeroRank(c.tables, c.state, hero),
            bag = new Map()
        for (const cost of next.costs) {
            if (cost.itemtype === 3) bag.set(cost.itemid, (bag.get(cost.itemid) ?? 0) + cost.itemnum)
            else spendCurrency(c.state, cost.itemid, cost.itemnum)
        }
        spend(c.state, bag, 0, c.now)
        hero.hero_rank = next.rank
        hero.rune_ids = Array(next.slots).fill(0)
        syncPlayer({ ...c, push: c.pushBefore }, { heros_info: { heros: [hero] } })
        syncBattle({ ...c, push: c.pushBefore })
        return { atrrs: next.attrs, skills: [] }
    })
    on('GradeUpHero', (c, r) => {
        const hero = ownedHero(c.state, r.u64)
        ensure(!hero.trail, 'Temporary hero cannot be permanently upgraded', ErrorCode.HeroNotExist)
        const next = nextHeroGrade(c.tables, hero)
        spend(c.state, next.costs, 0, c.now)
        const rewards = grantRewards(c.tables, c.state, parseRewards(next.reward))
        hero.hero_grade = next.grade
        const before = { ...c, push: c.pushBefore }
        syncPlayer(before, { heros_info: { heros: [hero] } })
        syncBattle(before)
        return { rewards, src: rewardSource(c.tables, 'heroGradeUpgrade') }
    })
    on('LvUpSkill', (c, r) => {
        const hero = ownedHero(c.state, r.hero_id)
        ensure(!hero.trail, 'Temporary hero skills cannot be permanently upgraded', ErrorCode.HeroNotExist)
        // heroTpl.getSkillIndex returns i-1, and ReqUpgradeHeroSkill places
        // that index in CSLvUpSkill.skill_id despite the field's name.
        const upgrade = heroSkillUpgrade(c.tables, hero, r.skill_id ?? 0),
            bag = new Map()
        for (const cost of upgrade.costs) {
            if (cost.itemtype === 3) bag.set(cost.itemid, (bag.get(cost.itemid) ?? 0) + cost.itemnum)
            else spendCurrency(c.state, cost.itemid, cost.itemnum)
        }
        spend(c.state, bag, upgrade.gold, c.now)
        upgrade.levels[upgrade.slot] = upgrade.nextLevel
        hero.system_skill_levels = upgrade.levels
        syncPlayer({ ...c, push: c.pushBefore }, { heros_info: { heros: [hero] } })
        syncBattle({ ...c, push: c.pushBefore })
        return {}
    })
    on('HeroRankReward', (c, r) => {
        const hero = ownedHero(c.state, r.hero_id)
        ensure(!hero.trail, 'Temporary hero cannot claim rank rewards', ErrorCode.HeroNotExist)
        const rows = c.tables
            .get('talent_rank_reward')
            .slice()
            .sort((a, b) => a.level - b.level)
        ensure(rows.length, 'Hero rank reward configuration unavailable', ErrorCode.HeroRankRewardConfNone)
        ensure(
            rows.every((row) => Number.isInteger(row.level) && row.level > 0 && row.level < 64) &&
                new Set(rows.map((row) => row.level)).size === rows.length,
            'Invalid hero rank reward levels',
            ErrorCode.GameConfig,
        )
        ensure(Number.isInteger(hero.hero_rank) && hero.hero_rank >= 1, 'Invalid saved hero rank', ErrorCode.GameConfig)
        const raw = hero.hero_rank_reward ?? '0'
        ensure(
            (typeof raw === 'string' || (typeof raw === 'number' && Number.isSafeInteger(raw))) &&
                /^\d+$/.test(String(raw)) &&
                BigInt(raw) <= 0xffffffffffffffffn,
            'Invalid saved hero rank receipts',
            ErrorCode.GameConfig,
        )
        let mask = BigInt(raw)
        const requested = r.rank_id ?? 0
        const target = requested ? rows.find((row) => row.level === requested) : null
        ensure(!requested || target, 'Hero rank reward configuration unavailable', ErrorCode.HeroRankRewardConfNone)
        ensure(!target || hero.hero_rank >= target.level, 'Hero has not reached this rank reward')
        // The Lua bulk action sends rank_id=0 and checks rankReward's bit at
        // reward.level. Never use a JS 32-bit shift or a reward-table row ID.
        const fresh = (target ? [target] : rows).filter(
            (row) => hero.hero_rank >= row.level && !(mask & (1n << BigInt(row.level))),
        )
        const rewards = grantRewards(
            c.tables,
            c.state,
            fresh.flatMap((row) => parseRewards(row.item)),
        )
        for (const row of fresh) mask |= 1n << BigInt(row.level)
        hero.hero_rank_reward = String(mask)
        syncPlayer({ ...c, push: c.pushBefore }, { heros_info: { heros: [hero] } })
        return { rewards, ...(rewards.length ? { src: rewardSource(c.tables, 'heroRankReward') } : {}) }
    })
    on('ComposeRune', (c, r) => {
        ensure(Number.isInteger(r.num) && r.num >= 1 && r.num <= 999, 'Invalid rune compose count')
        ensure(
            c.tables.find('talent_rune_compose', r.item_id),
            'Rune material recipe unavailable',
            ErrorCode.RuneComConfNotFound,
        )
        ensure(c.tables.find('common_item', r.item_id), 'Rune item configuration unavailable', ErrorCode.GameConfig)
        // runeStore.bCanCompose always crafts the root and consumes existing
        // intermediate items before recursively crafting its missing materials.
        const expanded = composedRuneCosts(c, Array(r.num).fill(r.item_id))
        ensure(
            expanded.every((row) => [3, 10].includes(row.type)),
            'Invalid rune material resource',
            ErrorCode.GameConfig,
        )
        const required = counts(expanded, ['type', 'id', 'num'])
        if (r.costItems?.length)
            ensure(
                canonical(counts(r.costItems, ['item_type', 'item_id', 'item_num'])) === canonical(required),
                'Rune compose costs do not match table',
            )
        const bag = new Map()
        for (const [key, num] of required) {
            ensure(
                Number.isSafeInteger(num) && num > 0 && num <= 0xffffffff,
                'Rune cost overflow',
                ErrorCode.RuneCalcTimesLimit,
            )
            const [type, id] = key.split(':').map(Number)
            if (type === 3) {
                const have = c.state.player.sbag_infos.items
                    .filter((item) => item.itemid === id && (!item.deadtime || item.deadtime > c.now))
                    .reduce((total, item) => total + item.itemnum, 0)
                ensure(have >= num, 'Rune base materials are insufficient', ErrorCode.RuneBaseMaterialLimt)
                bag.set(id, num)
            } else spendCurrency(c.state, id, num)
        }
        spend(c.state, bag, 0, c.now)
        const rewards = grantRewards(c.tables, c.state, [{ itemtype: 3, itemid: r.item_id, itemnum: r.num }])
        // equip is a UI continuation: the caller subsequently sends HeroRuneEquip.
        // No verified reason_itemnum_change entry exists for this operation.
        return { rewards: { rewards, src: rewardSource(c.tables, 'runeCompose') }, equip: r.equip ?? false }
    })
    const publishOrnaments = (c) => {
        c.state.ornamentRevision = (c.state.ornamentRevision ?? 0) + 1
        c.pushBefore('CSProtoUpdateOrnament', { ornaments: c.state.ornaments ?? [], guid: [] })
        publishEquipment({ ...c, push: c.pushBefore })
    }
    on('UpgradeOrnament', (c, r) => {
        const item = c.state.ornaments?.find((item) => item.guid === r.u32)
        ensure(item, 'Ornament not owned', ErrorCode.OrnamentNotExist)
        const plan = nextOrnamentLevel(c.tables, item),
            bag = new Map(),
            currency = new Map()
        for (const cost of plan.costs) {
            const target = cost.itemtype === 3 ? bag : currency
            const total = (target.get(cost.itemid) ?? 0) + cost.itemnum
            ensure(
                Number.isSafeInteger(total) && total <= 0xffffffff,
                'Ornament upgrade cost overflow',
                ErrorCode.GameConfig,
            )
            target.set(cost.itemid, total)
        }
        spend(c.state, bag, 0, c.now)
        for (const [id, amount] of currency) spendCurrency(c.state, id, amount)
        item.lv = plan.level
        publishOrnaments(c)
        return {}
    })
    on('MoveOrnament', (c, r) => {
        const hero = ownedHero(c.state, r.hero_id)
        const item = c.state.ornaments?.find((entry) => entry.guid === r.ornament_guid)
        ensure(item, 'Ornament not owned', ErrorCode.OrnamentNotExist)
        const config = c.tables.find('accessory', item.id)
        ensure(config, 'Ornament configuration unavailable', ErrorCode.OrnamentConfFail)
        ensure(
            Number.isInteger(config.type) && config.type >= 1 && config.type <= 5,
            'Invalid ornament slot configuration',
            ErrorCode.GameConfig,
        )
        const slot = config.type - 1
        // Both directions must be changed: HeroInfo.oguid and Ornament.wear_hero.
        for (const other of c.state.player.heros_info.heros) {
            if (other.oguid) other.oguid = other.oguid.map((guid) => (guid === item.guid ? 0 : guid))
        }
        hero.oguid ??= Array(5).fill(0)
        while (hero.oguid.length < 5) hero.oguid.push(0)
        const previous = c.state.ornaments.find((entry) => entry.guid === hero.oguid[slot])
        if (previous) previous.wear_hero = '0'
        hero.oguid[slot] = item.guid
        item.wear_hero = hero.guid
        publishOrnaments(c)
        return {}
    })
    on('SetLockOrnament', (c, r) => {
        const item = c.state.ornaments?.find((entry) => entry.guid === r.guid)
        ensure(item, 'Ornament not owned', ErrorCode.OrnamentNotExist)
        item.lock = r.lock ?? false
        c.state.ornamentRevision = (c.state.ornamentRevision ?? 0) + 1
        c.pushBefore('CSProtoUpdateOrnament', { ornaments: [item], guid: [] })
        return {}
    })
    on('RemoveOrnament', (c, r) => {
        const hero = ownedHero(c.state, r.hero_id)
        ensure(
            r.remove_all || (Number.isInteger(r.type) && r.type >= 1 && r.type <= 5),
            'Invalid ornament removal slot',
        )
        const current = hero.oguid ?? Array(5).fill(0)
        ensure(current.length <= 5, 'Invalid equipped ornament slots', ErrorCode.GameConfig)
        const slots = r.remove_all ? [0, 1, 2, 3, 4] : [r.type - 1]
        const removed = slots
            .filter((slot) => current[slot])
            .map((slot) => {
                const item = c.state.ornaments?.find((entry) => entry.guid === current[slot])
                ensure(item, 'Equipped ornament missing', ErrorCode.OrnamentNotExist)
                ensure(item.wear_hero === hero.guid, 'Equipped ornament owner mismatch', ErrorCode.GameConfig)
                return item
            })
        hero.oguid = Array.from({ length: 5 }, (_, slot) => (slots.includes(slot) ? 0 : (current[slot] ?? 0)))
        for (const item of removed) item.wear_hero = '0'
        publishOrnaments(c)
        return {}
    })
    on('QuickWear', (c, r) => {
        const h = ownedHero(c.state, r.hero_guid),
            ids = r.ornament_guids ?? []
        ensure(ids.length <= 5 && new Set(ids).size === ids.length, 'Invalid quick equipment selection')
        const selected = ids.map((guid) => {
            const item = c.state.ornaments?.find((x) => x.guid === guid)
            ensure(item, 'Ornament not owned', ErrorCode.OrnamentNotExist)
            const cfg = c.tables.find('accessory', item.id)
            ensure(cfg, 'Ornament configuration unavailable', ErrorCode.OrnamentConfFail)
            ensure(Number.isInteger(cfg.type), 'Invalid ornament slot configuration', ErrorCode.GameConfig)
            ensure(cfg.type >= 1 && cfg.type <= 5, 'Invalid ornament slot', ErrorCode.InvalidArgument)
            return { item, slot: cfg.type - 1 }
        })
        ensure(new Set(selected.map((x) => x.slot)).size === selected.length, 'Duplicate ornament slots')
        const souls = c.state.player.soulessence_infos.soulessences
        const soul = r.soulessence_guid ? souls.find((x) => x.guid === r.soulessence_guid) : null
        ensure(!r.soulessence_guid || soul, 'Soul essence not owned', ErrorCode.SoulEssenceNotExist)
        if (soul) {
            const cfg = c.tables.find('soulessence', soul.id),
                hc = c.tables.find('hero', h.conf_id)
            ensure(cfg, 'Soul essence configuration unavailable', ErrorCode.SoulEssenceConfNotExist)
            ensure(hc, 'Hero configuration unavailable', ErrorCode.HeroNotExist)
            // The native quick list sorts by profession; it is not a wear ban.
            // Keep ownership transfer consistent with MoveSoulEssence.
            for (const other of c.state.player.heros_info.heros) if (other.wguid === soul.guid) other.wguid = 0
            for (const old of souls) if (old.wear_hero === h.guid) old.wear_hero = '0'
            h.wguid = soul.guid
            soul.wear_hero = h.guid
        }
        h.oguid ??= Array(5).fill(0)
        for (const { item, slot } of selected) {
            for (const other of c.state.player.heros_info.heros)
                if (other.oguid) other.oguid = other.oguid.map((guid) => (guid === item.guid ? 0 : guid))
            const old = c.state.ornaments.find((x) => x.guid === h.oguid[slot])
            if (old) old.wear_hero = '0'
            h.oguid[slot] = item.guid
            item.wear_hero = h.guid
        }
        c.pushBefore('CSProtoUpdateOrnament', { ornaments: c.state.ornaments ?? [], guid: [] })
        publishEquipment({ ...c, push: c.pushBefore })
        return {}
    })
    on('HeroRuneEquip', (c, r) => {
        const h = ownedHero(c.state, r.hero_id),
            runes = currentRunes(c.tables, h),
            slots = r.slot_ids ?? []
        ensure(
            slots.length && slots.length <= runes.length && new Set(slots).size === slots.length,
            'Invalid rune slots',
        )
        ensure(
            slots.every((slot) => Number.isInteger(slot) && slot >= 0 && slot < runes.length && runes[slot]),
            'Unknown rune slot',
            ErrorCode.HeroSlotIdNotExist,
        )
        h.rune_ids ??= Array(runes.length).fill(0)
        const fresh = slots.filter((slot) => !h.rune_ids[slot])
        if (!fresh.length) return { atrrs: [], skills: [] }
        const expected = [],
            attrs = new Map(),
            skills = new Map()
        for (const slot of fresh) {
            const rune = runes[slot]
            expected.push({ type: 3, id: rune.runeItem, num: 1 })
            for (const [id, num] of pairs(rune.equipRuneCoin)) expected.push({ type: 10, id, num })
            if (rune.equipRuneThroughCoin) expected.push({ type: 10, id: 2, num: rune.equipRuneThroughCoin })
            for (const cost of parseRewards(rune.equipRuneCost))
                expected.push({ type: cost.itemtype, id: cost.itemid, num: cost.itemnum })
            for (const [id, num] of pairs(rune.runeAttribute)) attrs.set(id, (attrs.get(id) ?? 0) + num)
            for (const [id, num] of runeSkillPairs(rune.runeSkill)) skills.set(id, (skills.get(id) ?? 0) + num)
        }
        ensure(
            expected.every((row) => [3, 10].includes(row.type)),
            'Rune cost resource type is not supported',
            ErrorCode.InvalidLogic,
        )
        const actual = counts(r.costItems ?? [], ['item_type', 'item_id', 'item_num'])
        let required = counts(expected, ['type', 'id', 'num'])
        if (r.useGiftItem && canonical(actual) !== canonical(required)) {
            const selected = fresh.map((slot) => runes[slot].runeItem)
            const directCosts = expected.filter((row) => row.type !== 3 || !selected.includes(row.id))
            const remaining = [],
                supplied = [],
                reserved = new Map()
            for (const id of selected) {
                const direct = actual.get('3:' + id) ?? 0
                if ((reserved.get(id) ?? 0) < direct) {
                    reserved.set(id, (reserved.get(id) ?? 0) + 1)
                    supplied.push({ type: 3, id, num: 1 })
                } else remaining.push(id)
            }
            const expanded = [...directCosts, ...supplied, ...composedRuneCosts(c, remaining, reserved)]
            ensure(
                expanded.every((row) => [3, 10].includes(row.type)),
                'Rune material resource type is not supported',
                ErrorCode.InvalidLogic,
            )
            required = counts(expanded, ['type', 'id', 'num'])
        }
        ensure(canonical(actual) === canonical(required), 'Rune costs do not match table')
        const bag = new Map()
        for (const [key, num] of required) {
            const [type, id] = key.split(':').map(Number)
            if (type === 3) bag.set(id, num)
            else spendCurrency(c.state, id, num)
        }
        spend(c.state, bag, 0, c.now)
        for (const slot of fresh) h.rune_ids[slot] = runes[slot].id
        syncPlayer({ ...c, push: c.pushBefore })
        syncBattle({ ...c, push: c.pushBefore })
        const system = String(c.tables.find('hero', h.conf_id).skillSystem).split('|').map(Number)
        return {
            atrrs: [...attrs].map(([attr_id, attr_val]) => ({ attr_id, attr_val })),
            skills: [...skills].map(([slot, add_level]) => ({ skill_id: system[slot], add_level })),
        }
    })
    on('ComposeSoulEssence', (c, r) => {
        ensure((r.cost_items ?? []).length <= 100 && (r.costs ?? []).length <= 100, 'Too many soul materials')
        const all = c.state.player.soulessence_infos.soulessences,
            target = all.find((x) => x.guid === r.guid)
        ensure(target, 'Soul essence not owned', ErrorCode.SoulEssenceNotExist)
        const cfg = c.tables.find('soulessence', target.id)
        ensure(cfg, 'Soul essence configuration unavailable', ErrorCode.SoulEssenceConfNotExist)
        const levels = c.tables
            .get('soulessence_level')
            .filter((row) => row.rarity === cfg.rarity)
            .sort((a, b) => a.lv - b.lv)
        const current = levels.find((row) => row.lv === target.lv)
        const rank = c.tables
            .get('soulessence_rank')
            .find((row) => row.relatedId === target.id && row.rank === target.rank)
        ensure(current, 'Soul level unavailable', ErrorCode.SoulEssenceComCostSame)
        ensure(rank, 'Soul rank unavailable', ErrorCode.SoulEssenceHadNotRank)
        ensure(
            Number.isInteger(rank.rankLevelLimit) && rank.rankLevelLimit > 0,
            'Invalid soul rank level cap',
            ErrorCode.GameConfig,
        )
        ensure(
            Number.isSafeInteger(current.exp_all) &&
                current.exp_all >= 0 &&
                Number.isSafeInteger(target.exp) &&
                target.exp >= 0,
            'Invalid saved soul experience',
            ErrorCode.GameConfig,
        )
        const cap = Math.min(rank.rankLevelLimit, levels.at(-1).lv)
        ensure(target.lv < cap, 'Soul essence level cap reached', ErrorCode.SoulEssenceNoConfig)
        const setting = (name) => {
            const value = c.tables.get('game').find((row) => row.title === name)?.value
            ensure(
                value !== undefined && value !== null,
                'Missing soul experience setting ' + name,
                ErrorCode.GameConfig,
            )
            return value
        }
        const allowed = new Set(String(setting('SOULESSENCE_EXP_ITEM')).split('|').map(Number))
        const ratio = Number(setting('SOULESSENCE_EXP_RATIO')) / 10000
        const goldRatio = Number(setting('WEAPON_LEVELUP_GOLD')) / 10000
        ensure(
            [...allowed].every((id) => Number.isInteger(id) && id > 0) &&
                Number.isFinite(ratio) &&
                ratio >= 0 &&
                Number.isFinite(goldRatio) &&
                goldRatio >= 0,
            'Invalid soul experience settings',
            ErrorCode.GameConfig,
        )
        const bag = new Map(),
            used = new Set()
        let added = 0,
            gold = 0
        for (const line of r.cost_items ?? []) {
            ensure(allowed.has(line.id) && Number.isInteger(line.num) && line.num > 0, 'Invalid soul experience item')
            const exp = Number(c.tables.find('common_item', line.id)?.useFunction)
            ensure(Number.isInteger(exp) && exp > 0, 'Soul experience item value unavailable', ErrorCode.GameConfig)
            bag.set(line.id, (bag.get(line.id) ?? 0) + line.num)
            added += exp * line.num
            gold += Math.trunc(exp * goldRatio) * line.num
        }
        for (const guid of r.costs ?? []) {
            ensure(guid !== target.guid && !used.has(guid), 'Duplicate or self soul material')
            const item = all.find((row) => row.guid === guid)
            ensure(item, 'Soul material not owned', ErrorCode.SoulEssenceCostNotEnough)
            ensure(!item.lock, 'Soul material locked', ErrorCode.SoulEssenceCostLock)
            ensure(!item.wear_hero || item.wear_hero === '0', 'Soul material equipped', ErrorCode.WearSoulEssence)
            ensure(!item.zombie, 'Soul material is a preview', ErrorCode.SoulEssenceComCostEmpty)
            const source = c.tables.find('soulessence', item.id)
            ensure(source, 'Soul material configuration unavailable', ErrorCode.SoulEssenceCostConfNot)
            const row = c.tables
                .get('soulessence_level')
                .find((level) => level.rarity === source.rarity && level.lv === item.lv)
            ensure(row, 'Soul material level unavailable', ErrorCode.SoulEssenceComCostSame)
            ensure(
                Number.isSafeInteger(source.reishiExp) &&
                    source.reishiExp >= 0 &&
                    Number.isSafeInteger(row.exp_all) &&
                    row.exp_all >= 0 &&
                    Number.isSafeInteger(item.exp) &&
                    item.exp >= 0,
                'Invalid soul material experience',
                ErrorCode.GameConfig,
            )
            const exp = source.reishiExp + Math.trunc((row.exp_all + item.exp) * ratio)
            ensure(exp > 0, 'Soul material has no experience', ErrorCode.SoulEssenceComCostEmpty)
            added += exp
            gold += Math.trunc(source.reishiExp * goldRatio)
            used.add(guid)
        }
        ensure(Number.isSafeInteger(added) && added > 0 && Number.isSafeInteger(gold), 'Invalid soul experience total')
        spend(c.state, bag, gold, c.now)
        c.state.player.soulessence_infos.soulessences = all.filter((x) => !used.has(x.guid))
        const total = current.exp_all + target.exp + added
        const next = levels.filter((x) => x.lv <= cap && x.exp_all <= total).at(-1)
        target.lv = next.lv
        // Retain excess XP at the rank cap instead of silently discarding paid materials.
        target.exp = total - next.exp_all
        ensure(Number.isSafeInteger(target.exp) && target.exp <= 0xffffffff, 'Soul experience overflow')
        syncPlayer(
            { ...c, push: c.pushBefore },
            {
                ...c.state.player,
                soulessence_infos: { ...c.state.player.soulessence_infos, del_pos: [...used] },
            },
        )
        syncBattle({ ...c, push: c.pushBefore })
        return { rewards: [] }
    })
}
