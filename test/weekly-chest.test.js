import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { getEntrustCatalog } from '../src/entrust.js'
import { materialStoryPlan } from '../src/multiple-material-story.js'
import { WorldObjectCatalog } from '../src/world-objects.js'
import { ErrorCode } from '../src/error-codes.js'
import { weeklyQuotaView } from '../src/weekly-dungeons.js'
const tables = new Tables(configuration().tables),
    protocol = new Protocol(configuration().base)
function fixture(name, store = new Store(':memory:'), initialize = true) {
    let now = 1800000000,
        seq = 1,
        session = {}
    const game = new Game(protocol, store, tables, { clock: () => now, rng: () => 0 })
    const call = (name, r = {}, nonce, who = session) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(who, {
            id: e.id,
            seq: nonce ?? seq++,
            payload: e.req ? protocol.encode(e.req, r) : Buffer.alloc(0),
        })
    }
    const login = () => {
        session = {}
        return call('EnterGame', { open_id: name })
    }
    login()
    const state = () => store.load(session.id).state,
        edit = (fn) => store.transact(session.id, 0, fn)
    if (initialize)
        edit((s) => {
            s.player.basic_info.lv = 70
            ;(s.taskRecords ??= []).push({ task_id: 106013, count: 1 })
            s.entrust ??= { records: {}, starRewards: {}, nextInstanceId: 1 }
            s.entrust.records[8] = { entrust_id: 8, entrust_star: 1, success_time: String(now) }
            s.player.attr_infos.attrs.find((a) => a.attr_id === 3).attr_val = '10000'
            s.player.attr_infos.attrs.find((a) => a.attr_id === 104).attr_val = '999'
            ;(s.taskRecords ??= []).push({ task_id: 106027, count: 1 })
        })
    const complete = (id = 101) => {
        const row = tables.find('dungeon_weekly', id)
        call('MultiCampaignCreate', { dungeon_id: row.dungeonId, scene_type: 12 })
        call('MultiCampaignPlayerLoadFinish')
        const plan = materialStoryPlan(tables, state().entrust.run)
        edit((s) => {
            s.world.pos = { ...plan.pos }
        })
        call('WorldObjInteract', {
            objs: [{ obj: { obj_id: plan.marker_id, complete: true, state_data: { step: 0 } }, interact_type: 2 }],
        })
        call('PlayerStoryStop', { story_id: plan.story_id, op: 1 })
        now += 3
        const s = state(),
            targets = Object.values(s.combat.entities).filter((e) => e.hp > 0)
        call('BattleInfoReduce', {
            uint64_dic: [s.player.heros_info.heros[0].guid, ...targets.map((e) => e.uuid)],
            battle_info: targets.map((e, i) => ({
                hurt_info: { from_id: '1', tar_id: String(i + 2), hp_change: -e.hp },
            })),
            base_time: '0',
        })
        assert.equal(state().entrust.run.battle_complete, true)
        return getEntrustCatalog(tables).chest(id, 'weekly')
    }
    const claim = (box, times = 1, nonce, who) => call('StaminaBoxGet', { box_id: box.id, times }, nonce, who)
    const balance = (id) => BigInt(state().player.attr_infos.attrs.find((a) => a.attr_id === id)?.attr_val ?? '0')
    return {
        store,
        game,
        call,
        state,
        edit,
        complete,
        claim,
        balance,
        login,
        now: () => now,
        tick: (n) => (now += n),
        session: () => session,
        decode: (packets) =>
            protocol.decode(
                protocol.byName.get('CSProtoStaminaBoxGet').rsp,
                packets.find((p) => p.id === 9974).payload,
            ),
    }
}
const itemCount = (state, id) =>
    state.player.sbag_infos.items.filter((r) => r.itemid === id).reduce((n, r) => n + r.itemnum, 0)
function expected(box, weekly, mask) {
    const drop = new WorldObjectCatalog(tables),
        all = drop.drops(box.drop, () => 0),
        budget = { count: 0 }
    String(weekly.challengeReward)
        .split('|')
        .map(Number)
        .forEach((id, index) => {
            if ((mask >>> index) & 1) all.push(...drop.drops(id, () => 0, budget))
        })
    const merged = new Map()
    for (const r of all) {
        const key = `${r.itemtype}:${r.itemid}`
        merged.set(key, { ...r, itemnum: r.itemnum + (merged.get(key)?.itemnum ?? 0) })
    }
    return [...merged.values()].sort((a, b) => a.itemtype - b.itemtype || a.itemid - b.itemid)
}
test('9974 all12 actual weekly chest routes pay the configured base/challenge drops with one40+1 fee', () => {
    const f = fixture('weekly-chest-all12')
    try {
        for (const row of tables.get('dungeon_weekly')) {
            const box = f.complete(row.id),
                before = f.state(),
                stamina = f.balance(3),
                quota = f.balance(104)
            const want = expected(box, row, f.state().entrust.run.star_mask)
            const result = f.decode(f.claim(box))
            const got = result.reward.rewards
                .map(({ itemtype, itemid, itemnum }) => ({ itemtype, itemid, itemnum }))
                .sort((a, b) => a.itemtype - b.itemtype || a.itemid - b.itemid)
            assert.deepEqual(got, want)
            assert.equal(f.balance(3), stamina - 40n)
            assert.equal(f.balance(104), quota - 1n)
            for (const r of want) {
                if (r.itemtype === 3)
                    assert.equal(itemCount(f.state(), r.itemid) - itemCount(before, r.itemid), r.itemnum)
                if (r.itemtype === 10 && r.itemid === 2)
                    assert.equal(f.state().player.basic_info.gold - before.player.basic_info.gold, r.itemnum)
            }
            assert.equal(f.state().entrust.records[row.id], undefined)
            assert.equal(f.state().weeklyDungeonRecords[row.id].success_count, 1)
            assert.equal(f.state().entrust.run.claim_times, 1)
            f.call('CampaignQuit')
        }
    } finally {
        f.store.close()
    }
})
test('9974 wrong chest, unsupported times, quota/stamina shortage and exact expiry reject atomically', () => {
    const f = fixture('weekly-chest-errors')
    try {
        const box = f.complete()
        const reject = (fn, code) => {
            const before = f.state()
            assert.throws(fn, (e) => e.code === code)
            assert.deepEqual(f.state(), before)
        }
        for (const times of [0, 2, 3]) reject(() => f.claim(box, times), ErrorCode.StaminaBoxTimesInvalid)
        reject(() => f.claim({ ...box, id: box.id + 1 }), ErrorCode.StaminaBoxNotExist)
        f.edit((s) => {
            s.player.attr_infos.attrs.find((a) => a.attr_id === 104).attr_val = '0'
        })
        reject(() => f.claim(box), ErrorCode.StaminaBoxWeeklyLimit)
        f.edit((s) => {
            s.player.attr_infos.attrs.find((a) => a.attr_id === 104).attr_val = '3'
            s.player.attr_infos.attrs.find((a) => a.attr_id === 3).attr_val = '0'
        })
        reject(() => f.claim(box), ErrorCode.StaminaNotEnough)
        f.edit((s) => {
            s.player.attr_infos.attrs.find((a) => a.attr_id === 3).attr_val = '500'
        })
        f.tick(box.time)
        reject(() => f.claim(box), ErrorCode.StaminaBoxExpired)
    } finally {
        f.store.close()
    }
})
test('9974 duplicate nonce, different nonce and second local session cannot charge or grant a second share', () => {
    const f = fixture('weekly-chest-replay')
    try {
        const box = f.complete(),
            before = f.balance(104)
        f.claim(box, 1, 777)
        const once = f.state()
        assert.equal(f.decode(f.claim(box, 1, 777)).reward.rewards.length, 0)
        assert.equal(f.decode(f.claim(box, 1, 778)).reward.rewards.length, 0)
        const peer = {}
        f.call('EnterGame', { open_id: 'weekly-chest-replay' }, 779, peer)
        assert.equal(f.decode(f.claim(box, 1, 780, peer)).reward.rewards.length, 0)
        assert.equal(f.balance(104), before - 1n)
        assert.deepEqual(f.state().player.sbag_infos, once.player.sbag_infos)
        assert.deepEqual(f.state().weeklyDungeonRecords, once.weeklyDungeonRecords)
    } finally {
        f.store.close()
    }
})
test('9974 notification/response codec failure rolls back inventory, cost, quota reset and chest receipt', () => {
    const f = fixture('weekly-chest-codec')
    try {
        const boundary = weeklyQuotaView(tables, f.state(), f.now()).periodStart + 604800
        f.tick(boundary - f.now() - 10)
        const box = f.complete()
        f.edit((s) => {
            s.player.attr_infos.attrs.find((a) => a.attr_id === 104).attr_val = '0'
        })
        f.tick(11)
        const old = f.state(),
            encode = protocol.encode
        for (const target of ['CSProtoStaminaBoxGet', 'CSProtoStaminaBoxSync']) {
            const type = protocol.byName.get(target).rsp
            protocol.encode = function (name, ...args) {
                if (name === type) throw Error('injected-weekly-chest-codec')
                return encode.call(this, name, ...args)
            }
            try {
                assert.throws(() => f.claim(box), /injected-weekly-chest-codec/)
                assert.deepEqual(f.state(), old)
            } finally {
                protocol.encode = encode
            }
        }
        f.claim(box)
        assert.equal(f.balance(104), 2n)
        assert.equal(f.state().weeklyDungeonQuota.periodStart, boundary)
    } finally {
        f.store.close()
    }
})
test('9974 paid receipt and actual inventory survive real SQLite close/reopen without reopening a historical box', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-chest-b24-')),
        file = path.join(folder, 'state.db'),
        stores = []
    try {
        const a = new Store(file)
        stores.push(a)
        const first = fixture('weekly-chest-disk', a),
            box = first.complete()
        first.claim(box)
        const once = first.state()
        a.close()
        const b = new Store(file)
        stores.push(b)
        const second = fixture('weekly-chest-disk', b, false)
        assert(second.state().entrust.run.chest_claimed)
        assert.equal(second.decode(second.claim(box)).reward.rewards.length, 0)
        assert.deepEqual(second.state().player.sbag_infos, once.player.sbag_infos)
        assert.equal(second.balance(104), 998n)
        second.call('CampaignQuit')
        second.complete()
        assert.equal(second.state().entrust.run.chest_claimed, undefined)
        second.claim(box)
        assert.equal(second.balance(104), 997n)
    } finally {
        for (const s of stores) if (s.db.open) s.close()
        const resolved = path.resolve(folder)
        assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep))
        fs.rmSync(resolved, { recursive: true, force: true })
    }
})
