import test from 'node:test'
import assert from 'node:assert/strict'
import { Tables } from '../src/player.js'
import { configuration } from '../src/config.js'
import { Store } from '../src/store.js'
import { sceneRoute, sceneAudienceMetadata, sceneRoutingInfo, sceneAudienceAllows } from '../src/scene-routing.js'

const tables = new Tables(configuration().tables)
const world = () => ({ world: { map_id: 100 } })
const audience = (map = 100, sender = 1) => ({ kind: 'map', map, sender })

test('current scene types and owner-local dungeon runs cannot be mistaken for a shared scene', () => {
    assert.equal(tables.find('world_city', 100).type, 1)
    assert.equal(tables.find('world_city', 646).type, 12)
    const own = sceneRoute(tables, world(), 1),
        peer = sceneRoute(tables, world(), 2)
    assert.equal(own.scope, 'world:100')
    assert(sceneAudienceAllows(peer, audience(), own.scope))
    for (const field of ['entrust', 'multiCampaign', 'storyCampaign', 'cultTrial', 'abyssRun']) {
        const first = world(),
            second = world()
        first[field] = field === 'entrust' ? { run: { instance_id: 1 } } : { instance_id: 1 }
        second[field] = structuredClone(first[field])
        assert.equal(sceneRoute(tables, first, 1).scope, 'private:1:100')
        assert(!sceneAudienceAllows(sceneRoute(tables, second, 2), audience(), sceneRoute(tables, first, 1).scope))
        assert(!sceneAudienceAllows(peer, audience(), sceneRoute(tables, first, 1).scope))
        assert(!sceneAudienceAllows(sceneRoute(tables, second, 2), audience(), own.scope))
        delete first[field]
        assert.equal(sceneRoute(tables, first, 1).scope, own.scope)
    }
    const dungeon = { world: { map_id: 646 } }
    assert.equal(sceneRoute(tables, dungeon, 1).scope, 'private:1:646')
    assert(!sceneAudienceAllows(sceneRoute(tables, dungeon, 2), audience(646), 'private:1:646'))
    // A saved room/run-looking property is not admission by a shared authority.
    dungeon.teamV2Run = { id: 'team-v2-run:1', generation: 1, members: [1, 2] }
    assert.equal(sceneRoute(tables, dungeon, 2).scope, 'private:2:646')
})

test('only server-captured scene metadata authorizes gameplay; unknown, stale and unscoped map packets fail closed', () => {
    const state = world(),
        requested = audience(),
        route = sceneRoute(tables, state, 2)
    const metadata = sceneAudienceMetadata(tables, state, 1, requested)
    assert.equal(metadata.audience, requested)
    assert.equal(metadata.sceneScope, 'world:100')
    assert(sceneAudienceAllows(route, requested, metadata.sceneScope))
    assert(!sceneAudienceAllows(route, requested))
    assert(!sceneAudienceAllows(route, { ...requested, map: 101 }, metadata.sceneScope))
    assert.equal(sceneAudienceMetadata(tables, state, 1, audience(101)).sceneScope, null)
    assert.equal(sceneAudienceMetadata(tables, state, 1, audience(100, 2)).sceneScope, null)
    for (const broken of [{}, { world: { map_id: 0 } }, { world: { map_id: 0xffffffff } }]) {
        const invalid = sceneRoute(tables, broken, 1)
        assert.equal(invalid.scope, null)
        assert(!sceneAudienceAllows(invalid, requested, metadata.sceneScope))
    }
    assert.equal(sceneRoute(tables, state, 0).scope, null)
    const chat = { kind: 'world', room: 1, sender: 1 }
    assert.deepEqual(sceneAudienceMetadata(tables, state, 1, chat), { audience: chat })
    assert(!sceneAudienceAllows(route, chat, route.scope))
    assert(Object.isFrozen(route))
})

test('scene route cache observes deferred entry, rollback and exit without flushing or saving queries', () => {
    const store = new Store(':memory:'),
        { id } = store.login('scene-routing-cache', world)
    try {
        const writes = () => store.db.prepare('SELECT total_changes() AS n').get().n
        const initial = sceneRoutingInfo(store, tables, id),
            count = writes(),
            read = store.read
        try {
            store.read = () => {
                throw Error('stable route should not borrow the profile again')
            }
            for (let i = 0; i < 100; i++) assert.equal(sceneRoutingInfo(store, tables, id), initial)
        } finally {
            store.read = read
        }
        assert.equal(writes(), count)
        assert.equal(store.pending.size, 0)
        store.transact(
            id,
            0,
            (state) => {
                state.world.map_id = 646
                state.entrust = { run: { instance_id: 1 } }
            },
            { defer: true },
        )
        const entered = sceneRoutingInfo(store, tables, id)
        assert.equal(entered.scope, `private:${id}:646`)
        assert.equal(JSON.parse(store.playerById.get(id).state).world.map_id, 100)
        const beforeRead = writes()
        assert.equal(sceneRoutingInfo(store, tables, id), entered)
        assert.equal(writes(), beforeRead)
        assert.throws(
            () =>
                store.transact(id, 0, (state) => {
                    state.world.map_id = 100
                    delete state.entrust.run
                    throw Error('late rejected transition')
                }),
            /late rejected transition/,
        )
        assert.equal(sceneRoutingInfo(store, tables, id).scope, entered.scope)
        store.flushPending()
        assert.equal(sceneRoutingInfo(store, tables, id).scope, entered.scope)
        store.transact(id, 0, (state) => {
            state.world.map_id = 100
            delete state.entrust.run
        })
        assert.equal(sceneRoutingInfo(store, tables, id).scope, 'world:100')
        assert.notEqual(sceneRoutingInfo(store, tables, id), entered)
    } finally {
        store.close()
    }
})
