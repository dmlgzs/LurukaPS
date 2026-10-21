import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'

test('6019 bulk rank rewards use the level bitmap, preserve uint64 high bits and atomically award only fresh achieved tiers', () => {
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
    let guid
    const hero = () => state().player.heros_info.heros.find((row) => row.guid === guid)
    const claim = (rank_id = 0, hero_id = guid) => call('HeroRankReward', { hero_id, rank_id })
    const result = (packets) => protocol.decode(protocol.byId.get(6019).rsp, packets.at(-1).payload)
    const count = (id) =>
        state()
            .player.sbag_infos.items.filter((row) => row.itemid === id)
            .reduce((n, row) => n + row.itemnum, 0)
    const bit = 1n << 60n
    try {
        call('EnterGame', { open_id: 'rank-reward' })
        guid = state().player.heros_info.heros.find((row) => row.conf_id === 108001).guid
        store.transact(session.id, 0, (s) => {
            const h = s.player.heros_info.heros.find((row) => row.guid === guid)
            h.hero_rank = 6
            h.hero_rank_reward = String(bit)
        })
        const gold = state().player.basic_info.gold,
            tickets = count(501000)
        const packets = claim(4)
        assert.equal(result(packets).src, 112)
        assert.equal(count(501000), tickets + 1)
        assert.equal(BigInt(hero().hero_rank_reward), bit | (1n << 4n))
        const sync = protocol.byName.get('CSProtoSyncPlayerData')
        const updated = packets
            .slice(0, -1)
            .filter((packet) => packet.id === sync.id)
            .map((packet) => protocol.decode(sync.rsp, packet.payload))
            .find((data) => data.heros_info)
        assert.equal(
            updated.heros_info.heros.find((row) => row.guid === guid).hero_rank_reward,
            String(bit | (1n << 4n)),
        )
        assert.equal(
            result(claim())
                .rewards.filter((row) => row.itemtype === 10)
                .reduce((sum, row) => sum + row.itemnum, 0),
            9500,
        )
        assert.equal(state().player.basic_info.gold, gold + 9500)
        assert.equal(count(501000), tickets + 1)
        assert.equal(BigInt(hero().hero_rank_reward), bit | (1n << 2n) | (1n << 4n) | (1n << 6n))
        assert.deepEqual(result(claim()).rewards, [])
        call('EnterGame', { open_id: 'rank-reward' }, {})
        assert.deepEqual(result(claim()).rewards, [])
        assert.equal(state().player.basic_info.gold, gold + 9500)
        assert.throws(
            () => claim(12),
            (error) => error.code === ErrorCode.InvalidArgument,
        )
        assert.throws(
            () => claim(1),
            (error) => error.code === ErrorCode.HeroRankRewardConfNone,
        )
        assert.throws(
            () => claim(0, '99999999'),
            (error) => error.code === ErrorCode.HeroNotExist,
        )
        store.transact(session.id, 0, (s) => {
            const h = s.player.heros_info.heros.find((row) => row.guid === guid)
            h.hero_rank = 8
            h.hero_rank_reward = String(bit)
        })
        const row = tables.get('talent_rank_reward').find((row) => row.level === 8),
            original = row.item
        row.item = '3#4294967295#1'
        const before = structuredClone(state())
        assert.throws(
            () => claim(),
            (error) => error.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(state(), before)
        row.item = original
        store.transact(session.id, 0, (s) => {
            s.player.heros_info.heros.find((row) => row.guid === guid).hero_rank_reward = Number(bit)
        })
        assert.throws(
            () => claim(),
            (error) => error.code === ErrorCode.GameConfig,
        )
    } finally {
        store.close()
    }
})
