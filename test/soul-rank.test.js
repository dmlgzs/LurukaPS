import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables, seedPlayer } from '../src/player.js'
import { nextSoulRank } from '../src/soul-rank.js'
import { ErrorCode } from '../src/error-codes.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { grantRewards } from '../src/rewards.js'
import { heroModules } from '../src/battle.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables)
function fixture(name) {
    const store = new Store(':memory:'),
        protocol = new Protocol(cfg.base),
        game = new Game(protocol, store, tables),
        session = {}
    let seq = 1
    const call = (name, data = {}, who = session) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(who, { id: e.id, seq: seq++, payload: protocol.encode(e.req, data) })
    }
    call('EnterGame', { open_id: name })
    store.transact(session.id, 0, (s) => {
        const soul = s.player.soulessence_infos.soulessences.find((x) => x.guid === 10044)
        soul.lv = 30
        soul.exp = 500
        s.player.basic_info.lv = 20
        s.player.basic_info.gold = 20000
    })
    const state = () => store.load(session.id).state
    return {
        store,
        session,
        call,
        protocol,
        state,
        soul: () => state().player.soulessence_infos.soulessences.find((x) => x.guid === 10044),
    }
}
test('75 actual soul templates have six table-defined rank transitions and a terminal seventh rank', () => {
    const s = seedPlayer(tables, 1, 'soul-ranks')
    s.player.basic_info.lv = 100
    assert.equal(s.player.soulessence_infos.soulessences.length, 75)
    for (const item of s.player.soulessence_infos.soulessences) {
        for (let rank = 1; rank < 7; rank++) {
            const row = tables.get('soulessence_rank').find((r) => r.relatedId === item.id && r.rank === rank)
            item.rank = rank
            item.lv = row.rankLevelLimit
            const next = nextSoulRank(tables, s, item)
            assert.equal(next.rank, rank + 1)
            assert.equal(next.gold, row.rankUpCoin)
            assert.equal(next.costs.size, 0) // All current rankUpItem lists are empty.
        }
        item.rank = 7
        assert.throws(
            () => nextSoulRank(tables, s, item),
            (e) => e.code === ErrorCode.SoulEssenceMaxRank,
        )
    }
})
test('6049 checks current rank cap and player gate, preserves XP/identity/equipment and publishes before ACK', () => {
    const f = fixture('soul-rank-equipped')
    try {
        let guid
        f.store.transact(f.session.id, 0, (s) => {
            const h = s.player.heros_info.heros.find((h) => h.conf_id === 107002),
                soul = s.player.soulessence_infos.soulessences.find((x) => x.guid === 10044)
            guid = h.guid
            h.wguid = soul.guid
            soul.wear_hero = guid
            s.player.basic_info.lv = 19
        })
        const before = structuredClone(f.state())
        assert.throws(
            () => f.call('RankUpSoulEssence', { guid: 10044 }),
            (e) => e.code === ErrorCode.SoulEssenceRankUpPLv,
        )
        assert.deepEqual(f.state(), before)
        f.store.transact(f.session.id, 0, (s) => (s.player.basic_info.lv = 20))
        const oldSoul = structuredClone(f.soul()),
            heroBefore = f.state().player.heros_info.heros.find((h) => h.guid === guid),
            attrs = heroModules(tables, f.state(), heroBefore)
        const packets = f.call('RankUpSoulEssence', { guid: 10044 }),
            ack = packets.findIndex((p) => p.id === 6049)
        assert(ack >= 0)
        assert.equal(f.soul().rank, 2)
        assert.equal(f.state().player.basic_info.gold, 10000)
        assert.deepEqual(f.soul(), { ...oldSoul, rank: 2 })
        assert(packets.slice(0, ack).some((p) => p.id === f.protocol.byName.get('CSProtoSyncPlayerData').id))
        // Current tables have no rankUpAttributeAll. No phantom stat gain or heal.
        assert.deepEqual(
            heroModules(
                tables,
                f.state(),
                f.state().player.heros_info.heros.find((h) => h.guid === guid),
            ),
            attrs,
        )
        const saved = structuredClone(f.state())
        assert.throws(
            () => f.call('RankUpSoulEssence', { guid: 10044 }),
            (e) => e.code === ErrorCode.SoulEssenceCantRankUp,
        )
        assert.deepEqual(f.state(), saved)
        f.call('EnterGame', { open_id: 'soul-rank-equipped' }, {})
        assert.equal(f.soul().rank, 2)
        assert.equal(f.soul().exp, 500)
        f.store.transact(f.session.id, 0, (s) =>
            grantRewards(tables, s, [
                { itemtype: 3, itemid: 400003, itemnum: 10 },
                { itemtype: 10, itemid: 2, itemnum: 100000 },
            ]),
        )
        f.call('ComposeSoulEssence', { guid: 10044, cost_items: [{ id: 400003, num: 10 }] })
        assert(f.soul().lv > 30 && f.soul().lv <= 50)
    } finally {
        f.store.close()
    }
})
test('rank material tuples aggregate and failed material/gold consumption rolls back atomically', () => {
    const f = fixture('soul-rank-costs'),
        row = tables.get('soulessence_rank').find((r) => r.relatedId === 10044 && r.rank === 1),
        original = row.rankUpItem
    try {
        // Current lists are empty; use a temporary fixture for the client schema's id/count branch.
        row.rankUpItem = '301000#2|301000#3'
        const before = structuredClone(f.state())
        assert.throws(
            () => f.call('RankUpSoulEssence', { guid: 10044 }),
            (e) => e.code === ErrorCode.ItemNotEnough,
        )
        assert.deepEqual(f.state(), before)
        f.store.transact(f.session.id, 0, (s) => grantRewards(tables, s, [{ itemtype: 3, itemid: 301000, itemnum: 5 }]))
        f.call('RankUpSoulEssence', { guid: 10044 })
        assert.equal(f.state().player.sbag_infos.items.find((i) => i.itemid === 301000).itemnum, 0)
        assert.equal(f.state().player.basic_info.gold, 10000)
        assert.equal(f.soul().rank, 2)
    } finally {
        row.rankUpItem = original
        f.store.close()
    }
})
test('rank rejects unknown/preview souls, underlevel and maximum rank with distinct native errors', () => {
    const f = fixture('soul-rank-errors')
    try {
        assert.throws(
            () => f.call('RankUpSoulEssence', { guid: 999999 }),
            (e) => e.code === ErrorCode.SoulEssenceNotExist,
        )
        for (const patch of [{ zombie: true }, { lv: 29 }]) {
            f.store.transact(f.session.id, 0, (s) => {
                const item = s.player.soulessence_infos.soulessences.find((x) => x.guid === 10044)
                delete item.zombie
                Object.assign(item, patch)
            })
            assert.throws(
                () => f.call('RankUpSoulEssence', { guid: 10044 }),
                (e) => e.code === ErrorCode.SoulEssenceCantRankUp,
            )
        }
        f.store.transact(f.session.id, 0, (s) => {
            const item = s.player.soulessence_infos.soulessences.find((x) => x.guid === 10044)
            delete item.zombie
            item.rank = 7
            item.lv = 100
        })
        assert.throws(
            () => f.call('RankUpSoulEssence', { guid: 10044 }),
            (e) => e.code === ErrorCode.SoulEssenceMaxRank,
        )
    } finally {
        f.store.close()
    }
})
