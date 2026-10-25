import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { achievementFixture } from './achievement-fixture.js'
import { initialPetSatiety } from '../src/pet-initial-satiety.js'
import { petData, repairPetProfiles } from '../src/pets.js'
import { ErrorCode } from '../src/error-codes.js'

const text = (value) => Buffer.from(String(value)).toString('base64')
const command = (name, args = []) => ({ command: text(name), args: args.map(text) })
const wirePets = (f, packets) =>
    packets
        .filter((packet) => packet.id === 6517)
        .flatMap((packet) => f.protocol.decode('SCPetInfoSync', packet.payload).pet_infos.pets)

function changedTables(base, transform, homeTransform) {
    const derived = Object.create(base)
    derived.get = (name) => (name === 'game' ? transform(structuredClone(base.get('game'))) : base.get(name))
    derived.find = (name, id) =>
        name === 'pet_home_talent' && homeTransform ? homeTransform(base.find(name, id)) : base.find(name, id)
    return derived
}

test('new account permanent pets use current beginning60 and direct uint32 wire serialization, without copying debug10000', () => {
    const f = achievementFixture('pet-initial-domain')
    try {
        assert(f.state().pets.length > 0)
        assert(f.state().pets.every((pet) => pet.satiety_val === 60))
        const pets = wirePets(f, f.entryPackets)
        assert(pets.length > 0)
        assert(pets.every((pet) => pet.satiety_val === 60))
        assert.equal(initialPetSatiety(f.tables, 500001), 60)
        assert.equal(petData(f.tables, 500001, '999', 101, undefined, () => 0).satiety_val, 60)
        assert.equal(petData(f.tables, 500001, '999', 0, undefined, () => 0, { temporary: true }).satiety_val, 10000)
    } finally {
        f.store.close()
    }
})

test('real GM ordinary and customized reward producers append configured satiety and roll back failed pet sync', () => {
    const f = achievementFixture('pet-initial-gm')
    try {
        const beforeIds = new Set(f.state().pets.map((pet) => pet.guid))
        const packets = f.call('GMCommands', {
            cmds: [command('give', [5, 500001, 1]), command('give', [30, 500072, 1])],
        })
        const added = f.state().pets.filter((pet) => !beforeIds.has(pet.guid))
        assert.equal(added.length, 2)
        assert(added.every((pet) => pet.satiety_val === 60))
        assert(added.some((pet) => pet.customized_id === 500072))
        const synced = wirePets(f, packets)
        assert(added.every((pet) => synced.some((wire) => wire.guid === pet.guid && wire.satiety_val === 60)))
        const before = structuredClone(f.state()),
            encode = f.protocol.encode
        f.protocol.encode = function (name, ...args) {
            if (name.replace(/^cs\./, '') === 'SCPetInfoSync') throw Error('pet satiety sync codec')
            return encode.call(this, name, ...args)
        }
        try {
            assert.throws(() => f.call('GMCommand', command('give', [5, 500001, 1])), /pet satiety sync codec/)
            assert.deepEqual(f.state(), before)
        } finally {
            f.protocol.encode = encode
        }
    } finally {
        f.store.close()
    }
})

test('missing and corrupt initialization config fail with GameConfig and roll back earlier real GM batch effects', () => {
    const f = achievementFixture('pet-initial-errors')
    try {
        const base = f.tables
        const mutations = [
            (rows) => rows.filter((row) => row.title !== 'PET_SATIETY_BEGINNING_VALUE'),
            (rows) => rows.map((row) => (row.title === 'PET_SATIETY_BEGINNING_VALUE' ? { ...row, value: '-1' } : row)),
            (rows) => rows.map((row) => (row.title === 'PET_SATIETY_BEGINNING_VALUE' ? { ...row, value: '1.5' } : row)),
            (rows) =>
                rows.map((row) =>
                    row.title === 'PET_SATIETY_BEGINNING_VALUE' ? { ...row, value: '4294967296' } : row,
                ),
            (rows) => rows.map((row) => (row.title === 'PET_SATIETY_MAX_VALUE' ? { ...row, value: '59' } : row)),
            (rows) => [...rows, rows.find((row) => row.title === 'PET_SATIETY_BEGINNING_VALUE')],
        ]
        for (const mutation of mutations) {
            const bad = changedTables(base, mutation)
            const before = structuredClone(f.state())
            f.game.tables = bad
            assert.throws(
                () => f.call('GMCommands', { cmds: [command('gold', [10]), command('give', [5, 500001, 1])] }),
                (error) => error.code === ErrorCode.GameConfig,
            )
            assert.deepEqual(f.state(), before)
            assert.equal(initialPetSatiety(bad, 500001, { temporary: true }), 10000)
        }
        f.game.tables = base
        const badHome = changedTables(
            base,
            (rows) => rows,
            (row) => ({ ...row, satietyScore: 0 }),
        )
        assert.throws(
            () => initialPetSatiety(badHome, 500001),
            (error) => error.code === ErrorCode.GameConfig,
        )
        const beforeHomeFailure = structuredClone(f.state())
        f.game.tables = badHome
        assert.throws(
            () => f.call('GMCommands', { cmds: [command('gold', [10]), command('give', [5, 500001, 1])] }),
            (error) => error.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), beforeHomeFailure)
        f.game.tables = base
        const noHome = changedTables(
            base,
            (rows) => rows,
            () => undefined,
        )
        assert.equal(initialPetSatiety(noHome, 500078), 60, 'pets without a home labor profile remain creatable')
    } finally {
        f.game.tables = f.tables
        f.store.close()
    }
})

test('SQLite reopen and login preserve existing low, absent, and legacy10000 satiety while new pets initialize independently', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-initial-satiety-')),
        file = path.join(dir, 'state.sqlite')
    let f = achievementFixture('pet-initial-persist', file)
    try {
        const ids = f
            .state()
            .pets.slice(0, 3)
            .map((pet) => pet.guid)
        f.store.transact(f.session.id, 0, (state) => {
            state.pets[0].satiety_val = 7
            delete state.pets[1].satiety_val
            state.pets[2].satiety_val = 10000
            repairPetProfiles(f.tables, state)
        })
        f.store.close()
        f = achievementFixture('pet-initial-persist', file)
        assert.equal(f.state().pets.find((pet) => pet.guid === ids[0]).satiety_val, 7)
        assert.equal(
            Object.hasOwn(
                f.state().pets.find((pet) => pet.guid === ids[1]),
                'satiety_val',
            ),
            false,
        )
        assert.equal(f.state().pets.find((pet) => pet.guid === ids[2]).satiety_val, 10000)
        const wire = wirePets(f, f.entryPackets)
        assert.equal(wire.find((pet) => pet.guid === ids[0]).satiety_val, 7)
        assert.equal(
            wire.find((pet) => pet.guid === ids[1]).satiety_val ?? 0,
            0,
            'optional uint32 omission remains the protocol zero default',
        )
        assert.equal(wire.find((pet) => pet.guid === ids[2]).satiety_val, 10000)
        const beforeIds = new Set(f.state().pets.map((pet) => pet.guid))
        f.call('GMCommand', command('give', [5, 500001, 1]))
        assert.equal(f.state().pets.find((pet) => !beforeIds.has(pet.guid)).satiety_val, 60)
        assert.equal(f.state().pets.find((pet) => pet.guid === ids[0]).satiety_val, 7)
    } finally {
        f.store.close()
        const target = path.resolve(dir)
        assert.equal(path.dirname(target), path.resolve(os.tmpdir()))
        assert(path.basename(target).startsWith('pet-initial-satiety-'))
        fs.rmSync(target, { recursive: true, force: true })
    }
})
