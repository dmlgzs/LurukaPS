import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { WorldObjectCatalog } from '../src/world-objects.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
function fixture() {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables),
        session = {}
    let seq = 1
    const call = (name, r, who = session) => {
        const e = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(who, { id: e.id, seq: seq++, payload: protocol.encode(e.req, r) })
            .map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    }
    call('EnterGame', { open_id: 'elevator-puzzle' })
    store.transact(session.id, 0, (s) => {
        Object.assign(s.world, tables.position(tables.find('world_borthpos', 10045)))
        s.tasks = []
        s.taskRecords = tables
            .get('task')
            .filter((r) => r.type === 1)
            .map((r) => ({ task_id: r.id, count: 1, time: 1 }))
        s.world.pos = new WorldObjectCatalog(tables).object(100, 4300008).pos
    })
    return { store, session, call, state: () => store.load(session.id).state }
}
test('actual 9138 puzzle request unlocks step1 before callback without completing or paying the chest; retries and login retain state', () => {
    const f = fixture()
    try {
        const before = structuredClone(f.state().player)
        const result = f.call('WorldMapTakeElevator', { obj_id: 4300008, floor: 1 })
        const reply = result.find((p) => p.id === 9138),
            sync = result.find((p) => p.id === 9103)
        assert.equal(reply.data.obj.state_data.step, 1)
        assert.equal(reply.data.obj.complete, false)
        assert.equal(reply.data.obj.active, true)
        assert.equal(sync.data.map_info.objs[0].active, true)
        assert.equal(sync.data.map_info.objs[0].state_data.step, 1)
        assert.ok(result.indexOf(sync) < result.indexOf(reply))
        assert.deepEqual(f.state().player, before)
        const saved = f.state().worldObjects['100:4300008']
        const retry = f.call('WorldMapTakeElevator', { obj_id: 4300008, floor: 1 })
        assert.ok(!retry.some((p) => p.id === 9103))
        assert.deepEqual(f.state().worldObjects['100:4300008'], saved)
        // Reproduce the persisted sparse record from the previous handler.
        f.store.transact(f.session.id, 0, (state) => {
            delete state.worldObjects['100:4300008'].active
        })
        const reconnect = {}
        f.call('EnterGame', { open_id: 'elevator-puzzle' }, reconnect)
        const snapshot = f.call('EnterWorldMap', { map_id: 100 }, reconnect)
        assert.equal(f.state().worldObjects['100:4300008'].active, true)
        assert.equal(
            snapshot.find((p) => p.id === 9103).data.map_info.objs.find((o) => o.obj_id === 4300008).active,
            true,
        )
        assert.equal(
            snapshot.find((p) => p.id === 9103).data.map_info.objs.find((o) => o.obj_id === 4300008).state_data.step,
            1,
        )
    } finally {
        f.store.close()
    }
})
test('unknown floors, other object types and wrong-map IDs fail atomically', () => {
    const f = fixture()
    try {
        for (const req of [
            { obj_id: 4300008, floor: 2 },
            { obj_id: 4300008, floor: 0 },
            { obj_id: 4500001, floor: 1 },
            { obj_id: 99999999, floor: 1 },
        ]) {
            const before = f.state()
            assert.throws(() => f.call('WorldMapTakeElevator', req))
            assert.deepEqual(f.state(), before)
        }
    } finally {
        f.store.close()
    }
})
test('mechanism acknowledgement and ordinary chest claiming are separate and reward is still once-only', () => {
    const f = fixture()
    try {
        f.call('WorldMapTakeElevator', { obj_id: 4300008, floor: 1 })
        const req = {
            objs: [
                { obj: { obj_id: 4300008, complete: true, state_data: { step: 1, complete: true } }, interact_type: 0 },
            ],
        }
        const first = f.call('WorldObjInteract', req).find((p) => p.id === 9133).data.objs[0]
        assert.ok(first.rewards.rewards.length > 0)
        const after = structuredClone(f.state().player)
        const retry = f.call('WorldObjInteract', req).find((p) => p.id === 9133).data.objs[0]
        assert.deepEqual(retry.rewards.rewards ?? [], [])
        assert.deepEqual(f.state().player, after)
        f.call('WorldMapTakeElevator', { obj_id: 4300008, floor: 1 })
        assert.equal(f.state().worldObjects['100:4300008'].complete, true)
    } finally {
        f.store.close()
    }
})

test('visibility migration does not revive explicitly inactive, collected or unrelated objects', () => {
    const f = fixture()
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.worldObjects = {
                '100:4300008': { obj_id: 4300008, active: false, complete: false, state_data: { step: 1 } },
                '100:4300017': { obj_id: 4300017, complete: true, state_data: { step: 1 }, claims: { complete: true } },
                '100:4500001': { obj_id: 4500001, complete: false, state_data: { step: 1 } },
            }
        })
        const reconnect = {}
        f.call('EnterGame', { open_id: 'elevator-puzzle' }, reconnect)
        assert.equal(f.state().worldObjects['100:4300008'].active, false)
        assert.equal(f.state().worldObjects['100:4300017'].active, false)
        assert.equal(f.state().worldObjects['100:4500001'].active, undefined)
    } finally {
        f.store.close()
    }
})
