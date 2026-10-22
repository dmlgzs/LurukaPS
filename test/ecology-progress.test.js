import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fixture, tables } from './ecology-progress-fixture.js'
import { Store } from '../src/store.js'
import { ErrorCode } from '../src/error-codes.js'
import { assertSyncBefore } from './exchange-sync-assertions.js'
function unchanged(f, fn, code) {
    const before = f.state()
    assert.throws(fn, (e) => e.code === code)
    assert.deepEqual(f.state(), before)
}

test('9191 accepts the actual entry/completion terminal repetition for every configured ecology event', () => {
    const f = fixture()
    try {
        const initial = f.reset().find((p) => p.id === 9190).data.event_data
        assert.equal(initial.length, 5)
        const changes = f.store.db.prepare('select total_changes() n').get().n
        for (const event of initial) {
            const template = tables.find('world_eep_template', event.template_id)
            for (let step = 1; step <= template.stepMax; step++) {
                const out = f.step(event.id, step)
                assertSyncBefore(f.p, out, 'CSProtoWorldEcologySync', 9191)
            }
            assert.equal(f.state().ecology.progress[event.id].ready, false)
            f.step(event.id, template.stepMax)
            assert.equal(f.state().ecology.progress[event.id].ready, true)
            assert.equal(f.state().ecology.events[event.id].triggertimes, 1)
            f.step(event.id, 0)
            assert.equal(f.state().ecology.progress[event.id].ready, true)
            assert.equal(f.state().ecology.events[event.id].step, template.stepMax)
            f.step(event.id, template.stepMax + 1) // Native presentation after its reward checkpoint.
            assert.equal(f.state().ecology.events[event.id].step, template.stepMax)
        }
        assert.equal(f.store.db.prepare('select total_changes() n').get().n, changes)
    } finally {
        f.close()
    }
})

test('an event must be initialized, map-bound and linked to its real configured template', () => {
    const f = fixture()
    try {
        unchanged(f, () => f.step(0, 1), ErrorCode.WorldInvalidEcologyConfig)
        unchanged(f, () => f.step(996003, 1), ErrorCode.WorldInvalidEcology)
        f.reset()
        f.edit((s) => {
            s.world.map_id = 100
        })
        unchanged(f, () => f.step(996003, 1), ErrorCode.WorldInvalidEcology)
        f.edit((s) => {
            s.world.map_id = 996
            s.ecology.events[996003].template_id = 1002
        })
        unchanged(f, () => f.step(996003, 1), ErrorCode.WorldInvalidEcology)
    } finally {
        f.close()
    }
})

test('skipping stages or going past the reward checkpoint before completion does not invent progress', () => {
    const f = fixture()
    try {
        f.reset()
        unchanged(f, () => f.step(996003, 2), ErrorCode.WorldInvalidEcology)
        f.step(996003, 1)
        unchanged(f, () => f.step(996003, 3), ErrorCode.WorldInvalidEcology)
        f.step(996003, 0)
        assert.equal(f.state().ecology.events[996003].step, 0)
        assert.equal(f.state().ecology.progress[996003].ready, false)
        f.step(996003, 1)
        assert.equal(f.state().ecology.events[996003].triggertimes, 2)
    } finally {
        f.close()
    }
})

test('timeout starts on an actual attempt, refresh recreates expired attempts and does not permanently lock the event', () => {
    const f = fixture()
    try {
        f.reset()
        f.setTime(f.now + 1000)
        f.step(996003, 1)
        const template = tables.find('world_eep_template', 1001)
        f.setTime(f.now + template.overtime)
        unchanged(f, () => f.step(996003, 2), ErrorCode.WorldInvalidEcology)
        const out = f.reset().filter((p) => p.id === 9190)
        assert(out[0].data.del_event.includes(996003))
        assert(out.at(-1).data.event_data.some((e) => e.id === 996003 && e.step === 0))
        assert.equal(f.state().ecology.progress[996003].started_at, undefined)
        f.step(996003, 1)
        assert.equal(f.state().ecology.events[996003].triggertimes, 2)
        f.step(996003, 2)
        f.step(996003, 2)
        f.setTime(f.now + 1000)
        f.reset()
        assert.equal(f.state().ecology.progress[996003].ready, true)
    } finally {
        f.close()
    }
})

test('step sync or acknowledgement encoding failures cannot leak progress into the borrowed draft', () => {
    for (const name of ['CSProtoWorldEcologyStep', 'CSProtoWorldEcologySync']) {
        const f = fixture()
        try {
            f.reset()
            const before = f.state(),
                encode = f.p.encode.bind(f.p),
                type = f.p.byName.get(name).rsp
            f.p.encode = (n, v) => {
                if (n === type) throw Error('ecology step codec failure')
                return encode(n, v)
            }
            assert.throws(() => f.step(996003, 1), /ecology step codec failure/)
            assert.deepEqual(f.state(), before)
            f.p.encode = encode
            f.step(996003, 1)
            assert.equal(f.state().ecology.events[996003].triggertimes, 1)
        } finally {
            f.close()
        }
    }
})

test('private completion receipts survive refresh and an actual SQLite close/reopen without entering wire payloads', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-ecology-step-')),
        file = path.join(dir, 'state.sqlite')
    let f, store
    try {
        f = fixture(file)
        f.reset()
        f.step(996003, 1)
        f.step(996003, 2)
        f.step(996003, 2)
        const out = f
            .reset()
            .find((p) => p.id === 9190)
            .data.event_data.find((e) => e.id === 996003)
        assert.equal(out.ready, undefined)
        assert.equal(out.terminal_reports, undefined)
        const before = f.state(),
            id = f.session.id
        f.close()
        f = undefined
        store = new Store(file)
        assert.deepEqual(store.load(id).state.ecology.progress, before.ecology.progress)
        assert.equal(store.load(id).state.ecology.events[996003].step, 2)
    } finally {
        f?.close()
        store?.close()
        assert.equal(path.dirname(dir), os.tmpdir())
        assert(path.basename(dir).startsWith('lurukaps-ecology-step-'))
        fs.rmSync(dir, { recursive: true })
    }
})
