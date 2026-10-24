import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { materialStoryPlan } from '../src/multiple-material-story.js'
const config = configuration(),
    tables = new Tables(config.tables)
function fixture(id = 35750) {
    let now = 1800000000,
        seq = 1,
        session = {}
    const protocol = new Protocol(config.base),
        store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => now })
    const call = (name, data = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, data) })
            .map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    }
    const login = () => {
        session = {}
        return call('EnterGame', { open_id: 'intro-visible-' + id })
    }
    login()
    const edit = (fn) => store.transact(session.id, 0, fn),
        state = () => store.load(session.id).state
    edit((s) => {
        s.player.basic_info.lv = 45
        s.taskRecords = [{ task_id: 106013, count: 1 }]
        s.entrust = {
            records: { 8: { entrust_id: 8, entrust_star: 1, success_time: String(now) } },
            starRewards: {},
            nextInstanceId: 1,
        }
        s.player.attr_infos.attrs.find((a) => a.attr_id === 3).attr_val = '500'
    })
    call('MultiCampaignCreate', { dungeon_id: id, scene_type: 12 })
    call('MultiCampaignPlayerLoadFinish')
    const plan = materialStoryPlan(tables, state().entrust.run)
    edit((s) => {
        s.world.pos = { ...plan.pos }
    })
    const begin = () =>
        call('WorldObjInteract', {
            objs: [
                {
                    obj: { obj_id: plan.trigger_id, complete: id === 35750, state_data: { step: 0 } },
                    interact_type: id === 35750 ? 2 : 0,
                },
            ],
        })
    const boss = () => state().worldObjects[`${plan.map_id}:${plan.boss_id}`],
        agent = ((3n << 56n) | BigInt(plan.boss_id)).toString(),
        controlId = protocol.byName.get('SCProtoControlChangeByAddNtf').id,
        owns = (packets) => packets.some((p) => p.id === controlId && p.data.agent_uid === agent),
        end = () => call('PlayerStoryStop', { story_id: plan.story_id, op: 1 })
    return {
        store,
        protocol,
        call,
        login,
        edit,
        state,
        begin,
        boss,
        plan,
        agent,
        owns,
        end,
        tick: (n) => {
            now += n
        },
        close: () => store.close(),
    }
}
test('material and current6904 weekly intro use a real active boss, with ownership withheld until END', () => {
    for (const id of [312, 35750]) {
        const f = fixture(id)
        try {
            const packets = f.begin()
            assert(packets.some((p) => p.id === 11270))
            const appear = f.protocol.byName.get('SCProtoObjAppearNtf').id
            assert(
                packets.findIndex((p) => p.id === appear && p.data.agent_uid === f.agent) <
                    packets.findIndex((p) => p.id === 11270),
            )
            assert(packets.some((p) => p.id === appear && p.data.agent_uid === f.agent))
            assert.equal(
                f.boss().active,
                true,
                'inactive groups are recreated by StoryTempUnitProcess with worldmapId0',
            )
            assert.equal(f.owns(packets), false, 'rendering a cinematic target must not grant battle control')
            assert.equal(f.state().entrust.run.battle_start_time, undefined)
            const before = structuredClone(f.boss().expand_data.battle_group.monsters)
            const ended = f.end()
            assert.equal(f.owns(ended), true)
            assert.equal(f.boss().active, true)
            assert.deepEqual(f.boss().expand_data.battle_group.monsters, before)
            assert(f.state().entrust.run.battle_start_time)
        } finally {
            f.close()
        }
    }
})
test('old inactive playing checkpoint is repaired on reconnect before the one resumed intro, without resetting the run', () => {
    const f = fixture()
    try {
        f.begin()
        const run = f.state().entrust.run,
            original = structuredClone(run.materialStory)
        f.edit((s) => {
            s.worldObjects[`${f.plan.map_id}:${f.plan.boss_id}`].active = false
            s.entrust.run.scene_objects.find((o) => o.obj_id === f.plan.boss_id).active = false
        })
        f.store.flushPending()
        f.tick(20)
        f.login()
        const replay = f.call('MultiCampaignPlayerLoadFinish')
        assert.equal(f.boss().active, true)
        assert.equal(f.owns(replay), false)
        assert.equal(replay.filter((p) => p.id === 11270).length, 1)
        assert.equal(f.state().entrust.run.instance_id, run.instance_id)
        assert.equal(f.state().entrust.run.materialStory.started_at, original.started_at)
        assert.equal(f.state().entrust.run.battle_start_time, undefined)
        assert.equal(f.call('MultiCampaignPlayerLoadFinish').filter((p) => p.id === 11270).length, 0)
        f.end()
        assert.equal(f.state().entrust.run.materialStory.phase, 'done')
    } finally {
        f.close()
    }
})
test('failed END ownership packet rolls back completion and battle clock before the successful retry', () => {
    const f = fixture()
    try {
        f.begin()
        const before = f.state(),
            encode = f.protocol.encode.bind(f.protocol)
        f.protocol.encode = (name, data) => {
            if (name === f.protocol.byName.get('SCProtoControlChangeByAddNtf').rsp)
                throw Error('intro ownership encode failure')
            return encode(name, data)
        }
        assert.throws(() => f.end(), /intro ownership encode failure/)
        assert.deepEqual(f.state(), before)
        f.protocol.encode = encode
        assert(f.owns(f.end()))
        assert.equal(f.owns(f.end()), false)
    } finally {
        f.close()
    }
})
