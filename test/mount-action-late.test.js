import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mountLifecycleFixture as fixture, mountProtocol as protocol } from './mount-lifecycle-fixture.js'
import { ErrorCode } from '../src/error-codes.js'
const reject = (f, fn, code = ErrorCode.PlayerNotInMountType) => {
    const before = structuredClone(f.state())
    assert.throws(fn, (e) => e.code === code)
    assert.deepEqual(f.state(), before)
}
const ack = (packets) => {
    assert.equal(packets.length, 1)
    assert.equal(packets[0].id, 9120)
    assert.deepEqual(protocol.decode('ProtoNullRsp', packets[0].payload), {})
}
const database = (f) => f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id)
const logCount = (f) =>
    f.store.db.prepare('SELECT count(*) AS n FROM request_log WHERE account_id=?').get(f.session.id).n

test('selected mount and withdrawn or forged fields do not authorize actions from a never-mounted player', () => {
    const f = fixture('mount-late-no-ride')
    try {
        assert.equal(f.state().mountRideId, '500026')
        reject(f, () => f.action())
        f.store.transact(f.session.id, 0, (s) => {
            s.world.pendingMountExit = { guid: '500026', map_id: 101 }
            s.world.lastMountMetadata = { guid: '500026', map_id: 101 }
            s.world.last_mount_action = { action: 2, time: 1800000000 }
        })
        reject(f, () => f.action())
        f.store.transact(
            f.session.id,
            0,
            (s) =>
                (s.world.mountActionLifecycle = {
                    version: 1,
                    phase: 'exited',
                    session: '0'.repeat(64),
                    epoch: 1,
                    map_id: 101,
                    exit_map_id: 101,
                    mount: '500026',
                }),
        )
        reject(f, () => f.action())
    } finally {
        f.store.close()
    }
})
test('logged Dash sequence after a legal ride exit becomes a repeatable no-op without restoring riding or touching player resources', () => {
    const f = fixture('mount-late-logged')
    try {
        f.mount()
        ack(f.action(2))
        f.leave()
        const before = structuredClone(f.state()),
            sql = database(f),
            logs = logCount(f)
        f.time.now += 86400
        for (const action of [2, 2, 1, 3, 2]) ack(f.action(action))
        assert.deepEqual(f.state(), before)
        assert.deepEqual(database(f), sql)
        assert.equal(logCount(f), logs)
        assert.equal(f.state().world.mount, '0')
        assert.equal(f.state().world.status, 0)
    } finally {
        f.store.close()
    }
})
test('unknown and None actions reject even when a valid current-session exit proof exists', () => {
    const f = fixture('mount-late-invalid')
    try {
        f.mount()
        f.leave()
        for (const action of [0, 4, 0xffffffff]) reject(f, () => f.action(action), ErrorCode.InvalidArgument)
        ack(f.action(2))
    } finally {
        f.store.close()
    }
})
test('another connection and a new login cannot reuse the old connection exit proof', () => {
    const f = fixture('mount-late-connections')
    try {
        const other = {}
        f.call('EnterGame', { open_id: 'mount-late-connections' }, other)
        f.mount()
        f.leave()
        reject(f, () => f.call('WorldMapPlayerPlayerAction', { action: 2 }, other))
        ack(f.action())
        f.call('EnterGame', { open_id: 'mount-late-connections' }, {})
        assert.equal(f.state().world.mountActionLifecycle, undefined)
        reject(f, () => f.action())
    } finally {
        f.store.close()
    }
})
test('a new mount epoch uses the current real actor and cannot revive the earlier mount from an old exit receipt', () => {
    const f = fixture('mount-late-new-epoch')
    try {
        f.mount()
        f.leave()
        const first = structuredClone(f.state().world.mountActionLifecycle)
        f.mount('500820')
        assert(f.state().world.mountActionLifecycle.epoch > first.epoch)
        f.time.now++
        ack(f.action(3))
        assert.equal(f.state().world.mount, '500820')
        assert.equal(f.state().world.last_mount_action.action, 3)
        f.leave()
        const before = structuredClone(f.state())
        ack(f.action(2))
        assert.deepEqual(f.state(), before)
        assert.equal(f.state().world.mountActionLifecycle.mount, '500820')
        assert.equal(f.state().mountRideId, '500820')
    } finally {
        f.store.close()
    }
})
test('the actual scene-exit destination accepts the old in-flight report, but another unmounted transfer retires that proof', () => {
    const f = fixture('mount-late-scenes')
    try {
        f.mount()
        f.call('EnterWorldMap', { map_id: 104, point_id: 10401 })
        const before = structuredClone(f.state())
        ack(f.action())
        assert.deepEqual(f.state(), before)
        assert.equal(f.state().world.map_id, 104)
        f.call('EnterWorldMap', { map_id: 100, point_id: 10045 })
        assert.equal(f.state().world.mountActionLifecycle, undefined)
        reject(f, () => f.action())
    } finally {
        f.store.close()
    }
})
test('9120 encoding failure discards the small world fork and preserves shared player pet and combat state', () => {
    const f = fixture('mount-late-codec')
    try {
        f.mount()
        ack(f.action(1))
        const base = f.store.pending.get(f.session.id).state,
            before = structuredClone(f.state()),
            encode = protocol.encode.bind(protocol)
        protocol.encode = (type, value) => {
            if (type === 'cs.ProtoNullRsp') throw Error('mount action codec')
            return encode(type, value)
        }
        try {
            assert.throws(() => f.action(2), /mount action codec/)
        } finally {
            protocol.encode = encode
        }
        assert.equal(f.store.pending.get(f.session.id).state, base)
        assert.deepEqual(f.state(), before)
        ack(f.action(3))
        const next = f.store.pending.get(f.session.id).state
        assert.notEqual(next.world, base.world)
        assert.equal(next.player, base.player)
        assert.equal(next.pets, base.pets)
        assert.equal(next.combat, base.combat)
    } finally {
        f.store.close()
    }
})
test('high-frequency mounted and late reports leave real SQLite rows revisions and request logs unchanged until one deferred flush', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luruka-mount-defer-')),
        file = path.join(dir, 'test.sqlite')
    let f
    try {
        f = fixture('mount-action-sql', file)
        f.mount()
        const before = database(f),
            logs = logCount(f),
            changes = f.store.db.prepare('SELECT total_changes() AS n').get().n
        for (let i = 0; i < 100; i++) {
            f.time.now++
            ack(f.action(2))
        }
        assert.deepEqual(database(f), before)
        assert.equal(logCount(f), logs)
        assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n, changes)
        assert.equal(f.store.pending.get(f.session.id).logs, undefined)
        assert.equal(f.state().world.last_mount_action.time, f.time.now)
        f.store.flushPending()
        assert.equal(database(f).revision, before.revision + 1)
        assert.equal(logCount(f), logs)
        f.leave()
        const exited = database(f),
            last = structuredClone(f.state().world.last_mount_action),
            logsAfterExit = logCount(f)
        for (let i = 0; i < 50; i++) ack(f.action(2))
        assert.deepEqual(database(f), exited)
        assert.deepEqual(f.state().world.last_mount_action, last)
        assert.equal(logCount(f), logsAfterExit)
    } finally {
        f?.store.close()
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
test('SQLite restart retains selection and inventory but never turns persisted exit metadata into a new-session mount authorization', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luruka-mount-late-reopen-')),
        file = path.join(dir, 'test.sqlite')
    let f
    try {
        f = fixture('mount-late-reopen', file)
        f.mount()
        ack(f.action())
        f.leave()
        const pets = structuredClone(f.state().pets)
        f.store.close()
        f = null
        f = fixture('mount-late-reopen', file, true)
        assert.deepEqual(f.state().pets, pets)
        assert.equal(f.state().mountRideId, '500026')
        assert.equal(f.state().world.mountActionLifecycle, undefined)
        reject(f, () => f.action())
    } finally {
        f?.store.close()
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
