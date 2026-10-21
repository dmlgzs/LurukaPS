import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables, seedPlayer } from '../src/player.js'
import { nextHeroRank, taskWorldLevel } from '../src/hero-rank.js'
import { runeBonuses } from '../src/hero-equipment.js'
import { pairs } from '../src/battle.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { grantRewards, parseRewards } from '../src/rewards.js'
import { ErrorCode } from '../src/error-codes.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables)
const ids = (row) => String(row.rankBreakthroughItem).split('|').map(Number)
function fixture(name) {
    const protocol = new Protocol(cfg.base),
        store = new Store(':memory:'),
        game = new Game(protocol, store, tables),
        session = {}
    let seq = 1
    const call = (name, data = {}, who = session) => {
        const e = protocol.byName.get('CSProto' + name)
        const packets = game.dispatch(who, { id: e.id, seq: seq++, payload: protocol.encode(e.req, data) })
        const ack = packets.find((p) => p.id === e.id)
        return { packets, result: protocol.decode(e.rsp, ack.payload) }
    }
    call('EnterGame', { open_id: name })
    const state = () => store.load(session.id).state
    const guid = state().player.heros_info.heros.find((h) => h.conf_id === 107002).guid
    return {
        protocol,
        store,
        call,
        session,
        state,
        guid,
        hero: () => state().player.heros_info.heros.find((h) => h.guid === guid),
    }
}

test('all 23 owned heroes advance through all eleven table transitions, including repeated rune IDs in separate slots', () => {
    const s = seedPlayer(tables, 1, 'rank-catalog')
    for (const h of s.player.heros_info.heros) {
        h.hero_lv = 100
        for (let rank = 1; rank < 12; rank++) {
            const row = tables.get('talent_rank').find((r) => r.heroId === h.conf_id && r.rank === rank)
            h.hero_rank = rank
            h.rune_ids = ids(row)
            const next = nextHeroRank(tables, s, h)
            assert.equal(next.rank, rank + 1)
            assert.equal(next.slots, 5)
            assert(next.costs.length > 0)
        }
        h.hero_rank = 12
        assert.throws(
            () => nextHeroRank(tables, s, h),
            (e) => e.code === ErrorCode.HeroRankUpCheckFailed,
        )
    }
})
test('rank unlock 2009 follows task-unlocked world difficulty rather than selected difficulty', () => {
    const s = seedPlayer(tables, 1, 'rank-world')
    assert.equal(taskWorldLevel(tables, s), 2)
    s.taskRecords = [{ task_id: 991030, count: 1 }]
    assert.equal(taskWorldLevel(tables, s), 3)
    const h = s.player.heros_info.heros.find((h) => h.conf_id === 107002),
        current = tables.get('talent_rank').find((r) => r.heroId === h.conf_id && r.rank === 1),
        next = tables.get('talent_rank').find((r) => r.heroId === h.conf_id && r.rank === 2),
        original = next.condition
    h.rune_ids = ids(current)
    try {
        next.condition = '2009|3'
        s.taskRecords = []
        assert.throws(
            () => nextHeroRank(tables, s, h),
            (e) => e.code === ErrorCode.HeroRankUpCheckFailed,
        )
        s.taskRecords = [{ task_id: 991030, count: 1 }]
        assert.equal(nextHeroRank(tables, s, h).rank, 2)
    } finally {
        next.condition = original
    }
})
test('6017 follows real rune equip, spends current-tier gold, preserves completed bonuses and permits separate 6019 rewards', () => {
    const f = fixture('rank-real-equip')
    try {
        const current = tables.get('talent_rank').find((r) => r.heroId === 107002 && r.rank === 1)
        const runes = ids(current).map((id) => tables.find('talent_rune', id))
        const costs = runes.flatMap((r) => [
            { item_type: 3, item_id: r.runeItem, item_num: 1 },
            ...[...pairs(r.equipRuneCoin)].map(([item_id, item_num]) => ({ item_type: 10, item_id, item_num })),
            { item_type: 10, item_id: 2, item_num: r.equipRuneThroughCoin },
        ])
        f.store.transact(f.session.id, 0, (s) => {
            grantRewards(tables, s, [
                ...costs.map(({ item_type, item_id, item_num }) => ({
                    itemtype: item_type,
                    itemid: item_id,
                    itemnum: item_num,
                })),
                ...parseRewards(current.rankBreakthroughCoin),
            ])
        })
        assert.throws(
            () => f.call('HeroRuneLevelUp', { hero_id: f.guid }),
            (e) => e.code === ErrorCode.HeroRankUpCheckFailed,
        )
        f.call('HeroRuneEquip', { hero_id: f.guid, slot_ids: [0, 1, 2, 3, 4], costItems: costs })
        const before = runeBonuses(tables, f.hero()),
            gold = f.state().player.basic_info.gold
        const { packets, result } = f.call('HeroRuneLevelUp', { hero_id: f.guid })
        assert.equal(f.hero().hero_rank, 2)
        assert.deepEqual(f.hero().rune_ids, [0, 0, 0, 0, 0])
        assert.equal(f.state().player.basic_info.gold, gold - 4000)
        assert.deepEqual(result.atrrs, [
            { attr_id: 1, attr_val: 8 },
            { attr_id: 3, attr_val: 2 },
            { attr_id: 5, attr_val: 40 },
        ])
        const after = runeBonuses(tables, f.hero())
        for (const [id, amount] of pairs(current.attribute))
            assert.equal(after.attrs.get(id), (before.attrs.get(id) ?? 0) + amount)
        assert.deepEqual(after.skills, before.skills)
        const ack = packets.findIndex((p) => p.id === 6017)
        assert(packets.slice(0, ack).some((p) => p.id === f.protocol.byName.get('CSProtoHeroAttrInfoSync').id))
        assert(packets.slice(0, ack).some((p) => p.id === f.protocol.byName.get('CSProtoSyncPlayerData').id))
        const saved = structuredClone(f.state())
        assert.throws(
            () => f.call('HeroRuneLevelUp', { hero_id: f.guid }),
            (e) => e.code === ErrorCode.HeroRankUpCheckFailed,
        )
        assert.deepEqual(f.state(), saved)
        const reward = f.call('HeroRankReward', { hero_id: f.guid, rank_id: 0 }).result
        assert(reward.rewards.length > 0)
        assert.deepEqual(f.call('HeroRankReward', { hero_id: f.guid, rank_id: 0 }).result.rewards, [])
        f.call('EnterGame', { open_id: 'rank-real-equip' }, {})
        assert.equal(f.hero().hero_rank, 2)
        assert.deepEqual(f.hero().rune_ids, [0, 0, 0, 0, 0])
    } finally {
        f.store.close()
    }
})
test('higher rank checks next-tier level and atomically rolls back gold if the table also requires an absent item', () => {
    const f = fixture('rank-item-rollback')
    try {
        const row = tables.get('talent_rank').find((r) => r.heroId === 107002 && r.rank === 6)
        f.store.transact(f.session.id, 0, (s) => {
            const h = s.player.heros_info.heros.find((h) => h.guid === f.guid)
            h.hero_rank = 6
            h.hero_lv = 79
            h.rune_ids = ids(row)
            s.player.basic_info.gold = 100000
        })
        assert.throws(
            () => f.call('HeroRuneLevelUp', { hero_id: f.guid }),
            (e) => e.code === ErrorCode.HeroRankUpCheckFailed,
        )
        f.store.transact(
            f.session.id,
            0,
            (s) => (s.player.heros_info.heros.find((h) => h.guid === f.guid).hero_lv = 80),
        )
        const before = structuredClone(f.state())
        assert.throws(
            () => f.call('HeroRuneLevelUp', { hero_id: f.guid }),
            (e) => e.code === ErrorCode.ItemNotEnough,
        )
        assert.deepEqual(f.state(), before)
        f.store.transact(f.session.id, 0, (s) =>
            grantRewards(tables, s, [{ itemtype: 3, itemid: 1505001, itemnum: 1 }]),
        )
        f.call('HeroRuneLevelUp', { hero_id: f.guid })
        assert.equal(f.hero().hero_rank, 7)
        assert.equal(f.state().player.basic_info.gold, 80000)
        assert.equal(f.state().player.sbag_infos.items.find((i) => i.itemid === 1505001).itemnum, 0)
    } finally {
        f.store.close()
    }
})
test('foreign heroes, incomplete or mismatched slots, malformed data and temporary heroes do not advance', () => {
    const f = fixture('rank-validation')
    try {
        assert.throws(
            () => f.call('HeroRuneLevelUp', { hero_id: '999999' }),
            (e) => e.code === ErrorCode.HeroNotExist,
        )
        for (const values of [[], [1, 2, 4, 5, 999]]) {
            f.store.transact(
                f.session.id,
                0,
                (s) => (s.player.heros_info.heros.find((h) => h.guid === f.guid).rune_ids = values),
            )
            assert.throws(
                () => f.call('HeroRuneLevelUp', { hero_id: f.guid }),
                (e) => e.code === ErrorCode.HeroRankUpCheckFailed,
            )
        }
        f.store.transact(
            f.session.id,
            0,
            (s) => (s.player.heros_info.heros.find((h) => h.guid === f.guid).rune_ids = [-1]),
        )
        assert.throws(
            () => f.call('HeroRuneLevelUp', { hero_id: f.guid }),
            (e) => e.code === ErrorCode.GameConfig,
        )
        f.store.transact(f.session.id, 0, (s) => {
            const hero = s.player.heros_info.heros.find((h) => h.guid === f.guid)
            hero.rune_ids = []
            hero.trail = true
        })
        assert.throws(
            () => f.call('HeroRuneLevelUp', { hero_id: f.guid }),
            (e) => e.code === ErrorCode.HeroNotExist,
        )
    } finally {
        f.store.close()
    }
})
