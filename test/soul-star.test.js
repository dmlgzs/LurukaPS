import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables, seedPlayer } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { grantRewards } from '../src/rewards.js'
import { soulEssenceValue } from '../src/soul-values.js'
import { planSoulStar } from '../src/soul-star.js'
import { pairs } from '../src/battle.js'
import { ErrorCode } from '../src/error-codes.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables)
function fixture(name, id = 10044) {
    const store = new Store(':memory:'),
        protocol = new Protocol(cfg.base),
        game = new Game(protocol, store, tables),
        session = {}
    let seq = 1
    const call = (name, data = {}, who = session) => {
        const e = protocol.byName.get('CSProto' + name)
        const packets = game.dispatch(who, { id: e.id, seq: seq++, payload: protocol.encode(e.req, data) })
        return { packets, result: protocol.decode(e.rsp, packets.find((p) => p.id === e.id).payload) }
    }
    call('EnterGame', { open_id: name })
    const state = () => store.load(session.id).state
    return {
        store,
        session,
        protocol,
        call,
        state,
        id,
        target: () => state().player.soulessence_infos.soulessences.find((s) => s.guid === id),
    }
}
test('current numeric overrides support all 75 templates at all 100 levels without changing external names', () => {
    for (const config of tables.get('soulessence')) {
        const name = config.name,
            original = config.attribute
        for (let level = 1; level <= 100; level++) {
            const value = soulEssenceValue(tables, config, level)
            assert(value, `${config.id}:${level}`)
            assert(pairs(value.baseAttribute).size > 0)
        }
        assert.equal(config.name, name)
        assert.equal(config.attribute, original)
    }
    const moved = soulEssenceValue(tables, tables.find('soulessence', 10001), 1),
        changed = soulEssenceValue(tables, tables.find('soulessence', 10238), 1)
    assert.equal(moved.id, 10001001)
    assert.equal(pairs(moved.baseAttribute).get(5), 309)
    assert.equal(pairs(moved.baseAttribute).get(230), 27)
    assert.equal(pairs(changed.baseAttribute).get(5), 408)
    assert.equal(pairs(changed.baseAttribute).get(230), 34)
})
test('every soul template supports the actual one-based star contributions and caps at table maximum', () => {
    const s = seedPlayer(tables, 1, 'all-soul-stars')
    for (const target of [...s.player.soulessence_infos.soulessences]) {
        const fodder = { ...target, guid: target.guid + 1000000, lock: false, wear_hero: '0', advance: 1 }
        s.player.soulessence_infos.soulessences.push(fodder)
        for (let advance = 1; advance < 5; advance++) {
            target.advance = advance
            const plan = planSoulStar(tables, s, { guid: target.guid, guids: [fodder.guid] })
            assert.equal(plan.advance, advance + 1)
            assert.equal(plan.surplus, 0)
        }
        target.advance = 5
        assert.throws(
            () => planSoulStar(tables, s, { guid: target.guid, guids: [fodder.guid] }),
            (e) => e.code === ErrorCode.SoulEssenceStartMax,
        )
        s.player.soulessence_infos.soulessences.pop()
    }
})
test('6050 follows batch-unlock then consumes same-name copies, preserves target XP and publishes worn skills before ACK', () => {
    const f = fixture('soul-star-copies')
    try {
        let fodders, heroGuid
        f.store.transact(f.session.id, 0, (s) => {
            fodders = grantRewards(tables, s, [{ itemtype: 9, itemid: 10044, itemnum: 2 }]).map((r) => Number(r.guid))
            const hero = s.player.heros_info.heros.find((h) => h.conf_id === 107002),
                target = s.player.soulessence_infos.soulessences.find((i) => i.guid === 10044)
            heroGuid = hero.guid
            hero.wguid = target.guid
            target.wear_hero = hero.guid
            target.exp = 77
            const upgraded = s.player.soulessence_infos.soulessences.find((i) => i.guid === fodders[1])
            upgraded.advance = 2
            upgraded.lv = 10
            upgraded.exp = 200
        })
        const before = structuredClone(f.state())
        assert.throws(
            () => f.call('RisingStarSoulEssence', { guid: 10044, guids: fodders }),
            (e) => e.code === ErrorCode.SoulEssenceCostLock,
        )
        assert.deepEqual(f.state(), before)
        f.call('SetLockSoulEssence', { guids: fodders, lock: false })
        const targetBefore = structuredClone(f.target()),
            gold = f.state().player.basic_info.gold
        const { packets, result } = f.call('RisingStarSoulEssence', { guid: 10044, guids: fodders })
        assert.deepEqual(result.rewards, [])
        assert.deepEqual(f.target(), { ...targetBefore, advance: 4 }) // 1 + 1 + 2 copies.
        assert.equal(f.state().player.basic_info.gold, gold)
        assert(!f.state().player.soulessence_infos.soulessences.some((i) => fodders.includes(i.guid)))
        const ack = packets.findIndex((p) => p.id === 6050),
            syncId = f.protocol.byName.get('CSProtoSyncPlayerData').id
        const snapshots = packets
            .slice(0, ack)
            .filter((p) => p.id === syncId)
            .map((p) => f.protocol.decode(f.protocol.byId.get(syncId).rsp, p.payload))
        assert(
            snapshots.some((p) => p.soulessence_infos?.soulessences.some((i) => i.guid === 10044 && i.advance === 4)),
        )
        const removed = new Set(snapshots.flatMap((p) => p.soulessence_infos?.del_pos ?? []))
        assert(fodders.every((id) => removed.has(id)))
        const battleId = f.protocol.byName.get('CSProtoHeroAttrInfoSync').id
        const battle = packets
            .slice(0, ack)
            .filter((p) => p.id === battleId)
            .map((p) => f.protocol.decode(f.protocol.byId.get(battleId).rsp, p.payload))
        const worn = battle.flatMap((p) => p.heros).find((h) => h.hero_guid === heroGuid)
        assert(
            worn.modules
                .find((m) => m.module_type === 1)
                .sub_modules[0].skills.skills.some((s) => s.skill_id === 1900550 && s.skill_lv === 4),
        )
        const saved = structuredClone(f.state())
        assert.throws(
            () => f.call('RisingStarSoulEssence', { guid: 10044, guids: fodders }),
            (e) => e.code === ErrorCode.SoulEssenceCostNotEnough,
        )
        assert.deepEqual(f.state(), saved)
        f.call('EnterGame', { open_id: 'soul-star-copies' }, {})
        assert.equal(f.target().advance, 4)
        assert.equal(f.target().exp, 77)
    } finally {
        f.store.close()
    }
})
test('specific star items aggregate with instance contributions and shortages leave all selected copies intact', () => {
    const f = fixture('soul-star-items', 10032)
    try {
        let guid
        f.store.transact(f.session.id, 0, (s) => {
            guid = Number(grantRewards(tables, s, [{ itemtype: 9, itemid: 10032, itemnum: 1 }])[0].guid)
            s.player.soulessence_infos.soulessences.find((i) => i.guid === guid).lock = false
        })
        const request = {
            guid: 10032,
            guids: [guid],
            cost_items: [
                { id: 605085, num: 1 },
                { id: 605085, num: 1 },
            ],
        }
        const before = structuredClone(f.state())
        assert.throws(
            () => f.call('RisingStarSoulEssence', request),
            (e) => e.code === ErrorCode.ItemNotEnough,
        )
        assert.deepEqual(f.state(), before)
        f.store.transact(f.session.id, 0, (s) => grantRewards(tables, s, [{ itemtype: 3, itemid: 605085, itemnum: 2 }]))
        f.call('RisingStarSoulEssence', request)
        assert.equal(f.target().advance, 4)
        assert.equal(f.state().player.sbag_infos.items.find((i) => i.itemid === 605085).itemnum, 0)
        assert(!f.state().player.soulessence_infos.soulessences.some((i) => i.guid === guid))
    } finally {
        f.store.close()
    }
})
test('over-cap selections use the documented capped-consumption policy and never fabricate compensation', () => {
    const f = fixture('soul-star-overflow')
    try {
        let guid
        f.store.transact(f.session.id, 0, (s) => {
            s.player.soulessence_infos.soulessences.find((i) => i.guid === 10044).advance = 4
            guid = Number(grantRewards(tables, s, [{ itemtype: 9, itemid: 10044, itemnum: 1 }])[0].guid)
            const item = s.player.soulessence_infos.soulessences.find((i) => i.guid === guid)
            item.advance = 3
            item.lock = false
        })
        assert.equal(planSoulStar(tables, f.state(), { guid: 10044, guids: [guid] }).surplus, 2)
        const { result } = f.call('RisingStarSoulEssence', { guid: 10044, guids: [guid] })
        assert.equal(f.target().advance, 5)
        assert.deepEqual(result.rewards, [])
        assert(!f.state().player.soulessence_infos.soulessences.some((i) => i.guid === guid))
    } finally {
        f.store.close()
    }
})
test('invalid, equipped, mismatched, locked and preview materials fail with native errors and cannot bypass locks', () => {
    const f = fixture('soul-star-invalid')
    try {
        let guid
        f.store.transact(f.session.id, 0, (s) => {
            guid = Number(grantRewards(tables, s, [{ itemtype: 9, itemid: 10044, itemnum: 1 }])[0].guid)
            s.player.soulessence_infos.soulessences.find((i) => i.guid === guid).lock = false
        })
        const claim = (r) => f.call('RisingStarSoulEssence', { guid: 10044, ...r })
        assert.throws(
            () => claim({}),
            (e) => e.code === ErrorCode.SoulEssenceAdvNoCost,
        )
        assert.throws(
            () => claim({ guid: 999999, guids: [guid] }),
            (e) => e.code === ErrorCode.SoulEssenceNotExist,
        )
        assert.throws(
            () => claim({ guids: [10044] }),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
        assert.throws(
            () => claim({ guids: [guid, guid] }),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
        assert.throws(
            () => claim({ guids: [10001] }),
            (e) => e.code === ErrorCode.SoulEssenceIdErr,
        )
        assert.throws(
            () => claim({ cost_items: [{ id: 605085, num: 1 }] }),
            (e) => e.code === ErrorCode.SoulEssenceStarNotItem,
        )
        assert.throws(
            () => claim({ guids: [guid], use_unlock: true }),
            (e) => e.code === ErrorCode.FunctionClosed,
        )
        assert.throws(
            () => claim({ item_num: 1 }),
            (e) => e.code === ErrorCode.FunctionClosed,
        )
        f.store.transact(f.session.id, 0, (s) => (s.player.heros_info.heros[0].wguid = guid))
        assert.throws(
            () => claim({ guids: [guid] }),
            (e) => e.code === ErrorCode.WearSoulEssence,
        )
        f.store.transact(f.session.id, 0, (s) => {
            s.player.heros_info.heros[0].wguid = 0
            s.player.soulessence_infos.soulessences.find((i) => i.guid === guid).zombie = true
        })
        assert.throws(
            () => claim({ guids: [guid] }),
            (e) => e.code === ErrorCode.SoulEssenceComCostEmpty,
        )
    } finally {
        f.store.close()
    }
})
