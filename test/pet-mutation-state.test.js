import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { ErrorCode } from '../src/error-codes.js'
import {
    readMutationCreditState,
    applyMutationCreditResult,
    findMutationSourceReceipt,
    recordMutationSourceReceipt,
    mutationSourceReceiptKey,
    MutationSourceSkipTag,
    mutationNextGeneration,
} from '../src/pet-mutation-state.js'

const game = new Tables(configuration().tables).get('game')
const tables = {
    get: (name) => {
        assert.equal(name, 'game')
        return game
    },
}
const guid = '18446744073709551610'
function state() {
    return {
        player: { basic_info: { id: 41 } },
        pets: [{ guid, config_id: 500001, lv: 1, gene_infos: [{ pos: 1, gene_id: 532044, gene_lv: 9 }] }],
    }
}
const row = (remainder = 0) => ({ version: 1, remainder, pending: null, lastResolved: null, resolutions: {} })
function managed(s, data = row()) {
    s.petMutation = { version: 1, generationHighWater: '0', pets: { [guid]: data }, claimResults: {} }
    return s
}

test('mutation source reader stays pure, treats old higher gene levels as audit only and missing counter as zero', () => {
    const s = state(),
        before = structuredClone(s)
    const result = readMutationCreditState(tables, s, guid)
    assert.equal(result.status, 'eligible')
    assert.equal(result.credits, 0)
    assert.equal(result.remainder, 0)
    assert.deepEqual(s, before)
    assert.equal(s.petMutation, undefined)
    s.pets[0].mutation_times = 150
    assert.deepEqual(readMutationCreditState(tables, s, guid), {
        status: 'skipped',
        reason: 'cap',
        credits: 150,
        remainder: 0,
    })
})
test('legacy pending is normal skip and typed M1 conditions never repair the bad input', () => {
    const s = state()
    s.pets[0].mutation_info = { pos: 1, gene_id: 532045 }
    assert.deepEqual(readMutationCreditState(tables, s, guid), {
        status: 'skipped',
        reason: 'pending',
        credits: 0,
        remainder: 0,
    })
    s.pets[0].mutation_times = 'bad'
    const before = structuredClone(s)
    assert.equal(readMutationCreditState(tables, s, guid).tag, MutationSourceSkipTag.CounterInvalid)
    assert.deepEqual(s, before)
    s.pets[0].mutation_times = 2
    managed(s, { ...row(), remainder: 'bad' })
    assert.equal(readMutationCreditState(tables, s, guid).tag, MutationSourceSkipTag.LedgerInvalid)
    s.petMutation.pets[guid] = row(17)
    assert.deepEqual(readMutationCreditState(tables, s, guid), {
        status: 'skipped',
        reason: 'pending',
        credits: 2,
        remainder: 17,
    })
})
test('credit application uses small COW branches, preserves borrowed preimages and does not bump pet revision for remainder only', () => {
    const s = managed(state(), row(13)),
        before = structuredClone(s),
        oldPet = s.pets[0],
        oldRoot = s.petMutation,
        oldRow = oldRoot.pets[guid]
    const old = readMutationCreditState(tables, s, guid)
    const applied = applyMutationCreditResult(tables, s, guid, { token: old.token, credits: 0, remainder: 23 })
    assert.equal(applied.petChanged, false)
    assert.equal(s.petRevision, undefined)
    assert.strictEqual(s.pets[0], oldPet)
    assert.equal(oldRow.remainder, 13)
    assert.equal(s.petMutation.pets[guid].remainder, 23)
    assert.deepEqual(oldRoot, before.petMutation)
    const next = readMutationCreditState(tables, s, guid)
    applyMutationCreditResult(tables, s, guid, { token: next.token, credits: 1, remainder: 0 })
    assert.equal(s.pets[0].mutation_times, 1)
    assert.equal(oldPet.mutation_times, undefined)
    assert.equal(s.petRevision, 1)
    assert.throws(
        () => applyMutationCreditResult(tables, s, guid, { token: next.token, credits: 2, remainder: 0 }),
        (e) => e.code === ErrorCode.InvalidLogic,
    )
})
test('source auxiliary receipts remain independent of a quarantined per-pet ledger and cannot be overwritten', () => {
    const s = managed(state(), { ...row(), remainder: 'bad' }),
        bad = s.petMutation.pets[guid]
    const key = mutationSourceReceiptKey(41, '7')
    const receipt = {
        version: 1,
        key,
        primary: { local_claim_id: '7', instance_id: null },
        pets: [{ guid, status: 'quarantined', tag: MutationSourceSkipTag.LedgerInvalid }],
    }
    assert.equal(readMutationCreditState(tables, s, guid).status, 'quarantined')
    assert.equal(recordMutationSourceReceipt(s, key, receipt).created, true)
    assert.strictEqual(s.petMutation.pets[guid], bad)
    assert.equal(recordMutationSourceReceipt(s, key, receipt).created, false)
    const copy = findMutationSourceReceipt(s, key)
    copy.pets[0].status = 'changed'
    assert.equal(findMutationSourceReceipt(s, key).pets[0].status, 'quarantined')
    assert.throws(
        () => recordMutationSourceReceipt(s, key, { ...receipt, pets: [] }),
        (e) => e.code === ErrorCode.GameConfig,
    )
    assert.throws(
        () => recordMutationSourceReceipt(s, key, { ...receipt, primary: { local_claim_id: '8' } }),
        (e) => e.code === ErrorCode.GameConfig,
    )
})
test('unknown/global failures are not turned into M1 skips; generations do not borrow source claim identities', () => {
    const s = state(),
        fault = Error('unexpected accessor failure')
    Object.defineProperty(s.pets[0], 'mutation_times', {
        get() {
            throw fault
        },
    })
    assert.throws(
        () => readMutationCreditState(tables, s, guid),
        (e) => e === fault,
    )
    const global = state()
    global.petMutation = null
    assert.throws(
        () => readMutationCreditState(tables, global, guid),
        (e) => e.code === ErrorCode.GameConfig,
    )
    const clean = state()
    assert.equal(mutationNextGeneration(clean), '1')
    assert.equal(mutationNextGeneration(clean), '2')
    assert.deepEqual(clean.petMutation.claimResults, {})
})
test('a damaged global source receipt is not a per-pet M1 quarantine', () => {
    const s = managed(state()),
        key = mutationSourceReceiptKey(41, '2')
    s.petMutation.claimResults[key] = { version: 1, key, primary: { local_claim_id: '3' }, pets: [] }
    assert.throws(
        () => findMutationSourceReceipt(s, key),
        (e) => e.code === ErrorCode.GameConfig,
    )
    const duplicate = state()
    duplicate.pets.push({ ...duplicate.pets[0] })
    assert.equal(readMutationCreditState(tables, duplicate, guid).tag, MutationSourceSkipTag.QualificationUnverifiable)
})
