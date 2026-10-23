import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { getEntrustCatalog, entrustMultiSnapshot, ensureEntrustSceneObjects } from '../src/entrust.js'
import { materialStoryPlan } from '../src/multiple-material-story.js'
import { ErrorCode } from '../src/error-codes.js'
const tables = new Tables(configuration().tables),
    protocol = new Protocol(configuration().base)
function fixture(name) {
    const store = new Store(':memory:')
    let now = 1800000000,
        seq = 1,
        session = {}
    const game = new Game(protocol, store, tables, { clock: () => now })
    const call = (name, r = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, {
            id: e.id,
            seq: seq++,
            payload: e.req ? protocol.encode(e.req, r) : Buffer.alloc(0),
        })
    }
    const login = () => {
        session = {}
        return call('EnterGame', { open_id: name })
    }
    login()
    const edit = (fn) => store.transact(session.id, 0, fn)
    edit((s) => {
        s.player.basic_info.lv = 45
        s.player.attr_infos.attrs.find((x) => x.attr_id === 3).attr_val = '500'
    })
    const state = () => store.load(session.id).state,
        run = () => state().entrust?.run
    const interact = (id, complete = true) =>
        call('WorldObjInteract', {
            objs: [
                {
                    obj: {
                        obj_id: id,
                        complete,
                        state_data: {
                            step: state().worldObjects[`${state().world.map_id}:${id}`]?.state_data?.step ?? 0,
                        },
                    },
                    interact_type: complete ? 2 : 0,
                },
            ],
        })
    const enter = (id = 312) => call('MultiCampaignCreate', { dungeon_id: id, scene_type: 12 })
    const start = () => {
        enter()
        call('MultiCampaignPlayerLoadFinish')
        const p = materialStoryPlan(tables, run())
        return { plan: p, packets: interact(p.trigger_id, false) }
    }
    const stop = (storyId = run().materialStory.story_id, op = 1) => call('PlayerStoryStop', { story_id: storyId, op })
    const kill = (id) => {
        const s = state(),
            enemies = Object.values(s.combat.entities).filter((e) => e.object_id === id)
        return call('BattleInfoReduce', {
            uint64_dic: [s.player.heros_info.heros[0].guid, ...enemies.map((e) => e.uuid)],
            battle_info: enemies.map((e, i) => ({
                hurt_info: { from_id: '1', tar_id: String(i + 2), hp_change: -e.hp },
            })),
            base_time: '0',
        })
    }
    return {
        store,
        call,
        login,
        edit,
        state,
        run,
        interact,
        enter,
        start,
        stop,
        kill,
        tick: (n) => (now += n),
        now: () => now,
    }
}
const message = (packets, name) => {
    const e = protocol.byName.get(name),
        p = packets.find((p) => p.id === e.id)
    return p && protocol.decode(e.rsp, p.payload)
}
test('11271 real DirectSend complete=false starts one local material story, holds boss/time, then END resumes actual fight and paid chest', () => {
    const f = fixture('material-story-complete')
    try {
        const { plan, packets } = f.start(),
            run = f.run()
        assert.deepEqual(message(packets, 'SCProtoPlayerStoryStart'), {
            story_id: 6110007,
            start_time: f.now(),
            target_id: 1200000,
        })
        const ack = packets.findIndex((p) => p.id === 9133),
            teleport = packets.findIndex(
                (p) =>
                    p.id === protocol.byName.get('CSProtoWorldMapSync').id &&
                    protocol.decode(protocol.byName.get('CSProtoWorldMapSync').rsp, p.payload).cmd === 19,
            ),
            start = packets.findIndex((p) => p.id === 11270)
        assert.ok(ack >= 0 && teleport > ack && start > teleport)
        assert.equal(run.materialStory.phase, 'playing')
        assert.equal(run.stage_index, plan.boss_index)
        assert.equal(run.battle_start_time, undefined)
        assert.equal(entrustMultiSnapshot(run).status, 2)
        assert.equal(entrustMultiSnapshot(run).start_time, '0')
        assert.equal(f.state().world.point_id, plan.point_id)
        assert.equal(f.state().worldObjects[`${plan.map_id}:${plan.boss_id}`].active, false)
        const stable = f.state()
        assert.equal(
            ensureEntrustSceneObjects(tables, stable, f.now()),
            false,
            'pending intro does not repeatedly toggle boss visibility',
        )
        const hps = Object.values(f.state().combat.entities)
            .filter((e) => e.object_id === plan.boss_id)
            .map((e) => e.hp)
        f.kill(plan.boss_id)
        assert.deepEqual(
            Object.values(f.state().combat.entities)
                .filter((e) => e.object_id === plan.boss_id)
                .map((e) => e.hp),
            hps,
        )
        assert.equal(f.run().battle_start_time, undefined)
        const tasksBeforeEnd = structuredClone(f.state().tasks)
        f.tick(30)
        const ended = f.stop()
        assert.deepEqual(f.state().tasks, tasksBeforeEnd, 'the intro END never advances ordinary tasks')
        assert.equal(message(ended, 'SCProtoPlayerStoryStop').story_id, plan.story_id)
        assert.equal(f.run().materialStory.phase, 'done')
        assert.equal(f.run().battle_start_time, f.now())
        assert.equal(entrustMultiSnapshot(f.run()).status, 3)
        assert.equal(entrustMultiSnapshot(f.run()).start_time, String(f.now() * 1000))
        assert.equal(f.state().worldObjects[`${plan.map_id}:${plan.boss_id}`].active, true)
        const time = f.run().battle_start_time
        f.tick(2)
        f.stop()
        assert.equal(f.run().battle_start_time, time)
        f.tick(3)
        f.kill(plan.boss_id)
        assert.equal(f.run().battle_complete, true)
        assert.equal(f.run().end_time - time, 5)
        const deadAgain = f.stop()
        assert.ok(
            !deadAgain.some((p) => p.id === protocol.byName.get('SCProtoObjAppearNtf').id),
            'duplicate END cannot advertise another boss',
        )
        assert.ok(
            Object.values(f.state().combat.entities)
                .filter((e) => e.object_id === plan.boss_id)
                .every((e) => e.hp === 0),
        )
        const stages = getEntrustCatalog(tables).stages(f.run().entrust_id),
            stamina = BigInt(f.state().player.attr_infos.attrs.find((x) => x.attr_id === 3).attr_val)
        f.interact(stages.at(-1).row.id)
        assert.equal(f.run().chest_claimed, true)
        assert.equal(BigInt(f.state().player.attr_infos.attrs.find((x) => x.attr_id === 3).attr_val), stamina - 30n)
    } finally {
        f.store.close()
    }
})
test('11271 marker preparation waits for the configured DirectSend trigger and cannot start a hidden boss or timer early', () => {
    const f = fixture('material-story-marker')
    try {
        f.enter()
        f.call('MultiCampaignPlayerLoadFinish')
        const p = materialStoryPlan(tables, f.run()),
            packets = f.interact(p.marker_id)
        assert.equal(message(packets, 'SCProtoPlayerStoryStart'), undefined)
        assert.equal(f.run().materialStory.phase, 'await_trigger')
        assert.equal(f.run().battle_start_time, undefined)
        assert.equal(entrustMultiSnapshot(f.run()).status, 2)
        let before = f.state()
        assert.throws(
            () => f.stop(p.story_id),
            (e) => e.code === ErrorCode.InvalidLogic,
        )
        assert.deepEqual(f.state(), before)
        const started = f.interact(p.trigger_id, false)
        assert.ok(message(started, 'SCProtoPlayerStoryStart'))
        const at = f.run().materialStory.started_at
        f.tick(2)
        assert.equal(message(f.interact(p.trigger_id, false), 'SCProtoPlayerStoryStart'), undefined)
        assert.equal(f.run().materialStory.started_at, at)
    } finally {
        f.store.close()
    }
})
test('11271 unfinished checkpoint persists, reconnect replays once only after loadfinish, exit clears it and re-entry has a new epoch', () => {
    const f = fixture('material-story-reconnect')
    try {
        const { plan } = f.start(),
            instance = f.run().instance_id
        f.store.flushPending()
        f.tick(3600)
        const login = f.login()
        assert.equal(message(login, 'SCProtoPlayerStoryStart'), undefined)
        assert.equal(f.run().instance_id, instance)
        const replay = f.call('MultiCampaignPlayerLoadFinish')
        assert.equal(message(replay, 'SCProtoPlayerStoryStart').start_time, f.now())
        assert.equal(f.run().materialStory.replays, 1)
        assert.equal(f.run().battle_start_time, undefined)
        assert.equal(message(f.call('MultiCampaignPlayerLoadFinish'), 'SCProtoPlayerStoryStart'), undefined)
        f.call('CampaignQuit')
        assert.equal(f.run(), undefined)
        assert.throws(
            () => f.stop(plan.story_id),
            (e) => e.code === ErrorCode.DungeonNotIn,
        )
        f.enter()
        assert.ok(f.run().instance_id > instance)
        assert.equal(f.run().materialStory, undefined)
        assert.throws(
            () => f.stop(plan.story_id),
            (e) => e.code === ErrorCode.DungeonNotIn,
        )
        f.call('MultiCampaignPlayerLoadFinish')
        f.interact(plan.trigger_id, false)
        assert.equal(f.run().materialStory.instance_id, f.run().instance_id)
        f.stop()
        assert.equal(f.run().materialStory.phase, 'done')
    } finally {
        f.store.close()
    }
})
test('11271 wrong story, skip op, altered checkpoint epoch and either notification codec failure roll back the whole transition', () => {
    const f = fixture('material-story-rollback')
    try {
        f.enter()
        f.call('MultiCampaignPlayerLoadFinish')
        const plan = materialStoryPlan(tables, f.run())
        let before = f.state(),
            old = protocol.encode
        protocol.encode = function (name, r) {
            if (name === protocol.byName.get('SCProtoPlayerStoryStart').rsp) throw Error('start codec failure')
            return old.call(this, name, r)
        }
        try {
            assert.throws(() => f.interact(plan.trigger_id, false), /start codec failure/)
        } finally {
            protocol.encode = old
        }
        assert.deepEqual(f.state(), before)
        f.interact(plan.trigger_id, false)
        before = f.state()
        assert.throws(
            () => f.stop(plan.story_id + 1),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
        assert.throws(
            () => f.stop(plan.story_id, 2),
            (e) => e.code === ErrorCode.FunctionClosed,
        )
        assert.deepEqual(f.state(), before)
        old = protocol.encode
        protocol.encode = function (name, r) {
            if (name === protocol.byName.get('SCProtoPlayerStoryStop').rsp) throw Error('stop codec failure')
            return old.call(this, name, r)
        }
        try {
            assert.throws(() => f.stop(), /stop codec failure/)
        } finally {
            protocol.encode = old
        }
        assert.deepEqual(f.state(), before)
        f.edit((s) => {
            s.entrust.run.materialStory.participants.push(999999)
        })
        before = f.state()
        assert.throws(
            () => f.stop(),
            (e) => e.code === ErrorCode.FunctionClosed,
        )
        assert.deepEqual(f.state(), before)
        f.edit((s) => {
            s.entrust.run.materialStory.participants = null
        })
        before = f.state()
        assert.throws(
            () => f.stop(),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
        f.edit((s) => {
            s.entrust.run.materialStory.participants = [s.player.basic_info.id]
            s.entrust.run.materialStory.instance_id++
        })
        before = f.state()
        assert.throws(
            () => f.stop(),
            (e) => e.code === ErrorCode.InvalidLogic,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})
test('11271 opts into exactly the six fully configured local material scenes and preserves ordinary commissions/non-intro material runs', () => {
    const ids = [],
        f = fixture('material-story-configs')
    try {
        for (const m of tables.get('dungeon_material')) {
            const config = getEntrustCatalog(tables).get(m.id),
                p = materialStoryPlan(tables, { kind: 'material', map_id: config.scene.id })
            if (p) ids.push(m.id)
        }
        assert.equal(ids.length, 36)
        assert.deepEqual(
            [...new Set(ids.map((id) => getEntrustCatalog(tables).get(id).scene.id))],
            [6370, 650, 638, 600, 641, 632],
        )
        f.enter(31960)
        f.call('MultiCampaignPlayerLoadFinish')
        const stages = getEntrustCatalog(tables).stages(f.run().entrust_id),
            packets = f.interact(stages[0].row.id)
        assert.equal(message(packets, 'SCProtoPlayerStoryStart'), undefined)
        assert.equal(f.run().materialStory, undefined)
        assert.equal(f.run().battle_start_time, f.now())
        f.call('CampaignQuit')
        f.call('EnterEntrust', { entrust_id: 1 })
        assert.equal(materialStoryPlan(tables, f.run()), null)
    } finally {
        f.store.close()
    }
})

test('11271 each of the six configured local material scenes completes its own real intro, enemy wave and paid chest', () => {
    const f = fixture('material-story-six-scenes')
    try {
        const chosen = new Map()
        for (const m of tables.get('dungeon_material')) {
            const config = getEntrustCatalog(tables).get(m.id)
            const plan = materialStoryPlan(tables, { kind: 'material', map_id: config.scene.id })
            if (plan && !chosen.has(plan.map_id)) chosen.set(plan.map_id, { m, config, plan })
        }
        assert.equal(chosen.size, 6)
        for (const { m, config, plan } of chosen.values()) {
            f.enter(config.dungeon.id)
            f.call('MultiCampaignPlayerLoadFinish')
            const packets = f.interact(plan.trigger_id, false)
            assert.equal(message(packets, 'SCProtoPlayerStoryStart').story_id, plan.story_id)
            assert.equal(f.run().map_id, plan.map_id)
            f.tick(4)
            f.stop()
            f.tick(3)
            f.kill(plan.boss_id)
            assert.equal(f.run().battle_complete, true)
            f.interact(getEntrustCatalog(tables).stages(m.id).at(-1).row.id)
            assert.equal(f.run().chest_claimed, true)
            assert.ok(f.state().materialDungeonRecords[m.id].success_time)
            f.call('CampaignQuit')
            assert.equal(f.run(), undefined)
        }
    } finally {
        f.store.close()
    }
})

test('11271 scene anchoring preserves the genuine entry favor roster and chest rewards update personal heroes instead of global4', () => {
    const f = fixture('material-story-personal-favor')
    try {
        f.edit((s) => {
            const first = s.player.heros_info.heros[0],
                others = s.player.heros_info.heros
                    .filter((h) => h.guid !== first.guid && tables.find('hero', h.conf_id)?.favor === 1)
                    .slice(0, 2),
                members = [first, ...others]
            assert.equal(others.length, 2)
            for (const h of members) {
                h.favorability_lv = 1
                h.favorability_exp = 0
                h.store_favor_rewards = []
            }
            const manager = s.player.group_mgrs.find((m) => m.type === 1),
                group = manager.groups.find((g) => g.id === manager.cur_group)
            group.heros = members.map((h) => ({ hero_id: h.guid, pet_id: '0' }))
            group.control = first.guid
            let attr = s.player.attr_infos.attrs.find((row) => row.attr_id === 4)
            if (!attr) s.player.attr_infos.attrs.push((attr = { attr_id: 4, attr_val: '0' }))
            attr.attr_val = '731'
        })
        const { plan } = f.start(),
            entry = structuredClone(f.run().favor_entry),
            recipients = entry.members.filter((row) => row.favor_eligible).map((row) => row.hero_guid)
        assert.ok(recipients.length >= 2)
        assert.equal(f.run().materialStory.phase, 'playing')
        f.stop()
        f.kill(plan.boss_id)
        assert.equal(f.run().battle_complete, true)
        const stages = getEntrustCatalog(tables).stages(f.run().entrust_id),
            packets = f.interact(stages.at(-1).row.id),
            receipts = Object.values(f.run().dungeon_favor_receipts ?? {})
        assert.ok(receipts.length)
        assert.deepEqual(f.run().favor_entry, entry, 'story transfer and END must not recapture the current formation')
        assert.equal(f.state().player.attr_infos.attrs.find((row) => row.attr_id === 4).attr_val, '731')
        for (const receipt of receipts) {
            assert.ok(receipt.amount > 0)
            assert.deepEqual(
                receipt.heroes.map((row) => row.hero_guid),
                recipients,
            )
            for (const row of receipt.heroes) assert.equal(row.requested, receipt.amount)
        }
        const syncs = packets
            .filter((p) => p.id === 5008)
            .map((p) => protocol.decode(protocol.byId.get(5008).rsp, p.payload))
        for (const id of recipients) {
            const hero = f.state().player.heros_info.heros.find((row) => row.guid === id),
                wire = syncs
                    .flatMap((p) => p.heros_info?.heros ?? [])
                    .filter((h) => h.guid === id)
                    .at(-1)
            assert.ok(hero.favorability_lv > 1 || hero.favorability_exp > 0)
            assert.ok(wire)
            assert.equal(wire.favorability_lv, hero.favorability_lv)
            assert.equal(wire.favorability_exp, hero.favorability_exp)
        }
    } finally {
        f.store.close()
    }
})
