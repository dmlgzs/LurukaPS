import test from 'node:test'
import assert from 'node:assert/strict'
import { soulProgressFixture, packedSoul } from './pet-star-soul-progress-fixture.js'
import { createPets } from '../src/pets.js'
import { petStarSoulProgressValue } from '../src/pet-star-soul-progress.js'
import { ErrorCode } from '../src/error-codes.js'

const text = (value) => Buffer.from(String(value)).toString('base64')
test('legacy missing sequence, final kind2 release and a newly trained permanent instance retain two distinct cumulative identities', () => {
    const f = soulProgressFixture('soul-legacy-allocation', 2)
    try {
        const first = f.ids.find((id) => BigInt(id) >> 56n === 2n)
        assert(first)
        f.edit((state) => {
            state.pets = state.pets.filter((p) => p.guid === first)
        })
        f.advance(first, 6, 1)
        f.edit((state) => {
            delete state.nextPetSequence
            delete state.petStarSoulProgress
        })
        f.call('DelPet', { pet_list: [first] })
        assert.equal(f.state().pets.length, 0)
        assert.equal(petStarSoulProgressValue(f.tables, f.state(), [15045, 6, 1, 100]), 1)
        f.call('GMCommand', { command: text('give'), args: [5, 500001, 1].map(text) })
        const second = f.state().pets[0].guid
        assert.notEqual(second, first)
        assert((BigInt(second) & 0xffffffffn) > (BigInt(first) & 0xffffffffn))
        f.advance(second, 6, 1)
        assert.equal(petStarSoulProgressValue(f.tables, f.state(), [15045, 6, 1, 100]), 2)
        f.edit((state) => {
            state.pets[0].is_lock = false
        })
        f.call('DelPet', { pet_list: [second] })
        f.edit((state) => {
            delete state.nextPetSequence
        })
        f.call('GMCommand', { command: text('give'), args: [5, 500001, 1].map(text) })
        const third = f.state().pets[0].guid
        assert(
            ![first, second].includes(third),
            'missing counter cannot reuse either released history on another creation',
        )
        assert.equal(Object.keys(f.state().petStarSoulProgress.entries).length, 2)
    } finally {
        f.store.close()
    }
})

test('historical highwater reserves the kind2 sequence across species and rejects exhaustion or malformed counters before creating', () => {
    const f = soulProgressFixture('soul-allocation-domain')
    try {
        const state = f.state(),
            id = ((2n << 56n) | (500001n << 32n) | 500n).toString()
        state.pets = []
        delete state.nextPetSequence
        state.petStarSoulProgress = {
            version: 1,
            migration: 'current-trained-lower-bound',
            revision: 1,
            entries: {
                [id]: { configId: 500025, level: packedSoul(6, 1) },
            },
        }
        const made = createPets(f.tables, state, 500575, 1)
        assert.equal(Number(BigInt(made[0].guid) & 0xffffffffn), 501)
        assert.equal(made[0].config_id, 500575)
        assert.equal(
            state.petStarSoulProgress.entries[id].configId,
            500025,
            'historical valid evolution is not bound to UID original species',
        )
        for (const value of [0, -1, 1.2, Number.MAX_SAFE_INTEGER + 1]) {
            const bad = structuredClone(state)
            bad.nextPetSequence = value
            const before = structuredClone(bad)
            assert.throws(
                () => createPets(f.tables, bad, 500001, 1),
                (error) => error.code === ErrorCode.GameConfig,
            )
            assert.deepEqual(bad, before)
        }
        const full = structuredClone(state)
        full.pets = []
        delete full.nextPetSequence
        full.petStarSoulProgress.entries = {
            [((2n << 56n) | (500001n << 32n) | 0xffffffffn).toString()]: { configId: 500001, level: packedSoul(6, 1) },
        }
        const before = structuredClone(full)
        assert.throws(
            () => createPets(f.tables, full, 500001, 1),
            (error) => error.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(full, before)
    } finally {
        f.store.close()
    }
})
