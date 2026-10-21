import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'
test('9124 claims achieved map tiers with inventory sync before reward, persists receipts and rejects unknown maps', () => {
    const cfg = configuration(),
        t = new Tables(cfg.tables),
        p = new Protocol(cfg.base),
        s = new Store(':memory:'),
        g = new Game(p, s, t),
        session = {}
    let seq = 1
    const call = (name, r = {}) => {
        const e = p.byName.get('CSProto' + name)
        return g.dispatch(session, { id: e.id, seq: seq++, payload: p.encode(e.req, r) })
    }
    try {
        call('EnterGame', { open_id: 'explore-reward' })
        const before = s.load(session.id).state.player.basic_info.gold
        const packets = call('WorldMapExploreReward', { u32: 100 })
        assert.equal(packets.at(-1).id, 9124)
        const rewards = p.decode('Rewards', packets.at(-1).payload).rewards
        assert.equal(p.decode('Rewards', packets.at(-1).payload).src, 50)
        assert.equal(
            rewards.filter((x) => x.itemtype === 10 && x.itemid === 2).reduce((n, x) => n + x.itemnum, 0),
            2000,
        )
        assert.ok(packets.some((x) => x.id === 9125))
        assert.equal(s.load(session.id).state.player.basic_info.gold, before + 2000)
        assert.deepEqual(s.load(session.id).state.exploration.map_info.find((x) => x.map_id === 100).rewards, [1, 2])
        assert.deepEqual(p.decode('Rewards', call('WorldMapExploreReward', { u32: 100 }).at(-1).payload).rewards, [])
        assert.equal(s.load(session.id).state.player.basic_info.gold, before + 2000)
        assert.throws(() => call('WorldMapExploreReward', { u32: 999999 }), /Unknown exploration map/)
        call('WorldMapExploreReward', { u32: 101 })
        assert.deepEqual(s.load(session.id).state.exploration.map_info.find((x) => x.map_id === 101).rewards, [11, 12])
        assert.deepEqual(p.decode('Rewards', call('WorldMapExploreReward', { u32: 101 }).at(-1).payload).rewards, [])
        s.transact(session.id, 0, (state) => {
            state.exploration.map_info.find((x) => x.map_id === 100).lv = 3
        })
        const tier3 = call('WorldMapExploreReward', { u32: 100 })
        assert.ok(p.decode('Rewards', tier3.at(-1).payload).rewards.some((x) => x.itemtype === 9 && x.itemid === 10253))
        assert.deepEqual(s.load(session.id).state.exploration.map_info.find((x) => x.map_id === 100).rewards, [1, 2, 3])
    } finally {
        s.close()
    }
})

test('exploration claims respect achieved levels, distinguish absent progress and roll back partial grants', () => {
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
    const map = (s) => s.exploration.map_info.find((entry) => entry.map_id === 100)
    const claim = () => call('WorldMapExploreReward', { u32: 100 })
    const get = tables.get.bind(tables)
    try {
        call('EnterGame', { open_id: 'explore-claim-validation' })
        store.transact(session.id, 0, (s) => {
            map(s).lv = 0
        })
        const initialGold = state().player.basic_info.gold
        assert.deepEqual(protocol.decode('Rewards', claim().at(-1).payload).rewards, [])
        assert.equal(state().player.basic_info.gold, initialGold)
        assert.deepEqual(map(state()).rewards, [])

        store.transact(session.id, 0, (s) => {
            map(s).lv = 1
        })
        const packets = claim()
        assert.equal(packets.at(-1).id, 9124)
        const syncId = protocol.byName.get('CSProtoSyncPlayerData').id
        assert.ok(packets.slice(0, -1).some((packet) => packet.id === syncId))
        const explore = protocol.decode(
            protocol.byName.get('CSProtoWorldExplorationSync').rsp,
            packets.find((packet) => packet.id === 9125).payload,
        )
        assert.deepEqual(explore.map_info[0].rewards, [1])
        assert.deepEqual(map(state()).rewards, [1])
        assert.equal(state().player.basic_info.gold, initialGold + 1000)

        store.transact(session.id, 0, (s) => {
            map(s).lv = 2
        })
        const before = structuredClone(state())
        tables.get = (name) =>
            name === 'explore_map_reward'
                ? get(name).map((row) => (row.id === 2 ? { ...row, reward: '10#2#1000|3#4294967295#1' } : row))
                : get(name)
        assert.throws(claim)
        assert.deepEqual(state(), before)
        tables.get = get
        claim()
        assert.deepEqual(map(state()).rewards, [1, 2])
        assert.equal(state().player.basic_info.gold, initialGold + 2000)

        store.transact(session.id, 0, (s) => {
            map(s).lv = -1
        })
        assert.throws(claim, (error) => error.code === ErrorCode.GameConfig)
        store.transact(session.id, 0, (s) => {
            s.exploration.map_info = s.exploration.map_info.filter((entry) => entry.map_id !== 100)
        })
        assert.throws(claim, (error) => error.code === ErrorCode.ExplorationMapIdInvilid)
    } finally {
        tables.get = get
        store.close()
    }
})
