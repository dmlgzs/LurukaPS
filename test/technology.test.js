import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { homeCondition } from '../src/home-grid.js'
const c = configuration(),
    t = new Tables(c.tables),
    p = new Protocol(c.base)
function setup() {
    const store = new Store(':memory:'),
        game = new Game(p, store, t),
        session = {}
    let seq = 1
    const call = (name, r, s = session) => {
        const e = p.byName.get('CSProto' + name)
        return game.dispatch(s, { id: e.id, seq: seq++, pushSeq: 0, payload: p.encode(e.req, r) })
    }
    call('EnterGame', { open_id: 'tech' })
    return { store, session, call }
}
test('technology query exposes roots; manual study spends shared points and updates its level condition', () => {
    const { store, session, call } = setup()
    try {
        const info = p.decode('SCTechnologyTypeInfo', call('HomeTechnologyTypeInfo', { type: 1 })[0].payload).info
        assert.equal(info.list.find((x) => x.subType === 10002).subLevel, 1)
        assert.equal(info.list.find((x) => x.subType === 10020).subLevel, 0)
        let before = store.load(session.id)
        assert.throws(() => call('HomeTechnologyLevelUp', { type: 1, subType: 10020 }), /requirement/)
        assert.deepEqual(store.load(session.id), before)
        store.transact(session.id, 0, (s) => {
            s.player.basic_info.lv = 6
        })
        const out = call('HomeTechnologyLevelUp', { type: 1, subType: 10020 })
        const homePacket = out.find((packet) => packet.id === 6102)
        assert(homePacket)
        const home = p.decode('SCHomeSync', homePacket.payload)
        assert.equal(home.technology.totalPoint, 1)
        assert.equal(home.technology.point, 0)
        const state = store.load(session.id).state
        assert.equal(state.home.technology.spent, 1)
        assert(homeCondition('11012#10020#1', state))
        assert(!state.player.attr_infos.attrs.some((x) => x.attr_id === 201))
        before = store.load(session.id)
        assert.throws(() => call('HomeTechnologyLevelUp', { type: 1, subType: 10020 }), /maximum/)
        assert.deepEqual(store.load(session.id), before)
        const relog = call('EnterGame', { open_id: 'tech' }, {})
        const saved = p.decode('SCHomeSync', relog.find((x) => x.id === 6102).payload)
        assert.equal(saved.technology.list.find((x) => x.type === 1).list.find((x) => x.subType === 10020).subLevel, 1)
    } finally {
        store.close()
    }
})
test('technology category, prerequisite and point checks are atomic', () => {
    const { store, session, call } = setup()
    try {
        store.transact(session.id, 0, (s) => {
            s.player.basic_info.lv = 5
        })
        let before = store.load(session.id)
        assert.throws(() => call('HomeTechnologyLevelUp', { type: 1, subType: 10020 }), /points/)
        assert.deepEqual(store.load(session.id), before)
        store.transact(session.id, 0, (s) => {
            s.player.basic_info.lv = 50
        })
        before = store.load(session.id)
        for (const r of [
            { type: 2, subType: 10020 },
            { type: 1, subType: 10025 },
            { type: 1, subType: 999999 },
        ]) {
            assert.throws(() => call('HomeTechnologyLevelUp', r))
            assert.deepEqual(store.load(session.id), before)
        }
    } finally {
        store.close()
    }
})
