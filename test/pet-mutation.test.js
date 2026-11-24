import test from 'node:test'
import assert from 'node:assert/strict'
import { ErrorCode } from '../src/error-codes.js'
import { mutationFixture, mutationTestGuid, mutationTemporaryDatabase } from './pet-mutation-fixture.js'

test('real6539 appends one gene, debits one controlled old credit, raises gene_state only on append and replays exact request once', () => {
    const f = mutationFixture('mutation-append', { genes: 2 })
    try {
        const old = f.target()
        f.setRolls([0, 0])
        const out = f.generate(),
            frame = f.lastFrame,
            after = f.state(),
            pet = f.target()
        assert.equal(pet.gene_infos.length, 3)
        assert.equal(pet.mutation_times, old.mutation_times - 1)
        assert.equal(pet.gene_state, 2)
        assert.equal(pet.gene_infos[2].gene_lv, 1)
        assert.equal(pet.mutation_info.pos, 0)
        assert.equal(after.petMutation.pets[mutationTestGuid].pending, null)
        assert.equal(out.find((p) => p.id === 6539).payload.length, 0)
        assert(out.findIndex((p) => p.id === 6517) < out.findIndex((p) => p.id === 6539))
        const wire = f.protocol
            .decode('SCPetInfoSync', out.find((p) => p.id === 6517).payload)
            .pet_infos.pets.find((p) => p.guid === mutationTestGuid)
        assert.equal(wire.gene_state, 2)
        assert.equal(wire.gene_infos.length, 3)
        assert.equal(JSON.stringify(wire).includes('baseHash'), false)
        const drawCount = f.draws.length
        assert.deepEqual(f.replay(frame), f.lastEncoded)
        assert.deepEqual(f.state(), after)
        assert.equal(f.draws.length, drawCount)
        f.generate()
        assert.equal(f.target().gene_infos.length, 4)
        assert.equal(f.target().mutation_times, old.mutation_times - 2)
    } finally {
        f.close()
    }
})
test('real full6539 stores all effect/innate proposal before6544 and keep does not refund or change original genome', () => {
    const f = mutationFixture('mutation-proposal', { genes: 8 })
    try {
        const old = structuredClone(f.target())
        f.setRolls([0])
        f.generate()
        const pending = f.state().petMutation.pets[mutationTestGuid].pending
        assert.equal(pending.pos, 1)
        assert.equal(pending.candidate.gene_id, f.tables.find('pet_dna', old.gene_infos[0].gene_id).evoDnaId)
        assert.deepEqual(f.target().gene_infos, old.gene_infos)
        assert.equal(f.target().gene_state, old.gene_state)
        assert.equal(f.target().mutation_times, old.mutation_times - 1)
        const before = f.state()
        assert.throws(
            () => f.generate(),
            (e) => e.code === ErrorCode.InvalidLogic,
        )
        assert.deepEqual(f.state(), before)
        f.choose(false)
        assert.deepEqual(f.target().gene_infos, old.gene_infos)
        assert.equal(f.target().mutation_times, old.mutation_times - 1)
        assert.equal(f.target().mutation_info.pos, 0)
        assert.equal(f.state().petMutation.pets[mutationTestGuid].resolutions[pending.generation].kind, 'retained')
    } finally {
        f.close()
    }
})
test('real6544 accepts the durable fixed candidate without a second draw or debit and preserves unrelated current appearance', () => {
    const f = mutationFixture('mutation-accept', { genes: 8 })
    try {
        f.setRolls([0])
        f.generate()
        const pending = structuredClone(f.state().petMutation.pets[mutationTestGuid].pending),
            draws = f.draws.length
        f.edit((s) => {
            s.pets.find((p) => p.guid === mutationTestGuid).color = 2
        })
        f.choose(true)
        assert.deepEqual(f.target().gene_infos[0], pending.candidate)
        assert.equal(f.target().mutation_times, pending.counterAfter)
        assert.equal(f.target().color, 2)
        assert.equal(f.draws.length, draws)
        const after = f.state()
        assert.throws(
            () => f.choose(true),
            (e) => e.code === ErrorCode.PetCanNotMutation,
        )
        assert.deepEqual(f.state(), after)
        const record = after.petMutation.pets[mutationTestGuid].resolutions[pending.generation]
        assert.equal(record.kind, 'accepted')
        assert.equal(record.projection.status, 'unverified-client-transition-release-gate')
    } finally {
        f.close()
    }
})
test('pending proposal persists through actual SQLite close/reopen and confirms its original candidate', () => {
    const db = mutationTemporaryDatabase()
    let f
    try {
        f = mutationFixture('mutation-reopen', { genes: 8, file: db.file })
        f.setRolls([0])
        f.generate()
        const candidate = structuredClone(f.state().petMutation.pets[mutationTestGuid].pending.candidate)
        f.close()
        f = mutationFixture('mutation-reopen', { initialize: false, file: db.file })
        f.choose(true)
        assert.deepEqual(f.target().gene_infos[candidate.pos - 1], candidate)
        assert.equal(f.draws.length, 0)
    } finally {
        if (f) f.close()
        db.cleanup()
    }
})
