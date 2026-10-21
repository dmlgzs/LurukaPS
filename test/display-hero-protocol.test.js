import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'

test('6137 stores the full one-based three-slot selection, syncs before callback and survives login', () => {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base),
        store = new Store(':memory:'),
        game = new Game(protocol, store, tables),
        session = {}
    let seq = 1
    const call = (name, data) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, data) })
    }
    const state = () => store.load(session.id).state
    try {
        call('EnterGame', { open_id: 'display-hero' })
        const heroes = state().player.heros_info.heros.slice(0, 3)
        store.transact(session.id, 0, (s) => {
            s.player.basic_info.info = { achievement: [1], pet: [] }
        })
        const packets = call('ChangeShowHero', {
            hero: [
                { hero_id: heroes[1].guid, pos: 3 },
                { hero_id: heroes[0].guid, pos: 1 },
            ],
        })
        assert.equal(packets.at(-1).id, 6137)
        const sync = protocol.byName.get('CSProtoSyncPlayerData')
        assert.ok(packets.slice(0, -1).some((packet) => packet.id === sync.id))
        const shown = state().player.basic_info.info.hero
        assert.deepEqual(
            shown.map((row) => [row.id, row.pos]),
            [
                [heroes[0].guid, 1],
                [heroes[1].guid, 3],
            ],
        )
        assert.equal(shown[0].config, heroes[0].conf_id)
        assert.equal(shown[0].lv, heroes[0].hero_lv)
        assert.deepEqual(store.publicProfiles(-1).find(profile => profile.id === session.id).info.hero, shown)
        assert.deepEqual(state().player.basic_info.info.achievement, [1])
        for (const hero of [
            [{ hero_id: heroes[0].guid, pos: 0 }],
            [
                { hero_id: heroes[0].guid, pos: 1 },
                { hero_id: heroes[1].guid, pos: 1 },
            ],
            [
                { hero_id: heroes[0].guid, pos: 1 },
                { hero_id: heroes[0].guid, pos: 2 },
            ],
        ]) {
            const before = structuredClone(state())
            assert.throws(
                () => call('ChangeShowHero', { hero }),
                (error) => error.code === ErrorCode.InvalidArgument,
            )
            assert.deepEqual(state(), before)
        }
        assert.throws(
            () => call('ChangeShowHero', { hero: [{ hero_id: '999999', pos: 1 }] }),
            (error) => error.code === ErrorCode.HeroNotExist,
        )
        const enter = protocol.byName.get('CSProtoEnterGame')
        game.dispatch(
            {},
            { id: enter.id, seq: seq++, payload: protocol.encode(enter.req, { open_id: 'display-hero' }) },
        )
        assert.deepEqual(state().player.basic_info.info.hero, shown)
        call('ChangeShowHero', { hero: [] })
        assert.deepEqual(state().player.basic_info.info.hero, [])
        assert.deepEqual(state().player.basic_info.info.achievement, [1])
    } finally {
        store.close()
    }
})
