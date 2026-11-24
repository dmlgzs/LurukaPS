import test from 'node:test'
import assert from 'node:assert/strict'
import { captureMutationClaimPets, createMutationSourceRuntime } from '../src/pet-mutation-source.js'
import { MutationSourceSkipTag, findMutationSourceReceipt } from '../src/pet-mutation-state.js'
import { spendCurrency } from '../src/inventory.js'
import { ErrorCode } from '../src/error-codes.js'

const H1 = '72057598332895233',
    H2 = '72057602627862529'
const P1 = '146262759123501057',
    P2 = '146262759123501058'
const tables = {
    get: (name) => {
        assert.equal(name, 'game', 'Source must not interpret DNA/effect tables as earning eligibility')
        return [{ title: 'KIBO_DNA_MUTATION_TIMES_LIMIT', value: '100' }]
    },
}
function state() {
    return {
        world: { map_id: 3590 },
        player: {
            basic_info: { id: 1 },
            heros_info: {
                heros: [
                    { guid: H1, pet_id: P1 },
                    { guid: H2, pet_id: P2 },
                ],
                battle_infos: [{ hero_id: H1, hp: 0 }],
            },
            attr_infos: { attrs: [{ attr_id: 3, attr_val: '1000' }] },
            group_mgrs: [
                {
                    type: 1,
                    cur_group: 1,
                    groups: [
                        {
                            id: 1,
                            heros: [
                                { hero_id: H1, pet_id: P1 },
                                { hero_id: H2, pet_id: P2 },
                            ],
                        },
                    ],
                },
            ],
        },
        pets: [
            {
                guid: P1,
                config_id: 500001,
                hero_id: H1,
                type: 1,
                lv: 7,
                gene_infos: [{ pos: 1, gene_id: 532044, gene_lv: 9 }],
                mutation_times: 0,
            },
            {
                guid: P2,
                config_id: 500001,
                hero_id: H2,
                type: 1,
                lv: 8,
                gene_infos: [{ pos: 1, gene_id: 532050, gene_lv: 1 }],
                mutation_times: 0,
            },
        ],
        entrust: {
            run: {
                kind: 'entrust',
                entrust_id: 1,
                dungeon_id: 3590,
                map_id: 3590,
                battle_complete: true,
                chest_claimed: false,
            },
        },
    }
}
function context(s = state()) {
    let next = 0,
        draws = 0
    return {
        id: 1,
        state: s,
        now: 1800000000,
        tables,
        randomInt: (max) => {
            assert.equal(max, 10000)
            draws++
            return 0
        },
        allocateMutationSourceClaim: () => String(++next),
        identities: () => next,
        draws: () => draws,
    }
}
const descriptor = (c, paid = 40) => ({
    kind: 'entrust',
    run: c.state.entrust.run,
    box_id: 10,
    times: 1,
    costs: [{ itemtype: 10, itemid: 3, itemnum: paid }],
})
function paid(runtime, c, handle, d) {
    for (const [i, cost] of d.costs.entries()) {
        if (!cost.itemnum) continue
        spendCurrency(c.state, cost.itemid, cost.itemnum)
        runtime.paid(c, handle, i, cost)
    }
    c.state.entrust.run.chest_claimed = true
    c.state.entrust.run.claim_times = d.times
    return runtime.complete(c, handle)
}

test('source capture is pure, includes fainted permanent bindings and deduplicates a repeated role without reading gene level or HP eligibility', () => {
    const s = state(),
        before = structuredClone(s)
    s.player.group_mgrs[0].groups[0].heros.push({ hero_id: H1, pet_id: P1 })
    const withDuplicate = structuredClone(s)
    const snapshot = captureMutationClaimPets(s, 1800000000)
    assert.deepEqual(
        snapshot.beneficiaries.map((r) => [r.pet_guid, r.status]),
        [
            [P1, 'eligible'],
            [P2, 'eligible'],
        ],
    )
    assert.equal(snapshot.beneficiaries[0].audit.gene_infos.value[0].gene_lv, 9)
    assert.deepEqual(s, withDuplicate)
    assert.deepEqual(before.pets, s.pets)
})

test('effective instance overrides exclude temporary same-GUID copies without banning a temporary role that genuinely binds a permanent pet', () => {
    const s = state(),
        tempHero = '360287974484606977'
    s.cultTrial = {
        map_id: 3590,
        heroes: [{ guid: tempHero, pet_id: P2 }],
        pets: [{ guid: P1, trial: true, hero_id: H1 }],
    }
    s.player.group_mgrs.push({
        type: 8,
        cur_group: 1,
        groups: [
            {
                id: 1,
                heros: [
                    { hero_id: H1, pet_id: P1 },
                    { hero_id: tempHero, pet_id: P2 },
                ],
            },
        ],
    })
    s.pets[1].hero_id = tempHero
    const snapshot = captureMutationClaimPets(s, 1800000000)
    assert.deepEqual(
        snapshot.beneficiaries.map((r) => [r.pet_guid, r.status]),
        [[P2, 'eligible']],
    )
    assert.equal(snapshot.excluded[0].reason, 'current-temporary-instance-no-owned-remap')
    assert.equal(snapshot.excluded[0].pet_guid, P1)
})

test('one valid owner plus a second contradictory current role cannot turn an ambiguous pet into an eligible beneficiary', () => {
    const s = state()
    s.player.heros_info.heros[1].pet_id = P1
    s.player.group_mgrs[0].groups[0].heros[1].pet_id = P1
    const before = structuredClone(s),
        snapshot = captureMutationClaimPets(s, 1800000000)
    assert.equal(snapshot.beneficiaries.length, 1)
    assert.equal(snapshot.beneficiaries[0].status, 'quarantined')
    assert.equal(snapshot.beneficiaries[0].tag, MutationSourceSkipTag.QualificationUnverifiable)
    assert.deepEqual(s, before)
})

test('module paid callbacks earn full per-pet shares from a source-local claim even when the old entry has no instance ID', () => {
    const c = context(),
        runtime = createMutationSourceRuntime(),
        d = descriptor(c)
    const handle = runtime.prepare(c, d)
    assert.equal(c.identities(), 1)
    assert.equal(c.draws(), 0)
    const receipt = paid(runtime, c, handle, d)
    assert.equal(receipt.primary.instance_id, null)
    assert.equal(receipt.primary.local_claim_id, '1')
    assert.deepEqual(
        c.state.pets.map((p) => p.mutation_times),
        [1, 1],
    )
    assert.equal(c.draws(), 2)
    assert.equal(c.state.player.attr_infos.attrs[0].attr_val, '960')
    assert.deepEqual(runtime.complete(c, handle), receipt)
    assert.equal(c.draws(), 2)
    assert.deepEqual(findMutationSourceReceipt(c.state, handle.key), receipt)
    assert.deepEqual(c.mutationSourcePetSync.guids, [P1, P2])
})

test('a claimed flag without successful actual component callbacks cannot authorize source credits', () => {
    const c = context(),
        runtime = createMutationSourceRuntime(),
        d = descriptor(c)
    const handle = runtime.prepare(c, d)
    c.state.entrust.run.chest_claimed = true
    c.state.entrust.run.claim_times = 1
    assert.throws(
        () => runtime.complete(c, handle),
        (e) => e.code === ErrorCode.InvalidLogic,
    )
    assert.equal(c.draws(), 0)
    assert.deepEqual(
        c.state.pets.map((p) => p.mutation_times),
        [0, 0],
    )
    assert.equal(c.state.petMutation, undefined)
})

test('classified per-pet bad counter and qualification fields are preserved and recorded without blocking other valid recipients', () => {
    const c = context(),
        runtime = createMutationSourceRuntime()
    c.state.pets[0].mutation_times = 'bad-old-counter'
    const raw = structuredClone(c.state.pets[0])
    const d = descriptor(c),
        receipt = paid(runtime, c, runtime.prepare(c, d), d)
    assert.deepEqual(c.state.pets[0], raw)
    assert.equal(c.state.pets[1].mutation_times, 1)
    assert.equal(receipt.pets[0].tag, MutationSourceSkipTag.CounterInvalid)
    assert.equal(receipt.pets[0].no_backfill, true)
    assert.equal(receipt.pets[1].applied.credits, 1)
    assert.deepEqual(c.mutationSourcePetSync.guids, [P2])
    assert(c.state.petMutation.claimResults[receipt.key])
})

test('before-fee raw gene and level snapshots are audit only and never overwrite current canonical genes during earning', () => {
    const c = context(),
        runtime = createMutationSourceRuntime(),
        d = descriptor(c)
    const handle = runtime.prepare(c, d)
    c.state.pets[0].lv = 15
    c.state.pets[0].gene_infos = [{ pos: 1, gene_id: 532045, gene_lv: 12 }]
    const receipt = paid(runtime, c, handle, d)
    assert.equal(receipt.primary.qualification_snapshot.beneficiaries[0].audit.lv.value, 7)
    assert.equal(receipt.primary.qualification_snapshot.beneficiaries[0].audit.gene_infos.value[0].gene_lv, 9)
    assert.deepEqual(c.state.pets[0].gene_infos, [{ pos: 1, gene_id: 532045, gene_lv: 12 }])
    assert.equal(c.state.pets[0].lv, 15)
    assert.equal(c.state.pets[0].mutation_times, 1)
})

test('zero actual fee avoids allocation and source inspection, and a fresh actual claim cannot reuse its earlier committed identity', () => {
    const runtime = createMutationSourceRuntime()
    const empty = {
        state: {},
        allocateMutationSourceClaim: () => {
            throw Error('No identity for free claim')
        },
    }
    assert.equal(runtime.prepare(empty, { costs: [{ itemtype: 10, itemid: 3, itemnum: 0 }] }), null)
    const c = context(),
        d = descriptor(c)
    const first = runtime.prepare(c, d)
    paid(runtime, c, first, d)
    c.state.entrust.run.chest_claimed = false
    const second = runtime.prepare(c, d)
    assert.notEqual(second.key, first.key)
    assert.equal(second.local_claim_id, '2')
    paid(runtime, c, second, d)
    assert.equal(Object.keys(c.state.petMutation.claimResults).length, 2)
    assert.deepEqual(
        c.state.pets.map((p) => p.mutation_times),
        [2, 2],
    )
})

test('unknown shared state or unexpected callback failures are not converted into optional-source skips', () => {
    const c = context(),
        fault = Object.assign(Error('controlled unknown ABI failure'), { code: 'SQLITE_TEST_FAULT' })
    const runtime = createMutationSourceRuntime({
        readMutationCreditState: () => {
            throw fault
        },
    })
    const d = descriptor(c),
        handle = runtime.prepare(c, d)
    assert.throws(
        () => paid(runtime, c, handle, d),
        (e) => e === fault,
    )
    assert.equal(c.state.petMutation, undefined)
    const corrupt = context()
    corrupt.state.petMutation = { version: 1, generationHighWater: '0', pets: {}, claimResults: null }
    assert.throws(
        () => createMutationSourceRuntime().prepare(corrupt, descriptor(corrupt)),
        (e) => e.code === ErrorCode.GameConfig,
    )
})
