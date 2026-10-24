import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'
const config = configuration(),
    tables = new Tables(config.tables)
function fixture() {
    const protocol = new Protocol(config.base),
        store = new Store(':memory:'),
        session = {},
        game = new Game(protocol, store, tables)
    let seq = 1
    const call = (name, data = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, data) })
    }
    call('EnterGame', { open_id: 'presentation-test' })
    const state = () => store.load(session.id).state,
        edit = (fn) => store.transact(session.id, 0, fn)
    edit((s) => {
        s.world.map_id = 100
    })
    const hero = state().player.heros_info.heros[0].guid
    return {
        protocol,
        store,
        session,
        call,
        state,
        edit,
        hero,
        sql: () => store.db.prepare('SELECT total_changes() AS n').get().n,
        close: () => store.close(),
    }
}
test('11221 relays all eight presentation lists to public-map peers through11222 without ACK, self echo, SQL or gameplay changes', () => {
    const f = fixture()
    try {
        const unit_id = f.hero,
            request = {
                dispatch_event_msg: [{ unit_id, eventType: 4, intValue1: 40007022, intValue2: 5 }],
                media_pack_play_msg: [
                    { unit_id, effectKey: 'pre_common_changeplayer_exit', duration: 850, bindType: 1, offset: {} },
                ],
                custom_media_pack_play_msg: [{ unit_id, battleEvent: 3 }],
                dissolve_entity_msg: [{ unit_id, time: 100, isShow: false }],
                set_prefab_effect_active_msg: [
                    { unit_id, active: false, effectNames: ['effect'], meshNames: ['mesh'] },
                ],
                play_voice_msg: [{ unit_id, voiceId: 123 }],
                set_perform_action_msg: [
                    {
                        unit_id,
                        actionType: 1,
                        animName: 'idle',
                        crossfadeTime: 100,
                        waitTime: 0,
                        hideHud: true,
                        needAutoStop: true,
                        performID: 1,
                    },
                ],
                stop_perform_action_ms: [{ unit_id, performID: 1 }],
            },
            before = f.state(),
            sql = f.sql(),
            pending = f.store.pending.size,
            packets = f.call('PresentationMsgs', request)
        assert.equal(packets.length, 1)
        assert.equal(packets[0].id, 11222)
        assert.deepEqual(packets[0].audience, { kind: 'map', map: 100, sender: f.session.id })
        const schema = f.protocol.byId.get(11222).rsp
        assert.deepEqual(
            f.protocol.decode(schema, packets[0].payload),
            f.protocol.decode(schema, f.protocol.encode(schema, request)),
        )
        assert.deepEqual(f.state(), before)
        assert.equal(f.sql(), sql)
        assert.equal(f.store.pending.size, pending)
        assert.deepEqual(f.call('PresentationMsgs', {}), [])
    } finally {
        f.close()
    }
})
test('current6900 enemy skill/death presentation is accepted locally without leaking across private instances or changing HP', () => {
    const f = fixture()
    try {
        f.edit((s) => {
            s.world.map_id = 6900
        })
        const before = f.state(),
            sql = f.sql()
        assert.deepEqual(
            f.call('PresentationMsgs', {
                dispatch_event_msg: [
                    { unit_id: '216172786409951122', eventType: 4, intValue1: 40007022, intValue2: 5 },
                ],
                custom_media_pack_play_msg: [{ unit_id: '216172786409951122', battleEvent: 3 }],
            }),
            [],
        )
        assert.deepEqual(f.state(), before)
        assert.equal(f.sql(), sql)
    } finally {
        f.close()
    }
})
test('foreign units, unknown events and oversized batches reject atomically; failed relay encoding does not mutate the borrowed state', () => {
    const f = fixture()
    try {
        const before = f.state(),
            sql = f.sql(),
            voice = (unit_id) => ({ unit_id, voiceId: 1 })
        assert.throws(
            () => f.call('PresentationMsgs', { play_voice_msg: [voice(f.hero), voice(String(BigInt(f.hero) + 1n))] }),
            /not owned/,
        )
        assert.throws(
            () => f.call('PresentationMsgs', { dispatch_event_msg: [{ unit_id: f.hero, eventType: 5 }] }),
            (e) => e.code === ErrorCode.FunctionClosed,
        )
        assert.throws(
            () => f.call('PresentationMsgs', { play_voice_msg: Array.from({ length: 257 }, () => voice(f.hero)) }),
            /exceeds limits/,
        )
        assert.throws(
            () =>
                f.call('PresentationMsgs', { media_pack_play_msg: [{ unit_id: f.hero, effectKey: 'x'.repeat(257) }] }),
            /Invalid presentation/,
        )
        const encode = f.protocol.encode.bind(f.protocol)
        f.protocol.encode = (name, data) => {
            if (name === f.protocol.byId.get(11222).rsp) throw Error('presentation codec failure')
            return encode(name, data)
        }
        assert.throws(
            () => f.call('PresentationMsgs', { play_voice_msg: [voice(f.hero)] }),
            /presentation codec failure/,
        )
        assert.deepEqual(f.state(), before)
        assert.equal(f.sql(), sql)
    } finally {
        f.close()
    }
})
