import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'
import codes from '../configs/client-language-codes.json' with { type: 'json' }

test('6603 persists native mail language codes, syncs before ACK and never resets stored mail or claim state', () => {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base),
        store = new Store(':memory:')
    const game = new Game(protocol, store, tables),
        session = {}
    let seq = 1
    const call = (name, data = {}, who = session) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(who, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, data) })
    }
    const state = () => store.load(session.id).state
    try {
        call('EnterGame', { open_id: 'language-setting' })
        const mail = structuredClone(state().mail),
            gold = state().player.basic_info.gold
        assert.equal(codes.jp, 3)
        assert.equal(codes.cht, 5)
        assert.equal(tables.get('game').find((row) => row.title === 'option_language').value, 'chs|jp')
        for (const u32 of Object.values(codes)) {
            const previous = state().player.basic_info.language
            const packets = call('SetLanguage', { u32 })
            assert.equal(packets.at(-1).id, 6603)
            const sync = protocol.byName.get('CSProtoSyncPlayerData')
            if (previous !== u32)
                assert.ok(
                    packets
                        .slice(0, -1)
                        .some(
                            (packet) =>
                                packet.id === sync.id &&
                                protocol.decode(sync.rsp, packet.payload).basic_info?.language === u32,
                        ),
                )
            assert.equal(state().player.basic_info.language, u32)
            assert.equal(store.publicProfiles(-1).find((profile) => profile.id === session.id).language, u32)
        }
        call('SetLanguage', { u32: codes.jp })
        call('SetLanguage', { u32: codes.jp })
        call('EnterGame', { open_id: 'language-setting' }, {})
        assert.equal(state().player.basic_info.language, codes.jp)
        assert.deepEqual(state().mail, mail)
        assert.equal(state().player.basic_info.gold, gold)
        const before = structuredClone(state())
        for (const u32 of [0, 6, 0xffffffff]) {
            assert.throws(
                () => call('SetLanguage', { u32 }),
                (error) => error.code === ErrorCode.InvalidArgument,
            )
            assert.deepEqual(state(), before)
        }
    } finally {
        store.close()
    }
})
