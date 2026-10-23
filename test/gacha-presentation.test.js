import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { gachaTables } from '../src/gacha-tables.js'
import { grantRewards } from '../src/rewards.js'
import { ErrorCode } from '../src/error-codes.js'

const config = configuration()
const tables = new Tables(config.tables)
const current = gachaTables(tables)
const protocol = new Protocol(config.base)
function fixture(name, rng = (maximum) => maximum - 1) {
    const store = new Store(':memory:')
    const game = new Game(protocol, store, tables, { clock: () => 1790000000, rng })
    const session = {}
    let seq = 1
    const frame = (name, value) => {
        const entry = protocol.byName.get('CSProto' + name)
        return { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, value) }
    }
    game.dispatch(session, frame('EnterGame', { open_id: name }))
    const edit = (fn) => store.transact(session.id, 0, fn)
    edit((state) => {
        for (const row of current.get('gacha_type'))
            grantRewards(tables, state, [{ itemtype: 3, itemid: row.costItem, itemnum: 100 }])
    })
    const drawFrame = (poolId, count) => frame('GachaDraw', { pool_id: poolId, draw_count: count })
    const send = (request) => {
        const packets = game.dispatch(session, request)
        return protocol.decode('SCDoGachaRsp', packets.find((packet) => packet.id === 9701).payload)
    }
    return { store, edit, drawFrame, send, state: () => store.load(session.id).state }
}

test('9701 returns present surprise objects for every result across all five actual card pools', () => {
    const f = fixture('gacha-presentation-all-pools')
    try {
        for (const row of current.get('gacha')) {
            const count = row.onlyTenPull ? 10 : 1
            const reply = f.send(f.drawFrame(row.gachaId, count))
            assert.equal(reply.gacha_results.length, count)
            for (const result of reply.gacha_results) {
                // CBT3 PageGachaShow.CheckUpgradeSurprise dereferences this
                // object without checking the proto2 optional field for null.
                assert(result.gacha_surprise, 'missing surprise presentation')
                assert.deepEqual(result.gacha_surprise, { surprise_type: 0 })
            }
        }
    } finally {
        f.store.close()
    }
})

test('a paid legacy receipt missing presentation replays normally without another fee, award or history row', () => {
    const f = fixture('gacha-presentation-legacy')
    try {
        const request = f.drawFrame(1001, 10)
        const first = f.send(request)
        f.edit((state) => {
            for (const receipt of Object.values(state.gacha.draw_receipts))
                for (const result of receipt.reply.gacha_results) delete result.gacha_surprise
        })
        const before = f.state()
        assert.deepEqual(f.send(request).gacha_results, first.gacha_results)
        assert.deepEqual(f.state(), before, 'wire compatibility must not rewrite or re-settle the paid receipt')
    } finally {
        f.store.close()
    }
})

test('explicit known surprise flags are preserved and malformed saved flags fail without a new draw', () => {
    const f = fixture('gacha-presentation-flags', () => 0)
    try {
        const request = f.drawFrame(1001, 1)
        f.send(request)
        for (const value of [1, 2]) {
            f.edit((state) => {
                Object.values(state.gacha.draw_receipts)[0].reply.gacha_results[0].gacha_surprise = {
                    surprise_type: value,
                }
            })
            const before = f.state()
            assert.equal(f.send(request).gacha_results[0].gacha_surprise.surprise_type, value)
            assert.deepEqual(f.state(), before)
        }
        for (const value of [null, [], {}, { surprise_type: 3 }, { surprise_type: -1 }, { surprise_type: '1' }]) {
            f.edit((state) => {
                Object.values(state.gacha.draw_receipts)[0].reply.gacha_results[0].gacha_surprise = value
            })
            const before = f.state()
            assert.throws(
                () => f.send(request),
                (error) => error.code === ErrorCode.GameConfig,
            )
            assert.deepEqual(f.state(), before)
        }
    } finally {
        f.store.close()
    }
})

test('9701 presentation codec failure rolls back the complete paid draw and its receipt', () => {
    const f = fixture('gacha-presentation-codec')
    const encode = protocol.encode
    try {
        const request = f.drawFrame(1001, 10)
        const before = f.state()
        protocol.encode = function (name, value) {
            if (name === 'cs.SCDoGachaRsp') {
                assert(value.gacha_results.every((result) => result.gacha_surprise?.surprise_type === 0))
                throw Error('intentional surprise codec failure')
            }
            return encode.call(this, name, value)
        }
        assert.throws(() => f.send(request), /intentional surprise codec failure/)
        assert.deepEqual(f.state(), before)
    } finally {
        protocol.encode = encode
        f.store.close()
    }
})
