import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { grantRewards } from '../src/rewards.js'
import { heroModules, pairs } from '../src/battle.js'
import { ornamentSkills } from '../src/hero-equipment.js'
import { ErrorCode } from '../src/error-codes.js'
const cfg = configuration(),
    t = new Tables(cfg.tables),
    p = new Protocol(cfg.base)
test('ornament set skills activate at configured piece counts and disappear below that threshold', () => {
    const set = t
        .get('accessory_set')
        .find((row) => row.skill && t.get('accessory').some((item) => item.setId === row.id))
    const configs = [
        ...new Map(
            t
                .get('accessory')
                .filter((item) => item.setId === set.id)
                .map((item) => [item.type, item]),
        ).values(),
    ]
    const [required, skill] = [...pairs(set.skill)][0]
    const hero = { guid: '1', oguid: Array.from({ length: required }, (_, i) => i + 1) }
    const state = { ornaments: hero.oguid.map((guid, i) => ({ guid, id: configs[i].id, wear_hero: hero.guid })) }
    assert.ok(ornamentSkills(t, state, hero).some((row) => row.skill_id === skill))
    hero.oguid.pop()
    assert.ok(!ornamentSkills(t, state, hero).some((row) => row.skill_id === skill))
})
function fixture(name) {
    const store = new Store(':memory:'),
        game = new Game(p, store, t),
        session = {}
    let seq = 1
    const call = (name, r = {}) => {
        const e = p.byName.get('CSProto' + name)
        return game.dispatch(session, { id: e.id, seq: seq++, payload: p.encode(e.req, r) })
    }
    call('EnterGame', { open_id: name })
    return { store, session, call, state: () => store.load(session.id).state }
}
test('actual four-slot rune request uses rank table costs, aggregates gold, synchronizes bonuses and is replay-safe', () => {
    const f = fixture('rune-equip')
    try {
        let request
        f.store.transact(f.session.id, 0, (s) => {
            const h = s.player.heros_info.heros.find((x) => x.conf_id === 108001)
            const rank = t.get('talent_rank').find((x) => x.heroId === h.conf_id && x.rank === h.hero_rank)
            const runes = String(rank.rankBreakthroughItem)
                .split('|')
                .map(Number)
                .slice(0, 4)
                .map((id) => t.find('talent_rune', id))
            request = {
                hero_id: h.guid,
                slot_ids: [0, 1, 2, 3],
                costItems: runes.flatMap((r) => [
                    { item_type: 3, item_id: r.runeItem, item_num: 1 },
                    ...[...pairs(r.equipRuneCoin)].map(([item_id, item_num]) => ({ item_type: 10, item_id, item_num })),
                    { item_type: 10, item_id: 2, item_num: r.equipRuneThroughCoin },
                ]),
                useGiftItem: false,
            }
            grantRewards(
                t,
                s,
                request.costItems.map((x) => ({ itemtype: x.item_type, itemid: x.item_id, itemnum: x.item_num })),
            )
        })
        const before = f.state().player.basic_info.gold
        const invalid = structuredClone(request)
        invalid.costItems[0].item_num = 2
        assert.throws(() => f.call('HeroRuneEquip', invalid), /costs do not match table/)
        assert.equal(f.state().player.basic_info.gold, before)
        const packets = f.call('HeroRuneEquip', request)
        const reply = p.decode('SCHeroRuneAttrChange', packets.at(-1).payload)
        assert.ok(reply.atrrs.length)
        const h = f.state().player.heros_info.heros.find((x) => x.guid === request.hero_id)
        assert.ok(h.rune_ids.slice(0, 4).every(Boolean))
        assert.equal(f.state().player.basic_info.gold, before - 4000)
        const snapshot = structuredClone(f.state().player)
        f.call('HeroRuneEquip', request)
        assert.deepEqual(f.state().player, snapshot)
        assert.ok(heroModules(t, f.state(), h).modules[0].sub_modules[0].attrs.attrs.length)
    } finally {
        f.store.close()
    }
})

test('rune material compose validates table unlocks and leaf costs without granting free intermediate runes', () => {
    const f = fixture('rune-material-compose')
    try {
        let request
        f.store.transact(f.session.id, 0, (state) => {
            const hero = state.player.heros_info.heros.find((x) => x.conf_id === 108001)
            hero.hero_rank = 2
            const rune = t.find('talent_rune', 8)
            const recipe = t.find('talent_rune_compose', rune.runeItem)
            const [type, id, num] = recipe.items.split('#').map(Number)
            request = {
                hero_id: hero.guid,
                slot_ids: [0],
                useGiftItem: true,
                costItems: [
                    { item_type: type, item_id: id, item_num: num },
                    ...[...pairs(rune.equipRuneCoin)].map(([item_id, item_num]) => ({
                        item_type: 10,
                        item_id,
                        item_num,
                    })),
                    { item_type: 10, item_id: 2, item_num: rune.equipRuneThroughCoin },
                ],
            }
            grantRewards(
                t,
                state,
                request.costItems.map((x) => ({ itemtype: x.item_type, itemid: x.item_id, itemnum: x.item_num })),
            )
        })
        const before = structuredClone(f.state().player)
        assert.throws(() => f.call('HeroRuneEquip', request), /recipe locked/)
        assert.deepEqual(f.state().player, before)
        f.store.transact(f.session.id, 0, (state) => {
            state.entrust = { records: { 1: { entrust_star: 1 } } }
        })
        f.call('HeroRuneEquip', request)
        assert.equal(f.state().player.heros_info.heros.find((x) => x.guid === request.hero_id).rune_ids[0], 8)
        assert.ok(!f.state().player.sbag_infos.items.some((x) => x.itemid === 1531001 && x.itemnum > 0))
        assert.ok(
            f
                .state()
                .player.sbag_infos.items.filter((x) => x.itemid === 1530002)
                .every((x) => x.itemnum === 0),
        )
    } finally {
        f.store.close()
    }
})
test('QuickWear transfers five distinct equipment slots, rejects duplicate slots, and clears the former owner', () => {
    const f = fixture('quick-wear')
    try {
        let request, from
        f.store.transact(f.session.id, 0, (s) => {
            const h = s.player.heros_info.heros.find((x) => x.conf_id === 108002),
                old = s.player.heros_info.heros.find((x) => x.conf_id === 108001)
            from = old.guid
            const ids = []
            for (const type of [1, 2, 3, 4, 5]) {
                const custom = t
                    .get('accessory_customed')
                    .find((x) => t.find('accessory', x.accessoryId)?.type === type && !x.grade)
                const reward = grantRewards(t, s, [{ itemtype: 33, itemid: custom.id, itemnum: 1 }])[0]
                ids.push(Number(reward.guid))
            }
            const soul = s.player.soulessence_infos.soulessences.find((x) => x.id === 10032)
            soul.wear_hero = old.guid
            old.wguid = soul.guid
            old.oguid = [...ids]
            for (const item of s.ornaments) item.wear_hero = old.guid
            request = { hero_guid: h.guid, soulessence_guid: soul.guid, ornament_guids: ids }
        })
        assert.throws(
            () =>
                f.call('QuickWear', {
                    ...request,
                    ornament_guids: [request.ornament_guids[0], request.ornament_guids[0]],
                }),
            /selection/,
        )
        f.call('QuickWear', request)
        const h = f.state().player.heros_info.heros.find((x) => x.guid === request.hero_guid),
            old = f.state().player.heros_info.heros.find((x) => x.guid === from)
        assert.deepEqual(h.oguid, request.ornament_guids)
        assert.equal(old.wguid, 0)
        assert.ok(old.oguid.every((x) => x === 0))
        assert.ok(f.state().ornaments.every((x) => x.wear_hero === h.guid))
        assert.ok(
            heroModules(t, f.state(), h).modules.find((x) => x.module_type === 2).sub_modules[0].attrs.attrs.length,
        )
    } finally {
        f.store.close()
    }
})

test('a batch may equip one owned rune and craft the other from table materials without reusing reserved stock', () => {
    const f = fixture('mixed-rune-compose')
    try {
        let request
        f.store.transact(f.session.id, 0, (state) => {
            const h = state.player.heros_info.heros.find((x) => x.conf_id === 108001)
            h.hero_rank = 2
            const rank = t.get('talent_rank').find((x) => x.heroId === h.conf_id && x.rank === 2)
            const runes = rank.rankBreakthroughItem
                .split('|')
                .slice(0, 2)
                .map((id) => t.find('talent_rune', Number(id)))
            const materials = [{ item_type: 3, item_id: runes[0].runeItem, item_num: 1 }]
            for (const part of t.find('talent_rune_compose', runes[1].runeItem).items.split('|')) {
                const [item_type, item_id, item_num] = part.split('#').map(Number)
                materials.push({ item_type, item_id, item_num })
            }
            for (const rune of runes)
                materials.push(
                    ...[...pairs(rune.equipRuneCoin)].map(([item_id, item_num]) => ({
                        item_type: 10,
                        item_id,
                        item_num,
                    })),
                    { item_type: 10, item_id: 2, item_num: rune.equipRuneThroughCoin },
                )
            request = { hero_id: h.guid, slot_ids: [0, 1], costItems: materials, useGiftItem: true }
            grantRewards(
                t,
                state,
                materials.map((x) => ({ itemtype: x.item_type, itemid: x.item_id, itemnum: x.item_num })),
            )
            state.entrust = { records: Object.fromEntries([1, 2, 3, 4, 5, 6].map((id) => [id, { entrust_star: 3 }])) }
        })
        f.call('HeroRuneEquip', request)
        assert.ok(
            f
                .state()
                .player.heros_info.heros.find((x) => x.guid === request.hero_id)
                .rune_ids.slice(0, 2)
                .every(Boolean),
        )
    } finally {
        f.store.close()
    }
})
test('logged soul XP item consumes the table XP and gold, rejects self/locked fodder, and updates before reward ACK', () => {
    const f = fixture('soul-compose')
    try {
        f.store.transact(f.session.id, 0, (s) =>
            grantRewards(t, s, [
                { itemtype: 3, itemid: 400000, itemnum: 2 },
                { itemtype: 10, itemid: 2, itemnum: 1000 },
            ]),
        )
        const target = f.state().player.soulessence_infos.soulessences.find((x) => x.guid === 10044),
            before = f.state().player.basic_info.gold
        const packets = f.call('ComposeSoulEssence', { guid: 10044, costs: [], cost_items: [{ id: 400000, num: 1 }] })
        const updated = f.state().player.soulessence_infos.soulessences.find((x) => x.guid === 10044)
        assert.equal(
            t
                .get('soulessence_level')
                .find((x) => x.rarity === t.find('soulessence', updated.id).rarity && x.lv === updated.lv).exp_all +
                updated.exp,
            t
                .get('soulessence_level')
                .find((x) => x.rarity === t.find('soulessence', target.id).rarity && x.lv === target.lv).exp_all +
                target.exp +
                100,
        )
        assert.equal(f.state().player.basic_info.gold, before - 20)
        assert.equal(packets.at(-1).id, 6047)
        assert.ok(packets.slice(0, -1).some((x) => x.id === p.byName.get('CSProtoSyncPlayerData').id))
        assert.throws(() => f.call('ComposeSoulEssence', { guid: 10044, costs: [10044] }), /self soul/)
        assert.throws(
            () => f.call('ComposeSoulEssence', { guid: 10044, costs: [10001] }),
            (error) => error.code === ErrorCode.SoulEssenceCostLock,
        )
        f.store.transact(f.session.id, 0, (state) => {
            state.player.soulessence_infos.soulessences.find((x) => x.guid === 10001).lock = false
        })
        const consumed = f.call('ComposeSoulEssence', { guid: 10044, costs: [10001] })
        assert.ok(!f.state().player.soulessence_infos.soulessences.some((x) => x.guid === 10001))
        assert.ok(
            consumed
                .filter((x) => x.id === p.byName.get('CSProtoSyncPlayerData').id)
                .some((x) => p.decode('PlayerData', x.payload).soulessence_infos?.del_pos?.includes(10001)),
        )
        const beforeBad = structuredClone(f.state().player)
        assert.throws(
            () => f.call('ComposeSoulEssence', { guid: 10044, cost_items: [{ id: 306000, num: 1 }] }),
            /experience item/,
        )
        assert.deepEqual(f.state().player, beforeBad)
    } finally {
        f.store.close()
    }
})

test('equipment ownership, missing configuration, lock/wear and level cap have distinct native errors and roll back', () => {
    const f = fixture('equipment-error-codes')
    const fail = (name, request, code) => {
        const before = structuredClone(f.state().player)
        assert.throws(
            () => f.call(name, request),
            (error) => error.code === code,
        )
        assert.deepEqual(f.state().player, before)
    }
    try {
        const h = f.state().player.heros_info.heros.find((x) => x.conf_id === 108001)
        fail('QuickWear', { hero_guid: '1' }, ErrorCode.HeroNotExist)
        fail('QuickWear', { hero_guid: h.guid, ornament_guids: [0xffffffff] }, ErrorCode.OrnamentNotExist)
        fail('QuickWear', { hero_guid: h.guid, soulessence_guid: 0xffffffff }, ErrorCode.SoulEssenceNotExist)
        fail('HeroRuneEquip', { hero_id: h.guid, slot_ids: [99] }, ErrorCode.HeroSlotIdNotExist)
        fail('ComposeSoulEssence', { guid: 0xffffffff, costs: [10001] }, ErrorCode.SoulEssenceNotExist)
        fail('ComposeSoulEssence', { guid: 10044, costs: [0xffffffff] }, ErrorCode.SoulEssenceCostNotEnough)
        fail('ComposeSoulEssence', { guid: 10044, costs: [10001] }, ErrorCode.SoulEssenceCostLock)
        f.store.transact(f.session.id, 0, (state) => {
            const source = state.player.soulessence_infos.soulessences.find((x) => x.guid === 10001)
            source.lock = false
            source.wear_hero = h.guid
        })
        fail('ComposeSoulEssence', { guid: 10044, costs: [10001] }, ErrorCode.WearSoulEssence)
        f.store.transact(f.session.id, 0, (state) => {
            const source = state.player.soulessence_infos.soulessences.find((x) => x.guid === 10001)
            source.wear_hero = '0'
            source.id = 0xffffffff
        })
        fail('ComposeSoulEssence', { guid: 10044, costs: [10001] }, ErrorCode.SoulEssenceCostConfNot)
        f.store.transact(f.session.id, 0, (state) => {
            const target = state.player.soulessence_infos.soulessences.find((x) => x.guid === 10044)
            const rank = t.get('soulessence_rank').find((x) => x.relatedId === target.id && x.rank === target.rank)
            target.lv = rank.rankLevelLimit
        })
        fail('ComposeSoulEssence', { guid: 10044, cost_items: [{ id: 400000, num: 1 }] }, ErrorCode.SoulEssenceNoConfig)
    } finally {
        f.store.close()
    }
})

test('quick wear preserves native profession priority semantics without inventing a profession equip ban', () => {
    const f = fixture('quick-wear-profession-priority')
    try {
        const h = f.state().player.heros_info.heros.find((x) => x.conf_id === 108002)
        const profession = t.find('hero', h.conf_id).position
        const soul = f.state().player.soulessence_infos.soulessences.find((x) => {
            const cfg = t.find('soulessence', x.id)
            return cfg.validProfession && cfg.validProfession !== profession
        })
        assert.ok(soul)
        f.call('QuickWear', { hero_guid: h.guid, soulessence_guid: soul.guid })
        assert.equal(f.state().player.heros_info.heros.find((x) => x.guid === h.guid).wguid, soul.guid)
    } finally {
        f.store.close()
    }
})
