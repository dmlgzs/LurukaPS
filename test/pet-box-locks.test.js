import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { petCosmeticsFixture } from './pet-cosmetics-fixture.js'
import { createPets } from '../src/pets.js'
import { ErrorCode } from '../src/error-codes.js'

test('box locks synchronize before acknowledgement, reject locking all and survive real SQLite reopen', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luruka-pet-box-')),
        file = path.join(dir, 'test.sqlite')
    let f = petCosmeticsFixture('durable-lock', file)
    try {
        assert.deepEqual(f.decode(f.packets, 6517).lock_box_id, [])
        const oldPets = f.state().pets,
            oldGroups = f.state().player.group_mgrs
        const packets = f.call('PetBoxLock', { box_id: 1, lock_operate: 1 })
        assert(packets.findIndex((p) => p.id === 6517) < packets.findIndex((p) => p.id === 6536))
        assert.deepEqual(f.decode(packets, 6517).lock_box_id, [1])
        assert.deepEqual(f.state().pets, oldPets)
        assert.deepEqual(f.state().player.group_mgrs, oldGroups)
        assert.throws(
            () => f.call('PetBoxLock', { box_id: 1, lock_operate: 1 }),
            (e) => e.code === ErrorCode.PetBoxAlreadlyLock,
        )
        for (let i = 2; i < 20; i++) f.call('PetBoxLock', { box_id: i, lock_operate: 1 })
        assert.throws(
            () => f.call('PetBoxLock', { box_id: 20, lock_operate: 1 }),
            (e) => e.code === ErrorCode.PetBoxNotAllowLockAll,
        )
        f.store.close()
        f = petCosmeticsFixture('durable-lock', file)
        assert.deepEqual(
            f.decode(f.packets, 6517).lock_box_id,
            Array.from({ length: 19 }, (_, i) => i + 1),
        )
        for (let i = 1; i < 20; i++) f.call('PetBoxLock', { box_id: i, lock_operate: 0 })
        assert.deepEqual(f.decode(f.login({}), 6517).lock_box_id, [])
    } finally {
        f.store.close()
        assert.equal(path.dirname(dir), os.tmpdir())
        assert(path.basename(dir).startsWith('luruka-pet-box-'))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('automatic acquisition skips locked houses, preserves instances, and rolls back when all unlocked slots are full', () => {
    const f = petCosmeticsFixture('allocation')
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.pets = s.pets.slice(0, 1)
            s.pets[0].box_id = 101
        })
        f.call('PetBoxLock', { box_id: 1, lock_operate: 1 })
        let created
        f.store.transact(f.session.id, 0, (s) => {
            created = createPets(f.tables, s, 500024, 1)
        })
        assert.equal(created[0].box_id, 201)
        const original = f.state().pets.find((p) => p.guid === created[0].guid)
        // Lock protects automatic placement, not explicit manual moves.
        f.call('SetPetBoxInfo', { guid: created[0].guid, box_id: 130 })
        assert.equal(f.state().pets.find((p) => p.guid === original.guid).box_id, 130)
        f.store.transact(f.session.id, 0, (s) => {
            s.lockedPetBoxes = Array.from({ length: 19 }, (_, i) => i + 1)
            for (let slot = 1; slot <= 30; slot++)
                s.pets.push({ ...original, guid: String(800000 + slot), box_id: 2000 + slot })
        })
        const before = f.state()
        assert.throws(
            () => f.store.transact(f.session.id, 0, (s) => createPets(f.tables, s, 500024, 1)),
            (e) => e.code === ErrorCode.BagPetFullForAdd,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})

test('invalid requests/configuration and real sync wire failure do not commit a lock', () => {
    const f = petCosmeticsFixture('rollback')
    try {
        for (const box_id of [0, 21, 0xffffffff])
            assert.throws(
                () => f.call('PetBoxLock', { box_id, lock_operate: 1 }),
                (e) => e.code === ErrorCode.PetBoxNotExist,
            )
        assert.throws(
            () => f.call('PetBoxLock', { box_id: 1, lock_operate: 2 }),
            (e) => e.code === ErrorCode.PetLockOperate,
        )
        const before = f.state(),
            encode = f.protocol.encode.bind(f.protocol)
        f.protocol.encode = (name, value) => {
            if (name === 'cs.SCPetInfoSync') throw Error('pet lock sync encode failed')
            return encode(name, value)
        }
        assert.throws(() => f.call('PetBoxLock', { box_id: 1, lock_operate: 1 }), /encode failed/)
        assert.deepEqual(f.state(), before)
        f.protocol.encode = encode
        f.store.transact(f.session.id, 0, (s) => {
            s.lockedPetBoxes = [99]
        })
        assert.throws(
            () => f.call('PetBoxLock', { box_id: 1, lock_operate: 1 }),
            (e) => e.code === ErrorCode.GameConfig,
        )
    } finally {
        f.store.close()
    }
})
