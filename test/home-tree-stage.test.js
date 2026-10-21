import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'

function fixture(name) {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base),
        store = new Store(':memory:'),
        game = new Game(protocol, store, tables),
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
        for (const node of tables.get('home_technology_tree')) s.home.technology.levels[node.id] = { level: 1 }
    })
    return { tables, protocol, store, game, session, call, state: () => store.load(session.id).state }
}

test('6099 acknowledges each configured stage without advancing it or changing rewards', () => {
    const f = fixture('tree-done')
    try {
        const before = f.state(),
            stages = f.tables.get('home_landscape_tree')
        const wire = (out) => f.protocol.decode('SCHomeSync', out.find((p) => p.id === 6102).payload).tree
        for (const row of stages.slice(1)) {
            assert.equal(wire(f.call('HomeTreeUpgrade')).stage, row.landscapeTreeStage)
            const out = f.call('HomeTreeStageDone')
            assert.equal(out.at(-1).id, 6099)
            assert.equal(wire(out).stage, row.landscapeTreeStage)
            assert.equal(wire(out).is_new, false)
            const settled = f.state()
            assert.deepEqual(settled.player, before.player)
            assert.equal(settled.home.exp, before.home.exp)
            assert.equal(settled.home.stage, before.home.stage)
            f.call('HomeTreeStageDone')
            assert.deepEqual(f.state(), settled)
        }
        assert.throws(
            () => f.call('HomeTreeUpgrade'),
            (e) => e.code === ErrorCode.HomeTreeLevelIsMax,
        )
    } finally {
        f.store.close()
    }
})

test('6099 is harmless before upgrading and accepts a late acknowledgement after leaving home', () => {
    const f = fixture('tree-late-done')
    try {
        const before = f.state()
        f.call('HomeTreeStageDone')
        assert.deepEqual(f.state(), before)
        f.call('HomeTreeUpgrade')
        f.store.transact(f.session.id, 0, (s) => {
            s.world.map_id = 100
            s.world.pos = { x: 1, y: 2, z: 3 }
        })
        const old = f.state()
        f.call('HomeTreeStageDone')
        const after = f.state()
        assert.equal(after.home.tree.stage, 2)
        assert.equal(after.home.tree.is_new, false)
        assert.deepEqual(after.world, old.world)
        const out = f.call('EnterGame', { open_id: 'tree-late-done' }, {})
        const saved = f.protocol.decode('SCHomeSync', out.find((p) => p.id === 6102).payload).tree
        assert.equal(saved.stage, 2)
        assert.equal(saved.is_new, false)
    } finally {
        f.store.close()
    }
})

test('6099 encoding failure retains the pending stage and can be retried safely', () => {
    const f = fixture('tree-done-rollback')
    try {
        f.call('HomeTreeUpgrade')
        const before = f.store.load(f.session.id),
            packet = f.game.packet
        f.game.packet = function (name, ...args) {
            if (name === 'CSProtoHomeSync') throw Error('stage done encoding failed')
            return packet.call(this, name, ...args)
        }
        assert.throws(() => f.call('HomeTreeStageDone'), /stage done encoding failed/)
        assert.deepEqual(f.store.load(f.session.id), before)
        f.game.packet = packet
        f.call('HomeTreeStageDone')
        assert.equal(f.state().home.tree.is_new, false)
        f.call('HomeTreeUpgrade')
        assert.equal(f.state().home.tree.stage, 3)
    } finally {
        f.store.close()
    }
})
