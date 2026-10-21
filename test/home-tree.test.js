import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { homeTreePayload } from '../src/home-tree.js'
import { ErrorCode } from '../src/error-codes.js'

function setup(name, override) {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base),
        store = new Store(':memory:')
    if (override) {
        const get = tables.get.bind(tables)
        tables.get = (key) => override(key, get(key))
    }
    const game = new Game(protocol, store, tables),
        session = {}
    let seq = 1
    const call = (name, request = {}, target = session) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(target, {
            id: e.id,
            seq: seq++,
            payload: e.req ? protocol.encode(e.req, request) : Buffer.alloc(0),
        })
    }
    call('EnterGame', { open_id: name })
    store.transact(session.id, 0, (s) => {
        s.world.map_id = Number(tables.get('game').find((r) => r.title === 'HOME_ID').value)
    })
    return { tables, protocol, store, game, session, call, state: () => store.load(session.id).state }
}
function activate(s, tables, count) {
    const valid = tables
        .get('home_technology_tree')
        .filter((t) =>
            tables.get('home_technology').some((r) => r.type === t.id && (r.newTechnologyProduct || r.buffId)),
        )
    for (const node of valid.slice(0, count)) s.home.technology.levels[node.id] = { level: 1, lastTime: 0 }
}

test('tree progress follows activated recipe/buff nodes and syncs after actual technology study', () => {
    const f = setup('tree-science')
    try {
        const initial = homeTreePayload(f.tables, f.state())
        assert.deepEqual(initial, { stage: 1, process: 0, is_new: false, sub_process: [0, 0, 0, 0] })
        f.store.transact(f.session.id, 0, (s) => {
            s.player.basic_info.lv = 6
        })
        const out = f.call('HomeTechnologyLevelUp', { type: 1, subType: 10020 })
        const wire = f.protocol.decode('SCHomeSync', out.find((p) => p.id === 6102).payload).tree
        assert(wire.process >= 1)
        assert.equal(
            wire.process,
            wire.sub_process.reduce((a, b) => a + b, 0),
        )
        assert.equal(wire.sub_process.length, 4)
        assert.equal(wire.sub_process[3], 0)
        const s = f.state(),
            before = homeTreePayload(f.tables, s)
        s.home.exp += 100000
        s.home.technology.spent += 100000
        assert.deepEqual(homeTreePayload(f.tables, s), before)
        const node = f.tables
            .get('home_technology_tree')
            .find(
                (t) =>
                    t.isAutoUnlock === 1 &&
                    !s.home.technology.levels[t.id]?.level &&
                    f.tables
                        .get('home_technology')
                        .some((r) => r.type === t.id && (r.newTechnologyProduct || r.buffId)),
            )
        s.home.technology.levels[node.id] = { level: 1 }
        const after = homeTreePayload(f.tables, s)
        assert(after.process > before.process, 'automatic nodes with real outputs also count')
        assert.equal(after.sub_process[node.category - 1], before.sub_process[node.category - 1] + 1)
    } finally {
        f.store.close()
    }
})

test('6080 upgrades one configured stage, preserves other home state and barriers pending retries across login', () => {
    const f = setup('tree-upgrade')
    try {
        f.store.transact(f.session.id, 0, (s) => activate(s, f.tables, 50))
        const before = f.state(),
            out = f.call('HomeTreeUpgrade')
        assert.equal(out.at(-1).id, 6080)
        assert(out.findIndex((p) => p.id === 6102) < out.length - 1)
        const tree = f.protocol.decode('SCHomeSync', out.find((p) => p.id === 6102).payload).tree
        assert.equal(tree.stage, 2)
        assert.equal(tree.is_new, true)
        const after = f.state()
        assert.equal(after.home.stage, before.home.stage)
        assert.equal(after.home.level, before.home.level)
        assert.equal(after.home.exp, before.home.exp)
        assert.deepEqual(after.player, before.player)
        assert.deepEqual(after.home.builds, before.home.builds)
        for (let i = 0; i < 2; i++) {
            f.call('HomeTreeUpgrade')
            assert.equal(f.state().home.tree.stage, 2)
        }
        const relog = f.call('EnterGame', { open_id: 'tree-upgrade' }, {})
        const saved = f.protocol.decode('SCHomeSync', relog.find((p) => p.id === 6102).payload).tree
        assert.equal(saved.stage, 2)
        assert.equal(saved.is_new, true)
        f.call('HomeTreeUpgrade')
        assert.equal(f.state().home.tree.stage, 2)
    } finally {
        f.store.close()
    }
})

test('6080 uses current configured next threshold and dedicated max/progress errors atomically', () => {
    const f = setup('tree-threshold', (name, rows) =>
        name === 'home_landscape_tree'
            ? rows.map((r) => (r.landscapeTreeStage === 2 ? { ...r, upNeedschedule: 17 } : r))
            : rows,
    )
    try {
        f.store.transact(f.session.id, 0, (s) => activate(s, f.tables, 10))
        let before = f.store.load(f.session.id)
        assert.throws(
            () => f.call('HomeTreeUpgrade'),
            (e) => e.code === ErrorCode.HomeTreeProcessNotEnough,
        )
        assert.deepEqual(f.store.load(f.session.id), before)
        f.store.transact(f.session.id, 0, (s) => activate(s, f.tables, 17))
        f.call('HomeTreeUpgrade')
        assert.equal(f.state().home.tree.stage, 2)
        f.store.transact(f.session.id, 0, (s) => {
            s.home.tree = { stage: 6, is_new: false }
        })
        before = f.store.load(f.session.id)
        assert.throws(
            () => f.call('HomeTreeUpgrade'),
            (e) => e.code === ErrorCode.HomeTreeLevelIsMax,
        )
        assert.deepEqual(f.store.load(f.session.id), before)
    } finally {
        f.store.close()
    }
})

test('wrong scene, corrupt stage and failed encoding never leak a tree advancement', () => {
    const f = setup('tree-atomic')
    try {
        f.store.transact(f.session.id, 0, (s) => {
            activate(s, f.tables, 50)
            s.world.map_id = 100
        })
        let before = f.store.load(f.session.id)
        assert.throws(
            () => f.call('HomeTreeUpgrade'),
            (e) => e.code === ErrorCode.PlayerNotInHome,
        )
        assert.deepEqual(f.store.load(f.session.id), before)
        f.store.transact(f.session.id, 0, (s) => {
            s.world.map_id = Number(f.tables.get('game').find((r) => r.title === 'HOME_ID').value)
            s.home.tree.stage = 999
        })
        before = f.store.load(f.session.id)
        assert.throws(
            () => f.call('HomeTreeUpgrade'),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.store.load(f.session.id), before)
        f.store.transact(f.session.id, 0, (s) => {
            s.home.tree.stage = 1
        })
        before = f.store.load(f.session.id)
        const packet = f.game.packet
        f.game.packet = function (name, ...args) {
            if (name === 'CSProtoHomeSync') throw Error('tree encoding failed')
            return packet.call(this, name, ...args)
        }
        assert.throws(() => f.call('HomeTreeUpgrade'), /tree encoding failed/)
        assert.deepEqual(f.store.load(f.session.id), before)
        f.game.packet = packet
        f.call('HomeTreeUpgrade')
        assert.equal(f.state().home.tree.stage, 2)
    } finally {
        f.store.close()
    }
})
