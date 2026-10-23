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
import { getEntrustCatalog, entrustChestSnapshot } from '../src/entrust.js'
import { ErrorCode } from '../src/error-codes.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
function fixture(file = ':memory:', account = 'chest-giveup') {
    let now = 1800000000,
        seq = 1
    const store = new Store(file),
        game = new Game(protocol, store, tables, { clock: () => now }),
        session = {}
    const call = (name, data = {}, who = session) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(who, { id: e.id, seq: seq++, payload: protocol.encode(e.req, data) })
    }
    call('EnterGame', { open_id: account })
    const state = () => store.load(session.id).state
    const prepare = () =>
        store.transact(session.id, 0, (s) => {
            s.player.basic_info.lv = 45
            s.player.attr_infos.attrs.find((x) => x.attr_id === 3).attr_val = '500'
        })
    const enter = () => call('MultiCampaignCreate', { dungeon_id: 31960, scene_type: 12 })
    const finish = () => {
        const stages = getEntrustCatalog(tables).stages(30101)
        call('WorldObjInteract', {
            objs: [{ obj: { obj_id: stages[0].row.id, complete: true, state_data: { step: 0 } }, interact_type: 2 }],
        })
        for (const stage of stages.filter((x) => x.type === 50)) {
            const s = state(),
                enemies = Object.values(s.combat.entities).filter((x) => x.object_id === stage.row.id)
            call('BattleInfoReduce', {
                uint64_dic: [s.player.heros_info.heros[0].guid, ...enemies.map((x) => x.uuid)],
                battle_info: enemies.map((x, i) => ({
                    hurt_info: { from_id: '1', tar_id: String(i + 2), hp_change: -x.hp },
                })),
                base_time: '0',
            })
        }
        assert.equal(state().entrust.run.battle_complete, true)
    }
    const chest = () => getEntrustCatalog(tables).chest(30101)
    return { store, session, game, call, state, prepare, enter, finish, chest, tick: (n) => (now += n) }
}
const boxSync = (packets) => protocol.decode('SCStaminaBoxSync', packets.find((p) => p.id === 9002).payload)
const rejects = (f, data, code) => {
    const before = structuredClone(f.state())
    assert.throws(
        () => f.call('StaminaBoxGiveUp', data),
        (e) => e.code === code,
    )
    assert.deepEqual(f.state(), before)
}

test('material cancel settles only this box without cost, grant, claim count, clear-record changes or scene exit', () => {
    const f = fixture()
    try {
        f.prepare()
        f.enter()
        f.finish()
        const before = structuredClone(f.state()),
            box = f.chest(),
            packets = f.call('StaminaBoxGiveUp', { box_id: box.id }),
            after = f.state()
        assert.deepEqual(protocol.decode('ProtoNullRsp', packets.find((p) => p.id === 9976).payload), {})
        assert.equal(boxSync(packets).boxes[0].finish_time, 0)
        assert.equal(boxSync(packets).boxes[0].box_count, 0)
        for (const key of ['chest_claimed', 'claim_times', 'rewards']) assert.equal(after.entrust.run[key], undefined)
        assert.equal(after.entrust.run.chest_given_up.instance_id, before.entrust.run.instance_id)
        assert.equal(after.entrust.run.chest_given_up.box_id, box.id)
        assert.deepEqual(after.player, before.player)
        assert.deepEqual(after.materialDungeonRecords, before.materialDungeonRecords)
        assert.deepEqual(after.world, before.world)
        assert.equal(after.worldObjects[`${after.world.map_id}:${box.worldmapid}`].active, false)
    } finally {
        f.store.close()
    }
})
test('missing box, unfinished battle, crossed config, wrong map and expiry reject atomically', () => {
    const f = fixture()
    try {
        rejects(f, { box_id: 1 }, ErrorCode.StaminaBoxNotExist)
        rejects(f, { box_id: 0 }, ErrorCode.InvalidArgument)
        f.prepare()
        f.enter()
        rejects(f, { box_id: f.chest().id }, ErrorCode.StaminaBoxNotExist)
        f.finish()
        rejects(f, { box_id: 0xffffffff }, ErrorCode.StaminaBoxNotExist)
        const map = f.state().world.map_id
        f.store.transact(f.session.id, 0, (s) => (s.world.map_id = 100))
        rejects(f, { box_id: f.chest().id }, ErrorCode.NotInMap)
        f.store.transact(f.session.id, 0, (s) => (s.world.map_id = map))
        f.tick(f.chest().time)
        rejects(f, { box_id: f.chest().id }, ErrorCode.StaminaBoxExpired)
    } finally {
        f.store.close()
    }
})
test('same-run retry remains idempotent after expiry, blocks paid claims and survives login sync', () => {
    const f = fixture()
    try {
        f.prepare()
        f.enter()
        f.finish()
        f.call('StaminaBoxGiveUp', { box_id: f.chest().id })
        const receipt = structuredClone(f.state().entrust.run.chest_given_up)
        f.tick(f.chest().time + 1)
        f.call('StaminaBoxGiveUp', { box_id: f.chest().id })
        assert.deepEqual(f.state().entrust.run.chest_given_up, receipt)
        const before = structuredClone(f.state())
        assert.throws(
            () => f.call('StaminaBoxGet', { box_id: f.chest().id, times: 1 }),
            (e) => e.code === ErrorCode.StaminaBoxNotExist,
        )
        assert.deepEqual(f.state(), before)
        assert.equal(boxSync(f.call('EnterGame', { open_id: 'chest-giveup' }, {})).boxes[0].finish_time, 0)
    } finally {
        f.store.close()
    }
})
test('give-up cannot replace a completed paid claim or erase its reward receipt', () => {
    const f = fixture()
    try {
        f.prepare()
        f.enter()
        f.finish()
        f.call('StaminaBoxGet', { box_id: f.chest().id, times: 1 })
        const before = structuredClone(f.state())
        rejects(f, { box_id: f.chest().id }, ErrorCode.StaminaBoxNotExist)
        assert.equal(f.state().entrust.run.chest_given_up, undefined)
        assert.deepEqual(f.state().entrust.run.rewards, before.entrust.run.rewards)
    } finally {
        f.store.close()
    }
})
test('quit and fresh reentry reset the attempt so a new victory can yield its own claim', () => {
    const f = fixture()
    try {
        f.prepare()
        f.enter()
        f.finish()
        const id = f.chest().id,
            old = f.state().entrust.run.instance_id
        f.call('StaminaBoxGiveUp', { box_id: id })
        f.call('MultiCampaignQuit')
        assert.equal(f.state().entrust.run, undefined)
        rejects(f, { box_id: id }, ErrorCode.StaminaBoxNotExist)
        f.enter()
        assert(f.state().entrust.run.instance_id > old)
        assert.equal(f.state().entrust.run.chest_given_up, undefined)
        rejects(f, { box_id: id }, ErrorCode.StaminaBoxNotExist)
        f.finish()
        assert.equal(f.chest().id, id, 'wire config ID is not an instance nonce')
        assert(entrustChestSnapshot(tables, f.state()).boxes[0].finish_time > 0)
        f.call('StaminaBoxGet', { box_id: id, times: 1 })
        assert.equal(f.state().entrust.run.chest_claimed, true)
    } finally {
        f.store.close()
    }
})
test('temporary SQLite reopen restores this account attempt receipt and does not contaminate another account', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luruka-stamina-giveup-')),
        file = path.join(dir, 'test.sqlite')
    let f
    try {
        f = fixture(file)
        f.prepare()
        f.enter()
        f.finish()
        f.call('StaminaBoxGiveUp', { box_id: f.chest().id })
        const receipt = structuredClone(f.state().entrust.run.chest_given_up)
        f.store.close()
        f = null
        f = fixture(file)
        assert.deepEqual(f.state().entrust.run.chest_given_up, receipt)
        assert.equal(entrustChestSnapshot(tables, f.state()).boxes[0].finish_time, 0)
        f.store.close()
        f = null
        f = fixture(file, 'another-player')
        assert.equal(f.state().entrust, undefined)
        rejects(f, { box_id: receipt.box_id }, ErrorCode.StaminaBoxNotExist)
    } finally {
        f?.store.close()
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
test('corrupt attempt receipts never silently settle a different box', () => {
    const f = fixture()
    try {
        f.prepare()
        f.enter()
        f.finish()
        const run = f.state().entrust.run
        for (const receipt of [
            null,
            {},
            { instance_id: run.instance_id + 1, box_id: f.chest().id, at: 1800000000 },
            { instance_id: run.instance_id, box_id: 0xffffffff, at: 1800000000 },
        ]) {
            f.store.transact(f.session.id, 0, (s) => (s.entrust.run.chest_given_up = receipt))
            rejects(f, { box_id: f.chest().id }, ErrorCode.GameConfig)
        }
    } finally {
        f.store.close()
    }
})
test('post-cancel sync encoding failure rolls back receipt and object visibility', () => {
    const f = fixture()
    try {
        f.prepare()
        f.enter()
        f.finish()
        const before = structuredClone(f.state()),
            original = protocol.encode
        protocol.encode = function (name, data) {
            if (name === 'cs.SCStaminaBoxSync') throw Error('test sync codec failure')
            return original.call(this, name, data)
        }
        try {
            assert.throws(() => f.call('StaminaBoxGiveUp', { box_id: f.chest().id }), /test sync codec failure/)
        } finally {
            protocol.encode = original
        }
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})
test('normal commission dialog cancellation is a different client route and is not forced into material give-up', () => {
    const f = fixture()
    try {
        f.prepare()
        f.call('EnterEntrust', { entrust_id: 1 })
        rejects(f, { box_id: 1010101 }, ErrorCode.FunctionClosed)
    } finally {
        f.store.close()
    }
})
