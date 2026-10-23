import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
    mountLifecycleFixture as fixture,
    mountProtocol as protocol,
    mountTables as tables,
} from './mount-lifecycle-fixture.js'
import { ErrorCode } from '../src/error-codes.js'
import { petData } from '../src/pets.js'
import { clearSceneMount } from '../src/mounts.js'
const reject = (f, fn, code) => {
    const before = structuredClone(f.state())
    assert.throws(fn, (e) => e.code === code)
    assert.deepEqual(f.state(), before)
}

test('9117 validates a real owned legacy mount and binds only a session SHA fingerprint, preserving ordinary and glider species', () => {
    const f = fixture()
    try {
        assert.equal(f.state().world.mountActionLifecycle, undefined)
        f.mount()
        let p = f.state().world.mountActionLifecycle
        assert.equal(p.phase, 'riding')
        assert.equal(p.mount, '500026')
        assert.equal(p.map_id, 101)
        assert.equal(p.epoch, 1)
        assert.match(p.session, /^[a-f0-9]{64}$/)
        assert.notEqual(p.session, f.session.token)
        assert(!JSON.stringify(p).includes(f.session.token))
        f.leave()
        f.mount('500820')
        p = f.state().world.mountActionLifecycle
        assert.equal(p.phase, 'riding')
        assert.equal(p.mount, '500820')
        assert.equal(p.epoch, 2)
        assert.deepEqual(protocol.decode('ProtoNullRsp', f.leave().find((p) => p.id === 9117).payload), {})
    } finally {
        f.store.close()
    }
})
test('unknown owned instance, nonmount configuration and a table-forbidden scene cannot manufacture a ride proof', () => {
    const f = fixture()
    try {
        const before = structuredClone(f.state())
        assert.throws(() => f.mount('999999'))
        assert.deepEqual(f.state(), before)
        const nonmount = tables.get('pet').find((p) => !tables.find('mount', p.id))
        f.store.transact(f.session.id, 0, (s) => s.pets.push(petData(tables, nonmount.id, '999998', 1)))
        reject(f, () => f.mount('999998'), ErrorCode.PetIsNotMount)
        f.call('EnterWorldMap', { map_id: 104, point_id: 10401 })
        reject(f, () => f.mount(), ErrorCode.SceneCantMount)
        assert.equal(f.state().world.mountActionLifecycle, undefined)
    } finally {
        f.store.close()
    }
})
test('real dismount closes the same ride epoch; duplicate status/cleanup does not renew it or restore mounted state', () => {
    const f = fixture()
    try {
        f.mount()
        const original = structuredClone(f.state().world.mountActionLifecycle),
            pets = structuredClone(f.state().pets)
        f.leave()
        const closed = structuredClone(f.state().world.mountActionLifecycle)
        assert.equal(closed.phase, 'exited')
        assert.equal(closed.epoch, original.epoch)
        assert.equal(closed.exit_map_id, 101)
        assert.equal(Object.hasOwn(closed, 'expires_at'), false)
        f.time.now += 86400
        f.leave()
        f.store.transact(f.session.id, 0, (s) => clearSceneMount(s))
        assert.deepEqual(f.state().world.mountActionLifecycle, closed)
        assert.equal(f.state().world.mount, '0')
        assert.equal(f.state().world.status, 0)
        assert.deepEqual(f.state().pets, pets)
    } finally {
        f.store.close()
    }
})
test('real scene transfer closes the mount in its destination and a later unrelated transfer retires that exit proof', () => {
    const f = fixture()
    try {
        f.mount()
        f.call('EnterWorldMap', { map_id: 104, point_id: 10401 })
        const p = f.state().world.mountActionLifecycle
        assert.equal(p.phase, 'exited')
        assert.equal(p.map_id, 101)
        assert.equal(p.exit_map_id, 104)
        assert.equal(f.state().world.mount, '0')
        assert.equal(f.state().world.status, 0)
        f.call('EnterWorldMap', { map_id: 100, point_id: 10045 })
        assert.equal(f.state().world.mountActionLifecycle, undefined)
    } finally {
        f.store.close()
    }
})
test('a new login clears any prior-session proof and never promotes withdrawn compatibility fields', () => {
    const f = fixture()
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.world.pendingMountExit = { guid: '500026', map_id: 101 }
            s.world.lastMountMetadata = { guid: '500026', map_id: 101 }
        })
        assert.equal(f.state().world.mountActionLifecycle, undefined)
        f.mount()
        f.leave()
        assert(f.state().world.mountActionLifecycle)
        f.call('EnterGame', { open_id: 'mount-lifecycle' }, {})
        assert.equal(f.state().world.mountActionLifecycle, undefined)
        assert.equal(f.state().world.pendingMountExit, undefined)
        assert.equal(f.state().world.lastMountMetadata, undefined)
    } finally {
        f.store.close()
    }
})
test('9117 response encoding failures roll back ride entry and exit proofs along with visible mount state', () => {
    const f = fixture()
    try {
        const encode = protocol.encode.bind(protocol)
        const fail = (fn) => {
            const before = structuredClone(f.state())
            protocol.encode = (type, value) => {
                if (type === 'cs.ProtoNullRsp') throw Error('mount status codec')
                return encode(type, value)
            }
            try {
                assert.throws(fn, /mount status codec/)
            } finally {
                protocol.encode = encode
            }
            assert.deepEqual(f.state(), before)
        }
        fail(() => f.mount())
        f.mount()
        fail(() => f.leave())
        assert.equal(f.state().world.status, 1)
        assert.equal(f.state().world.mountActionLifecycle.phase, 'riding')
    } finally {
        f.store.close()
    }
})
test('temporary SQLite reopen retains real selection and inventory but clears the previous connection lifecycle', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luruka-mount-producer-')),
        file = path.join(dir, 'test.sqlite')
    let f
    try {
        f = fixture('mount-producer-sql', file)
        f.mount()
        f.leave()
        const pets = structuredClone(f.state().pets)
        f.store.close()
        f = null
        f = fixture('mount-producer-sql', file, true)
        assert.equal(f.state().world.mountActionLifecycle, undefined)
        assert.equal(f.state().mountRideId, '500026')
        assert.deepEqual(f.state().pets, pets)
    } finally {
        f?.store.close()
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('real dismount map status clears the client mount before its9117 ACK; ride entry ordering is unchanged', () => {
    const f = fixture('mount-status-wire-order')
    try {
        const entry = f.mount()
        const entryAck = entry.findIndex((packet) => packet.id === 9117)
        const entryMaps = entry.flatMap((packet, index) =>
            packet.id === 9103 ? [{ index, data: protocol.decode('WorldMapNotify', packet.payload) }] : [],
        )
        assert(entryMaps.length > 0)
        assert(
            entryMaps.every((packet) => packet.index > entryAck),
            'this fix does not reorder the unexamined ride-entry callback contract',
        )
        const exit = f.leave(),
            ack = exit.findIndex((packet) => packet.id === 9117)
        const status = exit.flatMap((packet, index) =>
            packet.id === 9103 ? [{ index, data: protocol.decode('WorldMapNotify', packet.payload) }] : [],
        )
        assert(status.some((packet) => packet.data.cmd === 17))
        assert(status.some((packet) => packet.data.cmd === 25))
        assert(
            status.every((packet) => packet.index < ack),
            'clear m_MountId before ACK callback unblocks input',
        )
        for (const packet of status) {
            const player = packet.data.map_info.players[0]
            assert.equal(player.mount, '0')
            assert.equal(player.status, 0)
            assert.equal(player.move.length, 0)
            assert.equal(player.group, undefined)
        }
    } finally {
        f.store.close()
    }
})
