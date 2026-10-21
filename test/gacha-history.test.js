import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'
import { gachaTables } from '../src/gacha-tables.js'

test('9705 replies via 9706, paginates uint64 IDs by category without repeats and preserves history on relog', () => {
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
    const page = (cursor = '0', select_num = 2, gacha_type = 9) => {
        const packets = call('GachaHistory', { gacha_type, cursor, select_num })
        assert.equal(packets.at(-1).id, 9705)
        const push = packets.slice(0, -1).find((packet) => packet.id === 9706)
        assert.ok(push)
        return protocol.decode(protocol.byId.get(9706).rsp, push.payload)
    }
    const state = () => store.load(session.id).state
    try {
        call('EnterGame', { open_id: 'gacha-history' })
        assert.equal(gachaTables(tables).find('gacha', 8001).gachaId, 8001)
        assert.equal(gachaTables(tables).find('gacha_guarantee', 802).guaranteeId, 802)
        assert.deepEqual(page(), { items: [], total_count: '0', next_cursor: '0', has_more: false })
        call('GachaData')
        const rows = Array.from({ length: 7 }, (_, i) => ({
            record_id: String(9007199254740993n + BigInt(i)),
            gacha_time: '1790000000',
            pool_id: i % 2 ? 10001 : 9001,
            gacha_type: i % 2 ? 10 : 9,
            item: [{ item_type: 9, item_id: 10032, item_num: 1 }],
        }))
        rows.push({ ...rows[0], record_id: '18446744073709551615', pool_id: 4294967000 })
        store.transact(session.id, 0, (s) => {
            s.gacha.history = rows
        })
        const collected = [],
            expected = rows
                .filter((row) => row.gacha_type === 9)
                .map((row) => row.record_id)
                .sort((a, b) => (BigInt(a) > BigInt(b) ? -1 : 1))
        let cursor = '0'
        do {
            const result = page(cursor)
            assert.equal(result.total_count, String(expected.length))
            collected.push(...result.items.map((row) => row.record_id))
            if (!result.has_more) break
            assert.notEqual(result.next_cursor, '0')
            cursor = result.next_cursor
        } while (collected.length <= rows.length)
        assert.deepEqual(collected, expected)
        assert.equal(new Set(collected).size, collected.length)
        assert.equal(page('0', 100, 10).total_count, '3')
        assert.deepEqual(state().gacha.history, rows)
        call('EnterGame', { open_id: 'gacha-history' }, {})
        assert.equal(page().items[0].record_id, '18446744073709551615')
        const before = structuredClone(state())
        assert.throws(
            () => page('0', 101),
            (error) => error.code === ErrorCode.InvalidArgument,
        )
        assert.throws(
            () => page('0', 2, 0),
            (error) => error.code === ErrorCode.InvalidArgument,
        )
        assert.deepEqual(state(), before)
        store.transact(session.id, 0, (s) => {
            s.gacha.history.push(structuredClone(s.gacha.history[0]))
        })
        assert.throws(
            () => page(),
            (error) => error.code === ErrorCode.GameConfig,
        )
    } finally {
        store.close()
    }
})
