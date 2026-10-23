import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables)
test('9904 local common-graph story hook limits cleanup to the configured current opening, is idempotent, and never grants victory', () => {
    const store = new Store(':memory:'),
        p = new Protocol(cfg.base),
        game = new Game(p, store, tables),
        session = {}
    let seq = 1
    const call = (r) => {
        const e = p.byName.get('CSProtoClientBehaviourRecord')
        return game.dispatch(session, { id: e.id, seq: seq++, payload: p.encode(e.req, r) })
    }
    const e = p.byName.get('CSProtoEnterGame')
    game.dispatch(session, { id: e.id, seq: seq++, payload: p.encode(e.req, { open_id: 'local-story-hook' }) })
    const state = () => store.load(session.id).state
    try {
        store.transact(session.id, 0, (s) => {
            s.world.map_id = 6226
            s.storyCampaign = {
                instance_id: 17,
                local_playable_condition: [13060, 6226, 0, 1],
                map_id: 6226,
                status: 2,
                opening_story: 208215,
                ending_story: 980130,
                opening_delete_tag: 999,
                completed_scenes: [],
            }
            s.worldObjects = {
                '6226:1500036': { obj_id: 1500036, active: true, claims: { retained: true } },
                '6226:1000011': { obj_id: 1000011, active: true },
            }
        })
        call({ key: 1004, args: [208216, 1] })
        assert.equal(state().worldObjects['6226:1500036'].active, true)
        call({ key: 1004, args: [208215, 0] })
        assert.equal(state().worldObjects['6226:1500036'].active, true)
        const first = call({ key: 1004, args: [208215, 1] })
        assert.equal(state().worldObjects['6226:1500036'].active, false)
        assert.deepEqual(state().worldObjects['6226:1500036'].claims, { retained: true })
        assert.equal(state().worldObjects['6226:1000011'].active, true)
        assert.ok(first.some((r) => r.id === p.byName.get('CSProtoWorldMapSync').id))
        assert.equal(call({ key: 1004, args: [208215, 1] }).length, 1)
        assert.equal(state().storyCampaign.status, 2)
        assert.throws(() => call({ key: 1004, args: [980130, 1] }), /not ready/)
        store.transact(session.id, 0, (s) => {
            s.storyCampaign.status = 3
            s.storyCampaign.completed_scenes = [6226]
        })
        call({ key: 1004, args: [980130, 1] })
        assert.equal(state().storyCampaign.ending_story_complete, true)
        call({ key: 1004, args: [208215, 1] })
        assert.equal(state().storyCampaign.status, 3)
        assert.equal(state().world.map_id, 6226)
        assert.equal(state().storyCampaignClears?.[10074], undefined)
    } finally {
        store.close()
    }
})
test('9904 configured story refuses missing or damaged instance and inactive opening without consuming any receipt', () => {
    const store = new Store(':memory:'),
        p = new Protocol(cfg.base),
        game = new Game(p, store, tables),
        session = {}
    let seq = 1
    const call = (name, r) => {
        const e = p.byName.get('CSProto' + name)
        return game.dispatch(session, { id: e.id, seq: seq++, payload: p.encode(e.req, r) })
    }
    try {
        call('EnterGame', { open_id: 'local-story-invalid-instance' })
        for (const instance of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
            store.transact(session.id, 0, (s) => {
                s.world.map_id = 6226
                s.storyCampaign = {
                    instance_id: instance,
                    local_playable_condition: [13060, 6226, 0, 1],
                    map_id: 6226,
                    status: 2,
                    opening_story: 208215,
                    ending_story: 980130,
                    opening_delete_tag: 999,
                }
                s.worldObjects = { '6226:1500036': { obj_id: 1500036, active: true } }
            })
            const before = store.load(session.id).state
            assert.throws(
                () => call('ClientBehaviourRecord', { key: 1004, args: [208215, 1] }),
                /instance is missing or damaged/,
            )
            assert.deepEqual(store.load(session.id).state, before)
            call('ClientBehaviourRecord', { key: 1004, args: [208216, 1] }) // Unknown story remains generic telemetry.
        }
        for (const status of [0, 1, 3, 4]) {
            store.transact(session.id, 0, (s) => {
                s.storyCampaign.instance_id = 18
                s.storyCampaign.status = status
            })
            const before = store.load(session.id).state
            assert.throws(() => call('ClientBehaviourRecord', { key: 1004, args: [208215, 1] }), /not active/)
            assert.deepEqual(store.load(session.id).state, before)
        }
    } finally {
        store.close()
    }
})
test('9904 local story hook response encoding failure rolls back cleanup and story receipt', () => {
    const store = new Store(':memory:'),
        p = new Protocol(cfg.base),
        game = new Game(p, store, tables),
        session = {}
    let seq = 1
    const call = (name, r) => {
        const e = p.byName.get('CSProto' + name)
        return game.dispatch(session, { id: e.id, seq: seq++, payload: p.encode(e.req, r) })
    }
    try {
        call('EnterGame', { open_id: 'local-story-codec' })
        store.transact(session.id, 0, (s) => {
            s.world.map_id = 6226
            s.storyCampaign = {
                instance_id: 17,
                local_playable_condition: [13060, 6226, 0, 1],
                map_id: 6226,
                status: 2,
                opening_story: 208215,
                opening_delete_tag: 999,
            }
            s.worldObjects = { '6226:1500036': { obj_id: 1500036, active: true } }
        })
        const before = store.load(session.id).state,
            encode = p.encode.bind(p)
        p.encode = (type, value) => {
            if (type === p.byName.get('CSProtoClientBehaviourRecord').rsp) throw Error('story response codec')
            return encode(type, value)
        }
        assert.throws(() => call('ClientBehaviourRecord', { key: 1004, args: [208215, 1] }), /story response codec/)
        p.encode = encode
        assert.deepEqual(store.load(session.id).state, before)
    } finally {
        store.close()
    }
})
