import test from 'node:test'
import assert from 'node:assert/strict'
import { rescueFixture } from './actor-rescue-fixture.js'

test('11220 stops rescue audio for the sender and map peers, without zeroing earned rescue progress or HP', () => {
    const f = rescueFixture('rescue-cancel')
    try {
        const [from, to] = f.heroes
        f.overHurt(to)
        f.rescue(from, to, 250)
        const saved = structuredClone(f.saved(to)),
            writes = f.sql()
        const packets = f.call('RescueCancel')
        assert.deepEqual(
            packets.map((p) => p.id),
            [11226, 11226],
        )
        assert.deepEqual(f.protocol.decode('CSUint32', packets[0].payload), { u32: f.session.id })
        assert.equal(packets[0].audience, undefined)
        assert.deepEqual(packets[1].audience, { kind: 'map', map: 100, sender: f.session.id })
        assert.deepEqual(f.saved(to), saved)
        assert.deepEqual(f.state().combat.rescueSources, {})
        assert.equal(f.sql(), writes)
        f.call('RescueCancel')
        f.rescue(from, to, 250)
        assert.equal(f.saved(to).rescue_val, 500)
    } finally {
        f.store.close()
    }
})

test('cancel before any progress, after completion and after a scene change is safe and never creates combat', () => {
    const f = rescueFixture('rescue-cancel-empty')
    try {
        f.store.transact(f.session.id, 0, (s) => {
            delete s.combat
        })
        const before = structuredClone(f.state()),
            writes = f.sql()
        assert.equal(f.call('RescueCancel').length, 2)
        assert.deepEqual(f.state(), before)
        assert.equal(f.sql(), writes)
        const id = f.heroes[0]
        f.overHurt(id, 9999)
        f.rescue(id, id, 1)
        const hp = f.saved(id).hp
        f.call('RescueCancel')
        assert.equal(f.saved(id).hp, hp)
        f.store.transact(f.session.id, 0, (s) => {
            s.combat.rescueSources = { stale: 'target' }
            s.world.map_id = 101
        })
        const combat = structuredClone(f.state().combat)
        const packets = f.call('RescueCancel')
        assert.equal(packets[1].audience.map, 101)
        assert.deepEqual(f.state().combat, combat)
    } finally {
        f.store.close()
    }
})

test('cancel notification encoding failures preserve source links, target progress, and the borrowed base draft', () => {
    const f = rescueFixture('rescue-cancel-codec'),
        encode = f.protocol.encode
    try {
        const [from, to] = f.heroes
        f.overHurt(to)
        f.rescue(from, to, 250)
        const shared = f.state(),
            before = structuredClone(shared),
            writes = f.sql()
        let count = 0
        f.protocol.encode = function (name, ...args) {
            if ((name === 'CSUint32' || name === 'cs.CSUint32') && ++count === 2)
                throw Error('cancel peer codec failed')
            return encode.call(this, name, ...args)
        }
        assert.throws(() => f.call('RescueCancel'), /cancel peer codec failed/)
        assert.deepEqual(shared, before)
        assert.deepEqual(f.state(), before)
        assert.equal(f.sql(), writes)
        f.protocol.encode = encode
        f.call('RescueCancel')
        assert.deepEqual(f.state().combat.rescueSources, {})
        assert.equal(f.saved(to).rescue_val, 250)
    } finally {
        f.protocol.encode = encode
        f.store.close()
    }
})
