import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fixture, tables } from './ecology-progress-fixture.js'
import { Store } from '../src/store.js'
import { ErrorCode } from '../src/error-codes.js'
import { assertSyncBefore } from './exchange-sync-assertions.js'
const claim = (f, id) => f.call('WorldEcologyGetReward', { id })
const response = (out) => out.find((p) => p.id === 9192).data
function finish(f, id) {
    const event = f.state().ecology.events[id],
        t = tables.find('world_eep_template', event.template_id)
    for (let step = 1; step <= t.stepMax; step++) f.step(id, step)
    f.step(id, t.stepMax)
}
function unchanged(f, fn, code) {
    const before = f.state()
    assert.throws(fn, (e) => e.code === code)
    assert.deepEqual(f.state(), before)
}

test('9192 pays only completed selected templates, creates the actual egg before ACK and handles declared empty rewards', () => {
    const f = fixture()
    try {
        f.reset()
        const initial = (f.state().petEggs ?? []).length
        for (const event of Object.values(f.state().ecology.events)) {
            finish(f, event.id)
            const before = f.state(),
                out = claim(f, event.id),
                data = response(out)
            const template = tables.find('world_eep_template', event.template_id)
            if (template.dropID) {
                assert.equal(data.rewards.length, 1)
                const egg = data.rewards[0]
                assert.equal(egg.itemtype, 14)
                assert.equal(egg.itemid, 20004001)
                assert(f.state().petEggs.some((e) => String(e.guid) === egg.guid))
                assertSyncBefore(f.p, out, 'CSProtoPetEggInfoSync', 9192)
                assert.equal(f.state().petEggs.length, (before.petEggs ?? []).length + 1)
            } else assert.deepEqual(data.rewards, [])
            assert.equal(f.state().ecology.progress[event.id].claimed, true)
            assert.equal(f.state().ecology.events[event.id].status, 1)
            const after = f.state()
            assert.deepEqual(response(claim(f, event.id)).rewards, [])
            assert.equal((f.state().petEggs ?? []).length, (after.petEggs ?? []).length)
        }
        assert.equal(f.state().petEggs.length, initial + 1)
    } finally {
        f.close()
    }
})

test('uninitialized, wrong-world and merely entered checkpoints cannot authorize ecology loot', () => {
    const f = fixture()
    try {
        unchanged(f, () => claim(f, 996003), ErrorCode.WorldInvalidEcology)
        f.reset()
        unchanged(f, () => claim(f, 996003), ErrorCode.WorldEcologyCannotReward)
        f.step(996003, 1)
        f.step(996003, 2)
        unchanged(f, () => claim(f, 996003), ErrorCode.WorldEcologyCannotReward)
        f.step(996003, 2)
        f.edit((s) => {
            s.world.map_id = 100
        })
        unchanged(f, () => claim(f, 996003), ErrorCode.WorldInvalidEcology)
    } finally {
        f.close()
    }
})

test('native cleanup preserves a finished unclaimed reward and paid units are removed only on end cleanup', () => {
    const f = fixture()
    try {
        f.reset()
        finish(f, 996003)
        const out = claim(f, 996003)
        assert(out.find((p) => p.id === 9190).data.del_event.length === 0)
        const closed = f.step(996003, 0)
        assert(closed.find((p) => p.id === 9190).data.del_event.includes(996003))
        f.reset()
        assert.equal(f.state().ecology.events[996003].status, 1)
        assert.deepEqual(response(claim(f, 996003)).rewards, [])
        finish(f, 996001)
        f.step(996001, 0)
        assert.deepEqual(response(claim(f, 996001)).rewards, [])
        assert.equal(f.state().ecology.progress[996001].claimed, true)
    } finally {
        f.close()
    }
})

test('completed rewards survive a delayed claim instead of expiring from the original event timestamp', () => {
    const f = fixture()
    try {
        f.reset()
        finish(f, 996003)
        f.setTime(f.now + 1000)
        f.reset()
        assert.equal(response(claim(f, 996003)).rewards.length, 1)
    } finally {
        f.close()
    }
})

test('a missing configured drop group does not mark the event paid or generate substitute items', () => {
    let missing = false
    const source = Object.create(tables)
    source.find = (n, id) => {
        const row = tables.find(n, id)
        return missing && n === 'world_eep_template' && id === 1001 ? { ...row, dropID: '4294967295' } : row
    }
    const f = fixture(':memory:', source)
    try {
        f.reset()
        finish(f, 996003)
        missing = true
        unchanged(f, () => claim(f, 996003), ErrorCode.WorldInvalidEcologyTemplate)
        assert.equal(f.state().ecology.progress[996003].claimed, false)
        missing = false
        assert.equal(response(claim(f, 996003)).rewards.length, 1)
    } finally {
        f.close()
    }
})

test('reward, egg-info or ecology-state codec failure rolls back egg allocation and its claim receipt', () => {
    for (const name of ['CSProtoWorldEcologyGetReward', 'CSProtoPetEggInfoSync', 'CSProtoWorldEcologySync']) {
        const f = fixture()
        try {
            f.reset()
            finish(f, 996003)
            const before = f.state(),
                encode = f.p.encode.bind(f.p),
                type = f.p.byName.get(name).rsp
            f.p.encode = (n, v) => {
                if (n === type) throw Error('ecology reward codec failure')
                return encode(n, v)
            }
            assert.throws(() => claim(f, 996003), /ecology reward codec failure/)
            assert.deepEqual(f.state(), before)
            f.p.encode = encode
            assert.equal(response(claim(f, 996003)).rewards.length, 1)
            assert.deepEqual(response(claim(f, 996003)).rewards, [])
        } finally {
            f.close()
        }
    }
})

test('actual egg instance and once-only receipt persist across SQLite close and reopen', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-ecology-reward-')),
        file = path.join(dir, 'state.sqlite')
    let f, store
    try {
        f = fixture(file)
        f.reset()
        finish(f, 996003)
        const egg = response(claim(f, 996003)).rewards[0],
            id = f.session.id
        f.close()
        f = undefined
        store = new Store(file)
        const saved = store.load(id).state
        assert.equal(saved.ecology.progress[996003].claimed, true)
        assert(saved.petEggs.some((e) => String(e.guid) === egg.guid))
    } finally {
        f?.close()
        store?.close()
        assert.equal(path.dirname(dir), os.tmpdir())
        assert(path.basename(dir).startsWith('lurukaps-ecology-reward-'))
        fs.rmSync(dir, { recursive: true })
    }
})
