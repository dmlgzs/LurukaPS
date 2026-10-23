import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
const config = configuration(),
    protocol = new Protocol(config.base),
    tables = new Tables(config.tables)
function fixture() {
    let now = 1800000000
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => now, rng: () => 0 }),
        session = {}
    const call = (name, r = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: e.id, seq: 1, payload: protocol.encode(e.req, r) })
            .map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
            .filter((p) => name !== 'WorldEventTrigger' || p.id === e.id)
    }
    call('EnterGame', { open_id: 'events' })
    store.transact(session.id, 0, (s) => {
        s.world.map_id = 101
    })
    return {
        store,
        session,
        call,
        setTime: (t) => {
            now = t
        },
        state: () => store.load(session.id).state,
    }
}
test('world event start is stable, sequential steps reward once and cooldown prevents replay', () => {
    const f = fixture()
    try {
        const finalStep = tables.find('world_event', 300).stepCount,
            first = f.call('WorldEventTrigger', { cfg_id: 300 })[0].data.infos[0]
        assert.equal(first.step, 1)
        assert.equal(first.begin_time, 1800000000)
        f.setTime(1800000001)
        assert.deepEqual(f.call('WorldEventTrigger', { cfg_id: 300 })[0].data.infos[0], first)
        const before = f.store.load(f.session.id)
        assert.throws(() => f.call('WorldEventStep', { cfg_id: 300, step: 4 }))
        assert.deepEqual(f.store.load(f.session.id), before)
        let done
        for (let step = 2; step <= finalStep; step++) done = f.call('WorldEventStep', { cfg_id: 300, step }).at(-1).data
        assert(done.rewards.length > 0)
        assert.equal(f.state().worldEvents['101:300'].completed, true)
        assert.deepEqual(f.call('WorldEventStep', { cfg_id: 300, step: finalStep }).at(-1).data.rewards, [])
        assert.equal(f.call('WorldEventTrigger', { cfg_id: 300 })[0].data.infos[0].step, finalStep)
        f.setTime(first.next_trigger_time)
        assert.equal(f.call('WorldEventTrigger', { cfg_id: 300 })[0].data.infos[0].step, 1)
        assert.equal(f.state().worldEvents['101:300'].generation, 2)
    } finally {
        f.store.close()
    }
})
test('wrong-map and expired events cannot award; empty random-group config sends a real empty snapshot', () => {
    const f = fixture()
    try {
        assert.throws(() => f.call('WorldEventTrigger', { cfg_id: 100 }), /current map/)
        f.call('WorldEventTrigger', { cfg_id: 300 })
        f.setTime(1800000000 + 21600)
        const before = f.store.load(f.session.id)
        assert.throws(() => f.call('WorldEventStep', { cfg_id: 300, step: 2 }), /expired/)
        assert.deepEqual(f.store.load(f.session.id), before)
        const result = f.call('TaskRandomArea', { u32: 1 })
        assert.equal(result[0].id, 9865)
        assert.deepEqual(result[0].data.task_ids, [])
        assert.deepEqual(result[0].data.areas_ids, [])
        assert.equal(f.state().randomTaskQuery.group_id, 1)
    } finally {
        f.store.close()
    }
})
test('client-forced final step on event203 settles once and stays stable until cooldown', () => {
    const f = fixture()
    try {
        const finalStep = tables.find('world_event', 203).stepCount
        f.store.transact(f.session.id, 0, (s) => {
            s.world.map_id = 100
        })
        f.call('WorldEventTrigger', { cfg_id: 203 })
        const before = f.state().petEggs?.length ?? 0
        f.setTime(1800000001)
        const req = {
            cfg_id: 203,
            step: finalStep,
            event_type: 1,
            pos: { x: -119.1, y: 164.8, z: -700.3 },
            reset_start: true,
        }
        const done = f.call('WorldEventStep', req).at(-1).data,
            record = f.state().worldEvents['100:203']
        assert.equal(record.step, finalStep)
        assert.equal(record.completed, true)
        assert.equal(record.begin_time, 1800000001)
        assert.equal(record.next_trigger_time, 1800000001 + 252000)
        assert.equal(f.state().petEggs.length, before + 1)
        assert.equal(done.rewards.length, 1)
        assert.deepEqual(f.call('WorldEventStep', req).at(-1).data.rewards, [])
        assert.equal(f.state().petEggs.length, before + 1)
        assert.equal(f.call('WorldEventTrigger', { cfg_id: 203 })[0].data.infos[0].step, finalStep)
        const saved = f.store.load(f.session.id)
        assert.throws(() => f.call('WorldEventStep', { ...req, step: 1 }), /cooldown/)
        assert.deepEqual(f.store.load(f.session.id), saved)
        f.setTime(record.next_trigger_time)
        assert.equal(f.call('WorldEventTrigger', { cfg_id: 203 })[0].data.infos[0].step, 1)
    } finally {
        f.store.close()
    }
})
test('old-world event polls during arena loading are empty acknowledgements with no immediate SQLite write', () => {
    const f = fixture()
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.world.map_id = 1054
            s.multiCampaign = { dungeon_id: 40007, map_id: 1054, status: 2 }
        })
        const revision = f.store.db
            .prepare('select revision from players where account_id=?')
            .get(f.session.id).revision
        assert.deepEqual(f.call('WorldEventTrigger', { cfg_id: 203 })[0].data.infos, [])
        assert.equal(f.state().worldEvents, undefined)
        assert.equal(
            f.store.db.prepare('select revision from players where account_id=?').get(f.session.id).revision,
            revision,
        )
    } finally {
        f.store.close()
    }
})
