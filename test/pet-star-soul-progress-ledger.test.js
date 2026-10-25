import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { soulProgressFixture, packedSoul } from './pet-star-soul-progress-fixture.js'
import { achievementFixture } from './achievement-fixture.js'
import {
    initializePetStarSoulProgress,
    petStarSoulProgressValue,
    recordPetStarSoulProgress,
} from '../src/pet-star-soul-progress.js'
import { ErrorCode } from '../src/error-codes.js'

const goal = [15045, 1, 2, 100]
test('lower-bound migration preserves only current legal trained identities and never manufactures released history from receipts', () => {
    const f = soulProgressFixture('pet-soul-migration')
    try {
        const pet = structuredClone(f.target(f.ids[0])),
            state = {
                pets: [pet],
                achievements: {
                    entries: {
                        4020035: { value: 100, finishTime: 1, claimed: true },
                    },
                },
            }
        pet.soul_link_level = packedSoul(2, 1)
        assert.equal(petStarSoulProgressValue(f.tables, state, goal), 1)
        assert.deepEqual(Object.keys(state.petStarSoulProgress.entries), [BigInt(pet.guid).toString()])
        state.pets = []
        assert.equal(petStarSoulProgressValue(f.tables, state, goal), 1)
        assert.equal(state.achievements.entries[4020035].claimed, true)
        assert.equal(petStarSoulProgressValue(f.tables, { pets: [] }, goal), 0)
        for (const namespace of [9n, 31n]) {
            const transient = { ...pet, guid: ((namespace << 56n) | 1n).toString(), type: 1 }
            assert.equal(petStarSoulProgressValue(f.tables, { pets: [transient] }, goal), 0)
        }
        assert.equal(petStarSoulProgressValue(f.tables, { pets: [pet], kiboDuelTrialProfiles: { 1: pet } }, goal), 0)
        for (const bad of [
            { '01': { configId: pet.config_id, level: pet.soul_link_level } },
            { 1: { configId: pet.config_id, level: packedSoul(2, 0) } },
            { 1: { configId: pet.config_id, level: '18446744073709551616' } },
            { 1: { configId: pet.config_id, level: packedSoul(1, 1) } },
        ])
            assert.throws(
                () =>
                    petStarSoulProgressValue(
                        f.tables,
                        {
                            pets: [],
                            petStarSoulProgress: {
                                version: 1,
                                migration: 'current-trained-lower-bound',
                                revision: 0,
                                entries: bad,
                            },
                        },
                        goal,
                    ),
                (error) => error.code === ErrorCode.GameConfig,
            )
    } finally {
        f.store.close()
    }
})

test('same permanent UID keeps one highest legal fact across actual configured cross-template evolution routes', () => {
    const f = soulProgressFixture('pet-soul-evolution')
    try {
        const pet = { ...structuredClone(f.target(f.ids[0])), config_id: 500025, soul_link_level: packedSoul(6, 1) },
            state = { pets: [pet] }
        assert.equal(f.tables.find('pet', 500025).starsoulId, 1000)
        assert.equal(f.tables.find('pet', 500231).starsoulId, 1100)
        initializePetStarSoulProgress(f.tables, state)
        pet.config_id = 500231
        pet.soul_link_level = packedSoul(2, 1)
        recordPetStarSoulProgress(f.tables, state, pet)
        assert.equal(petStarSoulProgressValue(f.tables, state, [15045, 6, 1, 1]), 1)
        assert.equal(Object.keys(state.petStarSoulProgress.entries).length, 1)
        assert.equal(state.petStarSoulProgress.entries[pet.guid].configId, 500025)
        pet.soul_link_level = packedSoul(6, 1)
        recordPetStarSoulProgress(f.tables, state, pet)
        assert.equal(Object.keys(state.petStarSoulProgress.entries).length, 1)
        const short = f.tables.get('pet').find((row) => row.starsoulId === 3000)
        pet.config_id = short.id
        assert.throws(
            () => recordPetStarSoulProgress(f.tables, state, pet),
            (error) => error.code === ErrorCode.GameConfig,
        )
    } finally {
        f.store.close()
    }
})

test('release migrates a legacy trained instance before removing it and rollback preserves pet, refunds and attainment facts', () => {
    const f = soulProgressFixture('pet-soul-release-migrate')
    try {
        const id = f.ids[0]
        f.advance(id, 2, 1)
        // Simulate an old persisted trained instance without the new ledger.
        f.edit((state) => {
            delete state.petStarSoulProgress
        })
        const before = structuredClone(f.state()),
            encode = f.protocol.encode
        f.protocol.encode = function (name, ...args) {
            if (name.replace(/^cs\./, '') === 'Rewards') throw Error('soul release codec')
            return encode.call(this, name, ...args)
        }
        assert.throws(() => f.call('DelPet', { pet_list: [id] }), /soul release codec/)
        assert.deepEqual(f.state(), before)
        f.protocol.encode = encode
        f.call('DelPet', { pet_list: [id] })
        assert.equal(f.target(id), undefined)
        assert.equal(petStarSoulProgressValue(f.tables, f.state(), goal), 1)
        const after = structuredClone(f.state())
        assert.throws(() => f.call('DelPet', { pet_list: [id] }))
        assert.deepEqual(f.state(), after)
    } finally {
        f.store.close()
    }
})

test('partial cumulative counts survive release between cohorts, SQLite reopen and account separation', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-soul-ledger-'))
    let f
    try {
        const file = path.join(dir, 'state.sqlite')
        f = soulProgressFixture('pet-soul-persist', 3, file)
        for (const id of f.ids.slice(0, 2)) {
            f.advance(id, 1, 2)
            f.call('DelPet', { pet_list: [id] })
        }
        assert.equal(petStarSoulProgressValue(f.tables, f.state(), goal), 2)
        const id = f.ids[2]
        f.advance(id, 1, 2)
        assert.equal(petStarSoulProgressValue(f.tables, f.state(), goal), 3)
        f.call('DelPet', { pet_list: [id] })
        f.store.close()
        f = achievementFixture('pet-soul-persist', file)
        assert.equal(petStarSoulProgressValue(f.tables, f.state(), goal), 3)
        const other = achievementFixture('pet-soul-different', file)
        try {
            assert.equal(petStarSoulProgressValue(other.tables, other.state(), goal), 0)
        } finally {
            other.store.close()
        }
    } finally {
        f?.store.close()
        const resolved = path.resolve(dir)
        assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()))
        assert(path.basename(resolved).startsWith('pet-soul-ledger-'))
        fs.rmSync(resolved, { recursive: true, force: true })
    }
})
