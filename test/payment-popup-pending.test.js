import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
const config = configuration(),
    tables = new Tables(config.tables)
test('controlled old-save single pendingPopup is consumed after FIFO exactly once, rolls back on codec failure and stays consumed across SQLite restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payment-popup-pending-')),
        file = path.join(dir, 'state.sqlite'),
        protocol = new Protocol(config.base)
    let store,
        game,
        session,
        seq = 1
    const call = (name, data = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, data) })
            .map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    }
    const connect = () => {
        store = new Store(file)
        game = new Game(protocol, store, tables)
        session = {}
        call('EnterGame', { open_id: 'controlled-pending-popup' })
    }
    const next = () => call('GetRechargePopupData').find((p) => p.id === 18048).data
    const pending = {
        popup_id: 82,
        pay_source: 0,
        purchase_sdk_id: 2006,
        recharge_diamond: {
            purchase_sdk_id: 2006,
            rewards: { rewards: [{ itemtype: 10, itemid: 901, itemnum: 6480 }] },
        },
    }
    const encode = protocol.encode.bind(protocol)
    try {
        connect()
        // Explicit controlled state: no evidence says a historical producer wrote it.
        store.transact(session.id, 0, (s) => {
            s.mall = { popupQueue: [{ ...pending, popup_id: 81 }], pendingPopup: pending }
        })
        const attrs = structuredClone(store.load(session.id).state.player.attr_infos)
        assert.equal(next().popup_id, 81)
        const before = store.load(session.id)
        protocol.encode = (name, data) => {
            if (name === protocol.byId.get(18048).rsp) throw Error('pending popup codec')
            return encode(name, data)
        }
        assert.throws(next, /pending popup codec/)
        assert.deepEqual(store.load(session.id), before)
        protocol.encode = encode
        assert.deepEqual(
            next(),
            protocol.decode(protocol.byId.get(18048).rsp, encode(protocol.byId.get(18048).rsp, pending)),
        )
        assert.equal(Object.hasOwn(store.load(session.id).state.mall, 'pendingPopup'), false)
        assert.equal(next().popup_id, 0)
        store.close()
        connect()
        assert.equal(next().popup_id, 0)
        assert.deepEqual(store.load(session.id).state.player.attr_infos, attrs)
    } finally {
        protocol.encode = encode
        store?.close()
        assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
