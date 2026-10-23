import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { getEntrustCatalog } from '../src/entrust.js'
import { materialStoryPlan } from '../src/multiple-material-story.js'
import { ErrorCode } from '../src/error-codes.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const tables = new Tables(configuration().tables),
    protocol = new Protocol(configuration().base)
function fixture(name, store = new Store(':memory:'), initialize = true) {
    let now = 1800000000,
        seq = 1,
        session = {}
    const game = new Game(protocol, store, tables, { clock: () => now, rng: () => 0 })
    const call = (name, r = {}, nonce) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, {
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
            s.player.attr_infos.attrs.find((a) => a.attr_id === 3).attr_val = '500'
        })
    const complete = () => {
        call('MultiCampaignCreate', { dungeon_id: 35750, scene_type: 12 })
        call('MultiCampaignPlayerLoadFinish')
        const plan = materialStoryPlan(tables, state().entrust.run)
        edit((s) => {
            s.world.pos = { ...plan.pos }
        })
        call('WorldObjInteract', {
            objs: [{ obj: { obj_id: plan.marker_id, complete: true, state_data: { step: 0 } }, interact_type: 2 }],
        })
        call('PlayerStoryStop', { story_id: plan.story_id, op: 1 })
        now++
        const s = state(),
            enemy = Object.values(s.combat.entities)[0]
        call('BattleInfoReduce', {
            uint64_dic: [s.player.heros_info.heros[0].guid, enemy.uuid],
            battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -enemy.hp } }],
            base_time: '0',
        })
        return getEntrustCatalog(tables).chest(101, 'weekly')
    }
    return { store, game, call, login, state, edit, complete, tick: (n) => (now += n) }
}
test('9976 weekly cancellation keeps clear record/map/inventory/quota, expires only this box and rejects later9974', () => {
    const f = fixture('weekly-give-up')
    try {
        const box = f.complete(),
            before = f.state()
        const result = f.call('StaminaBoxGiveUp', { box_id: box.id }, 777)
        assert(
            result.some((p) => p.id === 9976),
            'real ACK contract retained',
        )
        assert.deepEqual(f.state().player, before.player)
        assert.deepEqual(f.state().weeklyDungeonQuota, before.weeklyDungeonQuota)
        assert.deepEqual(f.state().weeklyDungeonRecords, before.weeklyDungeonRecords)
        assert.deepEqual(f.state().world, before.world)
        assert.equal(f.state().entrust.run.chest_given_up.instance_id, before.entrust.run.instance_id)
        const e = protocol.byName.get('CSProtoStaminaBoxSync')
        const sync = result.find((p) => p.id === e.id)
        assert.equal(protocol.decode(e.rsp, sync.payload).boxes[0].finish_time, 0)
        const once = f.state()
        f.call('StaminaBoxGiveUp', { box_id: box.id }, 777)
        f.call('StaminaBoxGiveUp', { box_id: box.id }, 778)
        assert.deepEqual(f.state().entrust.run.chest_given_up, once.entrust.run.chest_given_up)
        assert.throws(
            () => f.call('StaminaBoxGet', { box_id: box.id, times: 1 }),
            (x) => x.code === ErrorCode.StaminaBoxNotExist,
        )
        f.login()
        assert.deepEqual(f.state().entrust.run.chest_given_up, once.entrust.run.chest_given_up)
        f.call('CampaignQuit')
        f.complete()
        assert.equal(f.state().entrust.run.chest_given_up, undefined)
        f.call('StaminaBoxGet', { box_id: box.id, times: 1 })
        assert.equal(f.state().player.attr_infos.attrs.find((a) => a.attr_id === 104).attr_val, '2')
    } finally {
        f.store.close()
    }
})
test('9976 weekly abandonment receipt survives real SQLite reopen and only a genuine fresh entry creates another box', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-abandon-b24-')),
        file = path.join(folder, 'state.db'),
        stores = []
    try {
        const a = new Store(file)
        stores.push(a)
        const first = fixture('weekly-abandon-disk', a),
            box = first.complete()
        first.call('StaminaBoxGiveUp', { box_id: box.id })
        const receipt = first.state().entrust.run.chest_given_up,
            quota = first.state().player.attr_infos.attrs.find((r) => r.attr_id === 104).attr_val
        a.close()
        const b = new Store(file)
        stores.push(b)
        const second = fixture('weekly-abandon-disk', b, false)
        assert.deepEqual(second.state().entrust.run.chest_given_up, receipt)
        assert.equal(second.state().player.attr_infos.attrs.find((r) => r.attr_id === 104).attr_val, quota)
        assert.throws(
            () => second.call('StaminaBoxGet', { box_id: box.id, times: 1 }),
            (e) => e.code === ErrorCode.StaminaBoxNotExist,
        )
        second.call('StaminaBoxGiveUp', { box_id: box.id })
        second.call('CampaignQuit')
        second.complete()
        assert.equal(second.state().entrust.run.chest_given_up, undefined)
    } finally {
        for (const s of stores) if (s.db.open) s.close()
        const resolved = path.resolve(folder)
        assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep))
        fs.rmSync(resolved, { recursive: true, force: true })
    }
})
test('9976 weekly wrong identity, wrong map, stale receipt and expiry reject without erasing history', () => {
    const f = fixture('weekly-give-up-errors')
    try {
        const box = f.complete()
        const reject = (fn, code) => {
            const s = f.state()
            assert.throws(fn, (x) => x.code === code)
            assert.deepEqual(f.state(), s)
        }
        reject(() => f.call('StaminaBoxGiveUp', { box_id: box.id + 1 }), ErrorCode.StaminaBoxNotExist)
        f.edit((s) => {
            s.world.map_id = 100
        })
        reject(() => f.call('StaminaBoxGiveUp', { box_id: box.id }), ErrorCode.NotInMap)
        f.edit((s) => {
            s.world.map_id = s.entrust.run.map_id
            s.entrust.run.chest_given_up = {
                instance_id: s.entrust.run.instance_id + 1,
                box_id: box.id,
                at: 1800000000,
            }
        })
        reject(() => f.call('StaminaBoxGiveUp', { box_id: box.id }), ErrorCode.GameConfig)
        f.edit((s) => {
            delete s.entrust.run.chest_given_up
        })
        f.tick(box.time)
        reject(() => f.call('StaminaBoxGiveUp', { box_id: box.id }), ErrorCode.StaminaBoxExpired)
    } finally {
        f.store.close()
    }
})
test('9976 weekly response or box notification codec failure rolls back the cancellation receipt and visibility', () => {
    const f = fixture('weekly-give-up-codec')
    try {
        const box = f.complete(),
            before = f.state(),
            encode = protocol.encode
        for (const message of ['CSProtoStaminaBoxGiveUp', 'CSProtoStaminaBoxSync']) {
            const type = protocol.byName.get(message).rsp
            protocol.encode = function (name, ...args) {
                if (name === type) throw Error('weekly-giveup-codec')
                return encode.call(this, name, ...args)
            }
            try {
                assert.throws(() => f.call('StaminaBoxGiveUp', { box_id: box.id }), /weekly-giveup-codec/)
                assert.deepEqual(f.state(), before)
            } finally {
                protocol.encode = encode
            }
        }
    } finally {
        f.store.close()
    }
})
