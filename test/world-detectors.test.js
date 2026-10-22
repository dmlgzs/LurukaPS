import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fixture, tables, world, count, cfg } from './world-detectors-fixture.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'
import { assertSyncBefore } from './exchange-sync-assertions.js'
const result = (out) => out.find((p) => p.id === 11075).data.obj_id
function unchanged(f, fn, code) {
    const before = f.state()
    assert.throws(fn, (e) => e.code === code)
    assert.deepEqual(f.state(), before)
}

test('all six current detector items follow their actual map/filter definitions and only a found target costs one item', () => {
    const items = tables.get('common_item').filter((r) => r.useType === 18)
    assert.equal(items.length, 6)
    for (const item of items) {
        const f = fixture(item.id)
        try {
            const before = f.state(),
                out = f.search(),
                id = result(out)
            assert.equal(id, f.usable[0]?.id ?? 0)
            assert.equal(count(f.state(), item.id), count(before, item.id) - (id ? 1 : 0))
            assert.deepEqual(f.state().worldObjects, before.worldObjects)
            if (id) assertSyncBefore(f.p, out, 'CSProtoSyncPlayerData', 11075)
            else assert.equal(f.map, 102) // Current 102 has no type101 detector targets.
        } finally {
            f.close()
        }
    }
})

test('nearest selection uses current player position and configured target positions, not moved entity positions', () => {
    const f = fixture()
    try {
        assert(f.usable.length >= 2)
        const [a, b] = f.usable
        f.edit((s) => {
            s.worldObjects[f.map + ':' + a.id].pos = { ...world.object(f.map, b.id).pos }
        })
        assert.equal(result(f.search()), a.id)
        f.edit((s) => {
            s.world.pos = { ...world.object(f.map, b.id).pos }
        })
        assert.equal(result(f.search()), b.id)
    } finally {
        f.close()
    }
})

test('equal distance has a deterministic tie break and malformed tool definitions never consume inventory', () => {
    const f = fixture()
    try {
        const [a, b] = f.usable,
            pa = world.object(f.map, a.id).pos,
            pb = world.object(f.map, b.id).pos
        f.edit((s) => {
            s.world.pos = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2, z: (pa.z + pb.z) / 2 }
        })
        assert.equal(result(f.search()), Math.min(a.id, b.id))
    } finally {
        f.close()
    }
    let broken = false
    const source = Object.create(tables)
    source.find = (name, id) => {
        const row = tables.find(name, id)
        return broken && name === 'common_item' && id === 1800007 ? { ...row, useFunction: '100|invalid' } : row
    }
    const g = fixture(1800007, ':memory:', source)
    try {
        broken = true
        unchanged(g, () => g.search(), ErrorCode.GameConfig)
    } finally {
        g.close()
    }
})

test('inactive, completed, story and referenced objects never become detectable merely because a tool is used', () => {
    const f = fixture()
    try {
        for (const row of f.usable.slice(0, 2))
            f.edit((s) => {
                s.worldObjects[f.map + ':' + row.id].complete = true
            })
        const before = f.state()
        assert.equal(result(f.search()), 0)
        assert.equal(count(f.state(), f.itemId), count(before, f.itemId))
        const story = world.get('worldmap_' + f.map).find((r) => r.isstory === 1)
        if (story)
            f.edit((s) => {
                s.worldObjects[f.map + ':' + story.id] = { obj_id: story.id, active: true, complete: false }
            })
        assert.equal(result(f.search()), 0)
    } finally {
        f.close()
    }
})

test('playable detectors consult finish receipts rather than an ordinary world-object completion bit', () => {
    const f = fixture(1800006)
    try {
        const [a, b] = f.usable
        assert(a && b)
        f.edit((s) => {
            s.worldObjects[f.map + ':' + a.id].complete = true
        })
        assert.equal(result(f.search()), a.id)
        f.edit((s) => {
            s.playableFinishes[a.expandId] = { play_id: a.expandId, map_id: f.map, score: 0, reward_info: 0 }
        })
        assert.equal(result(f.search()), b.id)
        f.edit((s) => {
            s.playableFinishes[b.expandId] = { play_id: b.expandId, map_id: f.map, score: 0, reward_info: 0 }
        })
        assert.equal(result(f.search()), 0)
    } finally {
        f.close()
    }
})

test('client-recognized item/map errors do not consume stock and expired stacks cannot authorize a search', () => {
    const f = fixture()
    try {
        unchanged(f, () => f.call('FindUnCompletedWorldObj', { item_id: 0 }), ErrorCode.ParamError)
        unchanged(f, () => f.call('FindUnCompletedWorldObj', { item_id: 0xffffffff }), ErrorCode.InvalidItem)
        unchanged(f, () => f.call('FindUnCompletedWorldObj', { item_id: 1000001 }), ErrorCode.ItemTypeCannotUse)
        unchanged(f, () => f.call('FindUnCompletedWorldObj', { item_id: 1800008 }), ErrorCode.UseItemLimitInMap)
        f.edit((s) => {
            for (const i of s.player.sbag_infos.items) i.deadtime = 1799999999
        })
        unchanged(f, () => f.search(), ErrorCode.ItemNotEnough)
    } finally {
        f.close()
    }
})

test('bag or reply encoding failure atomically rolls back consumption and ordinary repeated uses each cost exactly one', () => {
    for (const name of ['CSProtoFindUnCompletedWorldObj', 'CSProtoSyncPlayerData']) {
        const f = fixture()
        try {
            const before = f.state(),
                encode = f.p.encode.bind(f.p),
                type = f.p.byName.get(name).rsp
            f.p.encode = (n, v) => {
                if (n === type) throw Error('detector codec failure')
                return encode(n, v)
            }
            assert.throws(() => f.search(), /detector codec failure/)
            assert.deepEqual(f.state(), before)
            f.p.encode = encode
            assert(result(f.search()) > 0)
            assert(result(f.search()) > 0)
            assert.equal(count(f.state(), f.itemId), 1)
        } finally {
            f.close()
        }
    }
})

test('detector consumption survives an actual SQLite restart and no target progress or reward is fabricated', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-detector-')),
        file = path.join(dir, 'state.sqlite')
    let f, store
    try {
        f = fixture(1800007, file)
        const id = result(f.search()),
            account = f.session.id,
            before = f.state()
        assert(id > 0)
        f.close()
        f = undefined
        store = new Store(file)
        const after = store.load(account).state
        assert.equal(count(after, 1800007), 2)
        assert.deepEqual(after.worldObjects, before.worldObjects)
        assert.deepEqual(after.playableFinishes, before.playableFinishes)
        const protocol = new Protocol(cfg.base),
            game = new Game(protocol, store, tables, { clock: () => 1800000000 }),
            session = {}
        for (const [name, data] of [
            ['EnterGame', { open_id: 'world-detector' }],
            ['FindUnCompletedWorldObj', { item_id: 1800007 }],
        ]) {
            const e = protocol.byName.get('CSProto' + name)
            const out = game.dispatch(session, { id: e.id, seq: 1, payload: protocol.encode(e.req, data) })
            if (e.id === 11075) assert(protocol.decode(e.rsp, out.find((p) => p.id === e.id).payload).obj_id > 0)
        }
        assert.equal(count(store.load(account).state, 1800007), 1)
    } finally {
        f?.close()
        store?.close()
        assert.equal(path.dirname(dir), os.tmpdir())
        assert(path.basename(dir).startsWith('lurukaps-detector-'))
        fs.rmSync(dir, { recursive: true })
    }
})
