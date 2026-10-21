import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { grantRewards } from '../src/rewards.js'
import { ErrorCode } from '../src/error-codes.js'

test('6018 crafts table runes with direct and recursive costs, reserves intermediate stock and publishes real inventory before ACK', () => {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base),
        store = new Store(':memory:'),
        game = new Game(protocol, store, tables),
        session = {}
    let seq = 1
    const call = (name, data = {}, who = session) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(who, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, data) })
    }
    const state = () => store.load(session.id).state
    const count = (id) =>
        state()
            .player.sbag_infos.items.filter((row) => row.itemid === id)
            .reduce((n, row) => n + row.itemnum, 0)
    try {
        call('EnterGame', { open_id: 'rune-compose' })
        store.transact(session.id, 0, (s) => {
            s.player.sbag_infos.items = []
            s.entrust ??= { records: {} }
            s.entrust.records ??= {}
            for (const row of tables.get('talent_rune_compose')) {
                const [kind, id, value] = row.condition.split('#').map(Number)
                if (kind === 13044) s.entrust.records[id] = { entrust_star: value }
            }
            grantRewards(tables, s, [
                { itemtype: 3, itemid: 1530002, itemnum: 100 },
                { itemtype: 3, itemid: 1531001, itemnum: 1 },
            ])
        })
        const direct = call('ComposeRune', { item_id: 1531001, num: 2, equip: true })
        assert.equal(direct.at(-1).id, 6018)
        const decoded = protocol.decode(protocol.byId.get(6018).rsp, direct.at(-1).payload)
        assert.equal(decoded.equip, true)
        assert.equal(decoded.rewards.rewards[0].itemnum, 2)
        assert.equal(count(1531001), 3)
        assert.equal(count(1530002), 90)
        const sync = protocol.byName.get('CSProtoSyncPlayerData')
        assert.ok(
            direct
                .slice(0, -1)
                .some((packet) => packet.id === sync.id && protocol.decode(sync.rsp, packet.payload).sbag_infos),
        )
        call('ComposeRune', {
            item_id: 1532001,
            num: 1,
            oneKey: true,
            costItems: [
                { item_type: 3, item_id: 1531001, item_num: 3 },
                { item_type: 3, item_id: 1530002, item_num: 15 },
            ],
        })
        assert.equal(count(1532001), 1)
        assert.equal(count(1531001), 0)
        assert.equal(count(1530002), 75)
        call('EnterGame', { open_id: 'rune-compose' }, {})
        assert.equal(count(1532001), 1)
        const before = structuredClone(state())
        assert.throws(() =>
            call('ComposeRune', {
                item_id: 1532001,
                num: 1,
                costItems: [{ item_type: 3, item_id: 1530002, item_num: 1 }],
            }),
        )
        assert.throws(
            () => call('ComposeRune', { item_id: 1531001, num: 999 }),
            (error) => error.code === ErrorCode.RuneBaseMaterialLimt,
        )
        assert.throws(
            () => call('ComposeRune', { item_id: 1531001, num: 1000 }),
            (error) => error.code === ErrorCode.InvalidArgument,
        )
        assert.throws(
            () => call('ComposeRune', { item_id: 0xffffffff, num: 1 }),
            (error) => error.code === ErrorCode.RuneComConfNotFound,
        )
        assert.deepEqual(state(), before)
        store.transact(session.id, 0, (s) => {
            s.entrust.records = {}
        })
        assert.throws(
            () => call('ComposeRune', { item_id: 1531001, num: 1 }),
            (error) => error.code === ErrorCode.RuneConditionLimit,
        )
    } finally {
        store.close()
    }
})
