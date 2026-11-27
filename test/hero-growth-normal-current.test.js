import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { parseRewards } from '../src/rewards.js'
import { pairs } from '../src/battle.js'

const identities = (rows) => rows.map(({ itemtype, itemid, itemnum }) => ({ itemtype, itemid, itemnum }))

// Current typed output-cache model, not an executed Unity entity or animation.
class HeroConsumer {
    heroes = new Map()
    modules = new Map()
    managers = new Map()
    consume(f, packets) {
        for (const p of packets) {
            const e = f.protocol.byId.get(p.id),
                v = e.rsp ? f.protocol.decode(e.rsp, p.payload) : {},
                player = p.id === 5001 ? v.data : p.id === 5008 ? v : null
            for (const h of player?.heros_info?.heros ?? [])
                this.heroes.set(h.guid, { ...this.heroes.get(h.guid), ...h })
            for (const m of player?.group_mgrs ?? []) {
                const old = this.managers.get(m.type) ?? {},
                    groups = new Map((old.groups ?? []).map((g) => [g.id, g]))
                for (const g of m.groups ?? []) groups.set(g.id, { ...groups.get(g.id), ...g })
                this.managers.set(m.type, { ...old, ...m, groups: [...groups.values()] })
            }
            if (p.id === 10006)
                for (const h of v.heros ?? []) {
                    const modules = this.modules.get(h.hero_guid) ?? new Map()
                    for (const m of h.modules ?? []) modules.set(m.module_type, m)
                    this.modules.set(h.hero_guid, modules)
                }
        }
    }
    control() {
        const m = this.managers.get(1)
        return m?.groups.find((g) => g.id === m.cur_group)?.control
    }
}

test('normal actual level/rune/rank/skill/grade/gift/reward requests preserve current formation attributes, ownership and cold receipts', () => {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base),
        store = new Store(':memory:')
    let session = {},
        seq = 1,
        packets = []
    const game = new Game(protocol, store, tables, { clock: () => 1800000000, gmEnabled: true }),
        client = new HeroConsumer()
    const frame = (name, data = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return { id: e.id, seq: seq++, payload: e.req ? protocol.encode(e.req, data) : Buffer.alloc(0) }
    }
    const dispatch = (r) => {
        packets = game.dispatch(session, r)
        client.consume({ protocol }, packets)
        const e = protocol.byId.get(r.id)
        return e.rsp ? protocol.decode(e.rsp, packets.find((p) => p.id === r.id).payload) : undefined
    }
    const call = (name, data) => dispatch(frame(name, data)),
        state = () => store.load(session.id).state,
        gm = (command) => call('GMCommand', { command: Buffer.from(command).toString('base64') }),
        grant = (r) => gm(`give ${r.itemtype} ${r.itemid} ${r.itemnum}`),
        count = (id) =>
            state()
                .player.sbag_infos.items.filter((r) => r.itemid === id)
                .reduce((n, r) => n + r.itemnum, 0)
    try {
        call('EnterGame', { open_id: 'hero-growth-normal-public' })
        assert.equal(state().starterProfile.mode, 'normal')
        assert.equal(state().player.sbag_infos.items.length, 0)
        assert.equal(state().player.soulessence_infos.soulessences.length, 0)
        assert.equal(state().pets.length, 0)
        // Explicit qualified story/UI checkpoint only. No personal favor,
        // levels, rank, grade, rune slots or reward receipts are supplied.
        store.transact(session.id, 0, (s) => {
            s.tasks = []
            s.taskRecords = [{ task_id: 106010, count: 1 }]
        })
        call('EnterHome', { creator_id: session.id })
        gm('give 1 107002 1')
        const actor = () => state().player.heros_info.heros.find((h) => h.conf_id === 107002 && !h.trail),
            guid = actor().guid
        assert.equal(BigInt(guid) >> 56n, 1n)
        assert.equal(BigInt(guid) & 0xffffffffn, BigInt(state().player.basic_info.id))
        const manager = state().player.group_mgrs.find((m) => m.type === 1)
        call('QuickChangeGroupInfo', { type: 1, id: manager.cur_group, infos: [{ hero_guid: guid, pet_guid: '0' }] })
        assert.equal(client.control(), guid)
        const beforeModule = structuredClone(client.modules.get(guid).get(0))
        gm('level 20')
        gm('gold 10000')
        gm('item 400003 1')
        const material = tables.find('common_item', 400003),
            gold = state().player.basic_info.gold,
            ratio = Number(tables.get('game').find((r) => r.title === 'HERO_LEVELUP_GOLD').value)
        call('LvUpHero', { hero_id: guid, items: [{ item_id: material.id, item_num: 1 }] })
        assert.equal(count(material.id), 0)
        assert.equal(
            state().player.basic_info.gold,
            gold - Number((BigInt(material.useFunction) * BigInt(ratio)) / 10000n),
        )
        assert.equal(client.heroes.get(guid).hero_lv, actor().hero_lv)
        assert(actor().hero_lv >= 20)
        assert.notDeepEqual(client.modules.get(guid).get(0), beforeModule)
        assert.equal(client.control(), guid)
        const rank = tables
                .get('talent_rank')
                .find((r) => r.heroId === actor().conf_id && r.rank === actor().hero_rank),
            ids = rank.rankBreakthroughItem.split('|').map(Number)
        const costs = ids.flatMap((id) => {
            const rune = tables.find('talent_rune', id)
            return [
                { item_type: 3, item_id: rune.runeItem, item_num: 1 },
                ...[...pairs(rune.equipRuneCoin)].map(([item_id, item_num]) => ({ item_type: 10, item_id, item_num })),
                { item_type: 10, item_id: 2, item_num: rune.equipRuneThroughCoin },
            ]
        })
        const unfunded = store.load(session.id)
        assert.throws(() => call('HeroRuneEquip', { hero_id: guid, slot_ids: ids.map((_, i) => i), costItems: costs }))
        assert.deepEqual(store.load(session.id), unfunded)
        for (const c of costs) grant({ itemtype: c.item_type, itemid: c.item_id, itemnum: c.item_num })
        for (const c of parseRewards(rank.rankBreakthroughCoin)) grant(c)
        call('HeroRuneEquip', { hero_id: guid, slot_ids: ids.map((_, i) => i), costItems: costs })
        assert.deepEqual(actor().rune_ids, ids)
        call('HeroRuneLevelUp', { hero_id: guid })
        assert.equal(actor().hero_rank, rank.rank + 1)
        assert(actor().rune_ids.every((id) => id === 0))
        assert.equal(client.heroes.get(guid).hero_rank, actor().hero_rank)
        assert.equal(client.control(), guid)
        const claim = call('HeroRankReward', { hero_id: guid, rank_id: 0 }),
            earned = tables.get('talent_rank_reward').filter((r) => r.level <= actor().hero_rank)
        assert.deepEqual(
            identities(claim.rewards),
            earned.flatMap((r) => parseRewards(r.item)),
        )
        assert.deepEqual(call('HeroRankReward', { hero_id: guid, rank_id: 0 }).rewards, [])
        const system = tables.find('hero', actor().conf_id).skillSystem.split('|').map(Number),
            skillRow = tables.get('skill_level').find((r) => r.skillId === system[0] && r.level === 1)
        for (const c of parseRewards(skillRow.item)) grant(c)
        if (skillRow.gold) grant({ itemtype: 10, itemid: 2, itemnum: skillRow.gold })
        call('LvUpSkill', { hero_id: guid, skill_id: 0 })
        assert.equal(actor().system_skill_levels[0], 2)
        const skills = client.modules
            .get(guid)
            .get(0)
            .sub_modules.flatMap((m) => m.skills?.skills ?? [])
        const completedRuneBonus = ids
            .flatMap((id) => String(tables.find('talent_rune', id).runeSkill).split('|').filter(Boolean))
            .map((token) => token.split('#').map(Number))
            .filter(([slot]) => slot === 0)
            .reduce((n, [, level]) => n + level, 0)
        assert.equal(
            skills.find((s) => s.skill_id === system[0]).skill_lv,
            actor().system_skill_levels[0] + completedRuneBonus,
        )
        const gradeCosts = tables
            .find('hero', actor().conf_id)
            .gradeUpItem.split('|')
            .slice(0, 3)
            .map((s) => s.split('#').map(Number))
        for (const [id, num] of gradeCosts) grant({ itemtype: 3, itemid: id, itemnum: num })
        const request = frame('GradeUpHero', { u64: guid }),
            ready = store.load(session.id),
            encode = protocol.encode
        protocol.encode = function (name, value) {
            if (name === protocol.byId.get(6055).rsp) throw Error('hero-grade-current-codec')
            return encode.call(this, name, value)
        }
        try {
            assert.throws(() => dispatch(request), /hero-grade-current-codec/)
        } finally {
            protocol.encode = encode
        }
        assert.deepEqual(store.load(session.id), ready)
        store.db.exec(
            "CREATE TRIGGER hero_grade_abort BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'hero-grade-current-sql'); END",
        )
        try {
            assert.throws(() => dispatch(request), /hero-grade-current-sql/)
        } finally {
            store.db.exec('DROP TRIGGER hero_grade_abort')
        }
        assert.deepEqual(store.load(session.id), ready)
        dispatch(request)
        call('GradeUpHero', { u64: guid })
        call('GradeUpHero', { u64: guid })
        assert.equal(actor().hero_grade, 3)
        assert.equal(actor().hero_star, 0, 'current star UI uses heroGrade, not the unused legacy field')
        assert.equal(client.heroes.get(guid).hero_grade, 3)
        assert(
            client.modules
                .get(guid)
                .get(10)
                .sub_modules.some((m) => m.attrs?.attrs.length > 0),
        )
        assert.equal(client.control(), guid)
        const gift = tables
                .get('hero_favorability_gift')
                .filter(
                    (r) =>
                        tables.find('common_item', r.id)?.type === 110 &&
                        String(r.favourHero).split('|').map(Number).includes(actor().conf_id),
                )
                .sort((a, b) => b.favourValue - a.favourValue)[0],
            value = gift.favourValue,
            threshold = tables
                .get('hero_favorability_exp')
                .find((r) => r.favorabilityLevel === actor().favorability_lv).favorabilityExp,
            num = Math.ceil(threshold / value)
        assert(num <= Number(tables.get('game').find((r) => r.title === 'HERO_FAVORABILITY_GIFT_NUM').value))
        grant({ itemtype: 3, itemid: gift.id, itemnum: num })
        const oldFavor = actor().favorability_lv
        call('SendHeroGift', {
            heroId: actor().conf_id,
            item_id: gift.id,
            item_type: tables.find('common_item', gift.id).type,
            num,
        })
        assert.equal(count(gift.id), 0)
        assert(actor().favorability_lv > oldFavor)
        assert.equal(actor().daily_gift_num, num)
        assert.equal(client.heroes.get(guid).favorability_lv, actor().favorability_lv)
        const pending = actor().store_favor_rewards.map((id) => tables.find('hero_favorability_info', id))
        assert(pending.length > 0)
        assert.deepEqual(
            identities(call('GotFavorReward', { u64: guid }).rewards),
            pending.flatMap((r) => parseRewards(r.reward)),
        )
        assert.deepEqual(actor().store_favor_rewards, [])
        assert.deepEqual(call('GotFavorReward', { u64: guid }).rewards, [])
        const saved = structuredClone(actor())
        session = {}
        call('EnterGame', { open_id: 'hero-growth-normal-public' })
        // Existing syncDormResidents derives the unset optional pointer as0
        // on login. Preserve every progression/receipt/asset field exactly.
        assert.deepEqual(actor(), { ...saved, dorm_id: saved.dorm_id ?? 0 })
        assert.equal(client.control(), guid)
        assert.equal(client.heroes.get(guid).hero_grade, 3)
    } finally {
        store.close()
    }
})
