import test from 'node:test'
import assert from 'node:assert/strict'
import { mutationSourceParameters, planMutationEarning, mutationSourceClaimKey } from '../src/pet-mutation-source.js'
import { ErrorCode } from '../src/error-codes.js'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'

const parameters = { step: 40, numerator: 2000, denominator: 10000, cap: 100 }
const input = (overrides = {}) => ({ credits: 0, remainder: 0, pending: false, paid: 0, ...overrides })
function rolls(values) {
    let index = 0
    const rng = (maximum) => {
        assert.equal(maximum, 10000)
        assert(index < values.length, 'Unexpected additional natural-source roll')
        return values[index++]
    }
    return { rng, count: () => index }
}

test('each40 units uses the exact2000 boundary while retaining partial fees and counting full per-pet shares independently', () => {
    const partial = planMutationEarning(input({ paid: 20 }), parameters, () => {
        throw Error('No whole step')
    })
    assert.deepEqual(partial.after, { credits: 0, remainder: 20 })
    assert.equal(partial.trials, 0)
    const first = rolls([1999]),
        second = rolls([2000])
    const a = planMutationEarning(input({ paid: 20, remainder: partial.after.remainder }), parameters, first.rng)
    const b = planMutationEarning(input({ paid: 40 }), parameters, second.rng)
    assert.deepEqual(a.after, { credits: 1, remainder: 0 })
    assert.deepEqual(b.after, { credits: 0, remainder: 0 })
    assert.equal(a.trials, 1)
    assert.equal(b.trials, 1)
    assert.equal(first.count(), 1)
    assert.equal(second.count(), 1)
})

test('start-cap, legacy-above-cap, pending and zero-fee paths preserve old remainders without drawing or inventing backlog', () => {
    for (const source of [
        input({ credits: 100, remainder: 39, paid: 120 }),
        input({ credits: 456, remainder: 21, paid: 200 }),
        input({ credits: 6, remainder: 20, paid: 80, pending: true }),
        input({ credits: 6, remainder: 20, paid: 0 }),
    ]) {
        const result = planMutationEarning(source, parameters, () => {
            throw Error('Skipped source must not draw')
        })
        assert.deepEqual(result.after, { credits: source.credits, remainder: source.remainder })
        assert.equal(result.changed, false)
        assert.equal(result.petChanged, false)
        assert.equal(result.discarded, source.paid)
        assert.equal(result.trials, 0)
    }
})

test('mid-claim cap stops after its successful step and discards every unprocessed unit without a deferred reward', () => {
    const random = rolls([2000, 0, 1999])
    const result = planMutationEarning(input({ credits: 98, remainder: 39, paid: 121 }), parameters, random.rng)
    assert.deepEqual(result.after, { credits: 100, remainder: 0 })
    assert.equal(result.status, 'cap-reached')
    assert.equal(result.trials, 3)
    assert.equal(result.successes, 2)
    assert.equal(result.discarded, 40)
    assert.equal(random.count(), 3)
    assert.equal(39 + 121, result.trials * 40 + result.after.remainder + result.discarded)
})

test('a no-success funded source still returns its complete replayable mathematical result without phantom credits', () => {
    const source = input({ credits: 7, remainder: 39, paid: 120 }),
        before = structuredClone(source)
    const result = planMutationEarning(source, parameters, rolls([9999, 9999, 9999]).rng)
    assert.equal(result.status, 'no-success')
    assert.deepEqual(result.after, { credits: 7, remainder: 39 })
    assert.equal(result.trials, 3)
    assert.equal(result.successes, 0)
    assert.equal(result.petChanged, false)
    assert.deepEqual(source, before)
    assert.doesNotThrow(() => JSON.stringify(result))
})

test('malformed credit fields, random values and overflow fail by named configuration errors rather than normalizing history', () => {
    const invalid = [
        input({ credits: -1, paid: 40 }),
        input({ credits: 1.5, paid: 40 }),
        input({ remainder: 40, paid: 40 }),
        input({ remainder: -1, paid: 40 }),
        input({ pending: 1, paid: 40 }),
        input({ paid: -1 }),
        input({ paid: Number.MAX_SAFE_INTEGER, remainder: 39 }),
    ]
    for (const row of invalid)
        assert.throws(
            () =>
                planMutationEarning(row, parameters, () => {
                    throw Error('Must validate first')
                }),
            (e) => e.code === ErrorCode.GameConfig,
        )
    for (const roll of [-1, 10000, 0.5, NaN])
        assert.throws(
            () => planMutationEarning(input({ paid: 40 }), parameters, () => roll),
            (e) => e.code === ErrorCode.GameConfig,
        )
})

test('source parameters read the real current cap and algorithm fingerprints exclude approval timestamps or prose', () => {
    const tables = new Tables(configuration().tables)
    const policy = {
        version: 3,
        userApproved: true,
        officiallyVerified: false,
        recordedAt: 'first',
        source: {
            staminaPerTrial: 40,
            successNumerator: 2000,
            successDenominator: 10000,
        },
    }
    const a = mutationSourceParameters(tables, policy)
    assert.equal(a.cap, Number(tables.get('game').find((r) => r.title === 'KIBO_DNA_MUTATION_TIMES_LIMIT').value))
    assert.equal(a.cap, 100)
    assert.deepEqual([a.step, a.numerator, a.denominator], [40, 2000, 10000])
    assert.equal(
        a.fingerprint,
        mutationSourceParameters(tables, { ...policy, recordedAt: 'later', approval: { text: 'different metadata' } })
            .fingerprint,
    )
    assert.notEqual(
        a.fingerprint,
        mutationSourceParameters(tables, { ...policy, source: { ...policy.source, successNumerator: 1000 } })
            .fingerprint,
    )
})

test('paid-claim keys use account and committed source-local identity without request sequence, wall clock or snapshot aliases', () => {
    const key = mutationSourceClaimKey(1, '1')
    assert.match(key, /^[0-9a-f]{64}$/)
    assert.equal(key, mutationSourceClaimKey(1, '1'))
    assert.notEqual(key, mutationSourceClaimKey(2, '1'))
    assert.notEqual(key, mutationSourceClaimKey(1, '2'))
    for (const id of ['0', '01', '-1', '4294967296', 1])
        assert.throws(
            () => mutationSourceClaimKey(1, id),
            (e) => e.code === ErrorCode.GameConfig,
        )
})
