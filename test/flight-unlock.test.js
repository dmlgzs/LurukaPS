import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Game } from '../src/game.js'
import { Store } from '../src/store.js'
import { ensureFlightUnlocked } from '../src/flight-unlock.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
test('flight unlock follows table systemUnlock3 while preserving higher levels and existing exploration records', () => {
    const state = {
        exploration: {
            map_info: [{ map_id: 100, lv: 5, exp: 91, time: 7, rewards: [1, 2] }],
            mission_info: [{ exploration_id: 12, num: 1, complete: true }],
        },
    }
    assert.equal(ensureFlightUnlocked(tables, state, 10), true)
    assert.deepEqual(state.exploration.map_info[0], { map_id: 100, lv: 5, exp: 91, time: 7, rewards: [1, 2] })
    for (const gate of tables.get('explore_map_reward').filter((r) => r.systemUnlock === 3))
        assert.ok(state.exploration.map_info.find((m) => m.map_id === gate.mapId).lv >= gate.exploreLevel)
    assert.deepEqual(state.exploration.mission_info, [{ exploration_id: 12, num: 1, complete: true }])
    assert.equal(ensureFlightUnlocked(tables, state, 11), false)
})
test('login sends native exploration sync and repairs old saves without granting exploration loot', () => {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables),
        session = {}
    let seq = 1
    const login = (who) => {
        const e = protocol.byName.get('CSProtoEnterGame')
        return game.dispatch(who, {
            id: e.id,
            seq: seq++,
            payload: protocol.encode(e.req, { open_id: 'flight-unlock' }),
        })
    }
    try {
        login(session)
        store.transact(session.id, 0, (s) => {
            delete s.exploration
        })
        const before = store.load(session.id).state.player
        const packets = login({}),
            entry = protocol.byName.get('CSProtoWorldExplorationSync')
        const data = protocol.decode(entry.rsp, packets.find((p) => p.id === entry.id).payload)
        assert.equal(data.login, true)
        assert.ok(data.map_info.some((m) => m.map_id === 100 && m.lv === 2))
        assert.ok(data.map_info.some((m) => m.map_id === 101 && m.lv === 2))
        assert.ok(data.map_info.every((m) => m.rewards.length === 0))
        assert.deepEqual(store.load(session.id).state.player, before)
    } finally {
        store.close()
    }
})
