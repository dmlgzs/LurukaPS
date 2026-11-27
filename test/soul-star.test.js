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
    call('GMCommands', {
        cmds: [`give 9 ${id} 1`, 'give 1 107002 1'].map((command) => ({
            command: Buffer.from(command).toString('base64'),
        })),
    })
    const targetGuid = store
        .load(session.id)
        .state.player.soulessence_infos.soulessences.find((item) => item.id === id).guid
    const state = () => store.load(session.id).state
    return {
        store,
        session,
        protocol,
        call,
        state,
        id,
        targetGuid,
        target: () => state().player.soulessence_infos.soulessences.find((s) => s.guid === targetGuid),
    }
}
test('current attribute groups cover every actual template and level without legacy numeric overrides', () => {
    assert.equal(tables.get('soulessence').length, 77, 'current 1.0.0 template coverage must not be empty or partial')
    const original = new Map(tables.get('soulessence_value').map((row) => [row.id, structuredClone(row)]))
    let checked = 0
    for (const config of tables.get('soulessence')) {
        const before = structuredClone(config)
        for (const row of tables.get('soulessence_level').filter((row) => row.rarity === config.rarity)) {
            const value = soulEssenceValue(tables, config, row.lv)
            assert(value, `${config.id}:${row.lv}`)
            assert.equal(value.id, config.attribute * 1000 + row.lv)
            assert.deepEqual(value, original.get(value.id))
            assert(pairs(value.baseAttribute).size > 0)
            checked++
        }
        assert.deepEqual(config, before)
    }
    assert.equal(checked, tables.get('soulessence').length * 100)
})

test('every actual soul template supports one-based copy contributions and the configured maximum', () => {
    assert.equal(tables.get('soulessence').length, 77, 'current star matrix covers the complete target catalogue')
    let checked = 0
    const maximum = Number(tables.get('game').find((row) => row.title === 'SOULESSENCE_MAX_GRADE').value)
    for (const config of tables.get('soulessence')) {
        const s = seedPlayer(tables, 1, 'all-soul-stars')
        grantRewards(tables, s, [{ itemtype: 9, itemid: config.id, itemnum: 2 }])
        const [target, fodder] = s.player.soulessence_infos.soulessences
        fodder.lock = false
        for (let advance = 1; advance < maximum; advance++) {
            target.advance = advance
            const plan = planSoulStar(tables, s, { guid: target.guid, guids: [fodder.guid] })
            assert.equal(plan.advance, advance + 1)
            assert.equal(plan.surplus, 0)
        }
        target.advance = maximum
        assert.throws(
            () => planSoulStar(tables, s, { guid: target.guid, guids: [fodder.guid] }),
            (e) => e.code === ErrorCode.SoulEssenceStartMax,
        )
        checked++
    }
    assert.equal(checked, tables.get('soulessence').length)
})

test('6050 follows batch-unlock then consumes same-name copies, preserves target XP and publishes worn skills before ACK', () => {
    const f = fixture('soul-star-copies')
    try {
        let fodders, heroGuid
        f.store.transact(f.session.id, 0, (s) => {
            fodders = grantRewards(tables, s, [{ itemtype: 9, itemid: 10044, itemnum: 2 }]).map((r) => Number(r.guid))
            const hero = s.player.heros_info.heros.find((h) => h.conf_id === 107002),
                target = s.player.soulessence_infos.soulessences.find((i) => i.guid === f.targetGuid)
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
            () => f.call('RisingStarSoulEssence', { guid: f.targetGuid, guids: fodders }),
            (e) => e.code === ErrorCode.SoulEssenceCostLock,
        )
        assert.deepEqual(f.state(), before)
        f.call('SetLockSoulEssence', { guids: fodders, lock: false })
        const targetBefore = structuredClone(f.target()),
            gold = f.state().player.basic_info.gold
        const { packets, result } = f.call('RisingStarSoulEssence', { guid: f.targetGuid, guids: fodders })
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
            snapshots.some((p) =>
                p.soulessence_infos?.soulessences.some((i) => i.guid === f.targetGuid && i.advance === 4),
            ),
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
            () => f.call('RisingStarSoulEssence', { guid: f.targetGuid, guids: fodders }),
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
test('current auto-star path with no configured special item aggregates actual same-name copies atomically', () => {
    const f = fixture('soul-star-items', 10032)
    try {
        const config = tables.find('soulessence', f.id)
        assert.equal(config.gradeItem, 0)
        f.call('GMCommand', { command: Buffer.from(`give 9 ${f.id} 3`).toString('base64') })
        const guids = f
            .state()
            .player.soulessence_infos.soulessences.filter((item) => item.guid !== f.targetGuid)
            .map((item) => item.guid)
        assert.equal(guids.length, 3)
        const request = { guid: f.targetGuid, guids }
        const before = structuredClone(f.state())
        assert.throws(
            () => f.call('RisingStarSoulEssence', request),
            (e) => e.code === ErrorCode.SoulEssenceCostLock,
        )
        assert.deepEqual(f.state(), before)
        // Current getItemsForAutoStarSelect0600f674 uses type9 GUIDs when
        // gradeItem<=0; this positive path replaces the unavailable type3 pool.
        f.call('SetLockSoulEssence', { guids, lock: false })
        const funded = structuredClone(f.state()),
            { result } = f.call('RisingStarSoulEssence', request)
        assert.equal(f.target().advance, 4)
        assert.deepEqual(result.rewards, [])
        assert.equal(f.state().player.basic_info.gold, funded.player.basic_info.gold)
        assert.deepEqual(f.state().player.sbag_infos, funded.player.sbag_infos)
        assert(!f.state().player.soulessence_infos.soulessences.some((item) => guids.includes(item.guid)))
        f.call('EnterGame', { open_id: 'soul-star-items' }, {})
        assert.equal(f.target().advance, 4)
    } finally {
        f.store.close()
    }
})

test('over-cap selections use the documented capped-consumption policy and never fabricate compensation', () => {
    const f = fixture('soul-star-overflow')
    try {
        let guid
        f.store.transact(f.session.id, 0, (s) => {
            s.player.soulessence_infos.soulessences.find((i) => i.guid === f.targetGuid).advance = 4
            guid = Number(grantRewards(tables, s, [{ itemtype: 9, itemid: 10044, itemnum: 1 }])[0].guid)
            const item = s.player.soulessence_infos.soulessences.find((i) => i.guid === guid)
            item.advance = 3
            item.lock = false
        })
        assert.equal(planSoulStar(tables, f.state(), { guid: f.targetGuid, guids: [guid] }).surplus, 2)
        const { result } = f.call('RisingStarSoulEssence', { guid: f.targetGuid, guids: [guid] })
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
        f.call('GMCommand', { command: Buffer.from('give 9 10001 1').toString('base64') })
        const wrongGuid = f.state().player.soulessence_infos.soulessences.find((item) => item.id === 10001).guid
        const claim = (r) => f.call('RisingStarSoulEssence', { guid: f.targetGuid, ...r })
        assert.throws(
            () => claim({}),
            (e) => e.code === ErrorCode.SoulEssenceAdvNoCost,
        )
        assert.throws(
            () => claim({ guid: 999999, guids: [guid] }),
            (e) => e.code === ErrorCode.SoulEssenceNotExist,
        )
        assert.throws(
            () => claim({ guids: [f.targetGuid] }),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
        assert.throws(
            () => claim({ guids: [guid, guid] }),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
        assert.throws(
            () => claim({ guids: [wrongGuid] }),
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
