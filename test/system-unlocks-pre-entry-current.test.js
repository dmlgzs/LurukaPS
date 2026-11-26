import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Game } from '../src/game.js'
import { Store } from '../src/store.js'
import { ErrorCode } from '../src/error-codes.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
function fixture(name) {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => 1795629881, rng: (min) => min })
    let seq = 1,
        session = {}
    const call = (name, value = {}) => {
        const row = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: row.id, seq: seq++, payload: protocol.encode(row.req, value) })
    }
    // Existing pre-upgrade account: obtain all original business initialization
    // through real EnterGame, retain it, then reconnect only through Login503.
    call('EnterGame', { open_id: 'pre-enter-' + name })
    store.transact(session.id, 0, (s) => {
        delete s.systemUnlockProgress
    })
    session = {}
    call('Login', { open_id: 'pre-enter-' + name })
    return {
        store,
        get session() {
            return session
        },
        game,
        call,
        state: () => store.load(session.id).state,
    }
}
for (const route of ['SetLanguage', 'tick-with-session', 'tick-without-session'])
    test(
        'existing account Login503 -> ' + route + ' keeps pre-entry compatible without preparing or publishing10600',
        () => {
            const f = fixture('existing-' + route)
            try {
                assert.equal(f.session.entered, false)
                assert.equal(f.state().systemUnlockProgress, undefined)
                if (route.startsWith('tick'))
                    f.store.transact(f.session.id, 0, (s) => {
                        s.home.level = 6
                        s.player.basic_info.lv = 36
                    })
                let packets, error
                try {
                    packets =
                        route === 'SetLanguage'
                            ? f.call('SetLanguage', { u32: 2 })
                            : f.game.tick(f.session.id, route === 'tick-with-session' ? f.session : undefined)
                } catch (e) {
                    error = { message: e.message, code: e.code }
                }
                assert.equal(error, undefined)
                assert(!packets.some((p) => p.id === 10600))
                if (route === 'SetLanguage') assert.equal(f.state().player.basic_info.language, 2)
                assert.equal(f.state().systemUnlockProgress, undefined)
            } finally {
                f.store.close()
            }
        },
    )
test('only undefined skips pre-entry; malformed null ledger remains strict; real EnterGame initializes cold bitmap once', () => {
    const f = fixture('guarded-strict')
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.systemUnlockProgress = null
        })
        const before = structuredClone(f.state())
        assert.throws(
            () => f.call('SetLanguage', { u32: 2 }),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
        f.store.transact(f.session.id, 0, (s) => {
            delete s.systemUnlockProgress
            s.starterProfile = { schemaVersion: 1, mode: 'normal', clientVersion: '1.0.0' }
        })
        f.call('SetLanguage', { u32: 2 })
        const packets = f.call('EnterGame', { open_id: 'pre-enter-guarded-strict' })
        const reply = packets.find((p) => p.id === 5001),
            data = protocol.decode(protocol.byId.get(5001).rsp, reply.payload)
        assert(data.data.basic_info.lock_system.includes(510))
        assert.equal(f.state().systemUnlockProgress.profileMode, 'normal')
        assert(!packets.some((p) => p.id === 10600))
    } finally {
        f.store.close()
    }
})
