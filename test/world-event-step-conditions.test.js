import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mountLifecycleFixture } from './mount-lifecycle-fixture.js'
import { ErrorCode } from '../src/error-codes.js'
import config from '../configs/world-event-runtime.json' with { type: 'json' }

function fixture(name, file = ':memory:', resume = false) {
    const f = mountLifecycleFixture(name, file, resume)
    const call = (name, data = {}) =>
        f
            .call(name, data)
            .map((p) => ({ id: p.id, data: f.game.protocol.decode(f.game.protocol.byId.get(p.id).rsp, p.payload) }))
    if (!resume)
        f.store.transact(f.session.id, 0, (s) => {
            const p = config.events.find((r) => r.id === 101).checks[0].center
            s.world.map_id = 100
            s.world.pos = Object.fromEntries(['x', 'y', 'z'].map((a) => [a, Math.round(p[a] * 100)]))
        })
    const trigger = (id) => call('WorldEventTrigger', { cfg_id: id }).find((p) => p.id === 10717).data.infos[0]
    const step = (id, n) => call('WorldEventStep', { cfg_id: id, step: n })
    return {
        ...f,
        decoded: call,
        trigger,
        step,
        admit104: () => {
            trigger(101)
            step(101, 2)
            trigger(104)
        },
    }
}

test('conditional completion uses real accepted generation after prerequisite changes;10715 precedes10716 and duplicates do not reward', () => {
    const f = fixture('event-step-complete')
    try {
        f.admit104()
        f.step(101, 3)
        const done = f.step(104, 2),
            notification = done.findIndex((p) => p.id === 10715),
            ack = done.findIndex((p) => p.id === 10716)
        assert(notification >= 0 && notification < ack)
        assert.equal(done[notification].data.infos[0].step, 2)
        assert.deepEqual(done[ack].data.rewards, [])
        assert.equal(f.state().worldEvents['100:104'].rewarded, true)
        assert.equal(f.state().worldEvents['100:104'].completed, true)
        const original = f.state().worldEventAdmissions['100:104']
        assert.deepEqual(f.step(104, 2).find((p) => p.id === 10716).data.rewards, [])
        assert.deepEqual(f.state().worldEventAdmissions['100:104'], original)
    } finally {
        f.store.close()
    }
})

test('conditional orphan or stale generation cannot complete and wrong-map requests do not consume the accepted run', () => {
    const f = fixture('event-step-orphan')
    try {
        f.admit104()
        f.store.transact(f.session.id, 0, (s) => {
            delete s.worldEventAdmissions['100:104']
        })
        const before = f.store.load(f.session.id)
        assert.throws(
            () => f.step(104, 2),
            (e) => e.code === ErrorCode.WorldEvCondition,
        )
        assert.deepEqual(f.store.load(f.session.id), before)
        f.trigger(104)
        f.store.transact(f.session.id, 0, (s) => {
            s.world.map_id = 101
        })
        const other = f.store.load(f.session.id)
        assert.throws(() => f.step(104, 2), /current map/)
        assert.deepEqual(f.store.load(f.session.id), other)
        f.store.transact(f.session.id, 0, (s) => {
            s.world.map_id = 100
            s.worldEventAdmissions['100:104'].generation++
        })
        assert.throws(
            () => f.step(104, 2),
            (e) => e.code === ErrorCode.WorldEvCondition,
        )
    } finally {
        f.store.close()
    }
})

test('new epoch synchronizes104 on loaded10715 and SQLite reopen can finish without repeated entry predicate', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luruka-event-step-')),
        file = path.join(dir, 'world.sqlite')
    let f
    try {
        f = fixture('event-step-reopen', file)
        f.admit104()
        f.step(101, 3)
        f.store.close()
        f = fixture('event-step-reopen', file, true)
        const loaded = f.decoded('MultiCampaignPlayerLoaded')
        assert(loaded.some((p) => p.id === 10715 && p.data.infos.some((i) => i.cfg_id === 104 && i.step === 1)))
        assert.deepEqual(f.step(104, 2).find((p) => p.id === 10716).data.rewards, [])
        f.store.close()
        f = fixture('event-step-reopen', file, true)
        assert.equal(f.state().worldEvents['100:104'].completed, true)
        assert.deepEqual(f.step(104, 2).find((p) => p.id === 10716).data.rewards, [])
    } finally {
        f?.store.close()
        assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep + 'luruka-event-step-'))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('real unconditional300 reward rollback retains generation, costs, awards and admission atomically', () => {
    const f = fixture('event-reward-codec')
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.world.map_id = 101
        })
        f.trigger(300)
        const last = f.game.tables.find('world_event', 300).stepCount
        for (let step = 2; step < last; step++) f.step(300, step)
        const before = f.store.load(f.session.id),
            encode = f.game.protocol.encode,
            type = f.game.protocol.byId.get(10715).rsp
        f.game.protocol.encode = function (t, data) {
            if (t === type) throw Error('final event10715 codec failure')
            return encode.call(this, t, data)
        }
        try {
            assert.throws(() => f.step(300, last), /codec failure/)
        } finally {
            f.game.protocol.encode = encode
        }
        assert.deepEqual(f.store.load(f.session.id), before)
        assert(f.step(300, last).find((p) => p.id === 10716).data.rewards.length > 0)
        assert.deepEqual(f.step(300, last).find((p) => p.id === 10716).data.rewards, [])
    } finally {
        f.store.close()
    }
})

test('legacy unconditional active event keeps its previous completion path and obtains a receipt only through actual10715', () => {
    const f = fixture('event-zero-legacy')
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.world.map_id = 101
        })
        f.trigger(300)
        f.store.transact(f.session.id, 0, (s) => {
            delete s.worldEventAdmissions
            delete s.world.eventRuntime
        })
        const next = f.step(300, 2)
        assert(next.some((p) => p.id === 10715 && p.data.infos[0].step === 2))
        assert.equal(f.state().worldEventAdmissions['101:300'].generation, f.state().worldEvents['101:300'].generation)
    } finally {
        f.store.close()
    }
})

test('unknown event configuration returns the official world-event configuration code', () => {
    const f = fixture('event-missing-config')
    try {
        assert.throws(
            () => f.trigger(0),
            (error) => error.code === ErrorCode.InvalidArgument,
        )
        assert.throws(
            () => f.step(0, 2),
            (error) => error.code === ErrorCode.InvalidArgument,
        )
        assert.throws(
            () => f.trigger(0xffffffff),
            (error) => error.code === ErrorCode.WorldEventConfNotFound,
        )
        assert.throws(
            () => f.step(0xffffffff, 2),
            (error) => error.code === ErrorCode.WorldEventConfNotFound,
        )
    } finally {
        f.store.close()
    }
})

test('zero-overtime104 can finish after the source101 deadline without rechecking its old entry predicate', () => {
    const f = fixture('event-zero-deadline-complete')
    try {
        f.admit104()
        f.time.now += 21601
        assert.deepEqual(f.step(104, 2).find((p) => p.id === 10716).data.rewards, [])
        assert.equal(f.state().worldEvents['100:104'].completed, true)
    } finally {
        f.store.close()
    }
})

test('configured overtime-result final variant retains the original atomic reward settlement', () => {
    const f = fixture('event-overtime-final-variant'),
        find = f.game.tables.find
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.world.map_id = 101
        })
        // Explicit configuration variant, not a claim that current CBT3 rows use this result.
        f.game.tables.find = function (name, id) {
            const row = find.call(this, name, id)
            return name === 'world_event' && id === 300 ? { ...row, overtimeResult: row.stepCount } : row
        }
        f.trigger(300)
        const row = f.game.tables.find('world_event', 300),
            event = f.state().worldEvents['101:300']
        f.time.now = event.begin_time + row.overtime
        const request = { cfg_id: 300, step: row.stepCount, reset_start: true }
        assert(f.decoded('WorldEventStep', request).find((p) => p.id === 10716).data.rewards.length > 0)
        assert.equal(f.state().worldEvents['101:300'].completed, true)
        assert.deepEqual(f.decoded('WorldEventStep', request).find((p) => p.id === 10716).data.rewards, [])
    } finally {
        f.game.tables.find = find
        f.store.close()
    }
})
