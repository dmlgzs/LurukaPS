import test from 'node:test'
import assert from 'node:assert/strict'
import { setup, tables, start } from './hatching-workers-fixture.js'
import { eggSpeciesPools } from '../src/egg-pools.js'
import { hatchAppearanceProfile, applyHatchEffects, validateHatchEffects } from '../src/hatch-effects.js'
import policy from '../configs/hatch-appearance-policy.json' with { type: 'json' }
import { createPets } from '../src/pets.js'
import { hatchRandom } from '../src/hatch-effects.js'
import { ErrorCode } from '../src/error-codes.js'
function withProbability(text, patchPet) {
    return {
        get: tables.get.bind(tables),
        find: (name, id) => {
            const r = tables.find(name, id)
            return name === 'pet_egg' ? { ...r, petProb: text } : name === 'pet' && patchPet ? { ...r, ...patchPet } : r
        },
    }
}
function draw(t, eggId, petId, roll) {
    let first = true
    const p = { config_id: petId }
    const plan = validateHatchEffects(t, { configid: eggId, egg_affix: [] })
    const audit = applyHatchEffects(t, p, plan, (max) => {
        if (first) {
            first = false
            assert.equal(max, 10000)
            return roll
        }
        return 0
    })
    return { p, audit }
}
test('6507 followup verifies all79 real egg templates and every configured species profile with conserved probability mass', () => {
    let count = 0,
        profiles = 0,
        fallback = 0
    for (const egg of tables.get('pet_egg')) {
        count++
        const ids = new Set(eggSpeciesPools(tables, egg.id).groups.flatMap((g) => g.candidates.map((c) => c.id)))
        for (const id of ids) {
            const a = hatchAppearanceProfile(tables, egg.id, id)
            assert.equal(
                a.original_weights.reduce((n, r) => n + r.weight, 0),
                10000,
            )
            assert.equal(
                a.effective_weights.reduce((n, r) => n + r.weight, 0),
                10000,
            )
            assert.deepEqual(
                a.original_weights.map((r) => r.type),
                [0, 1, 2, 3, 4, 5],
            )
            for (const row of a.effective_weights)
                if (row.type !== 0) assert(row.weight <= a.original_weights[row.type].weight)
            if (a.transfers.length) {
                fallback++
                assert.equal(
                    a.effective_weights[0].weight,
                    a.original_weights[0].weight + a.transfers.reduce((n, r) => n + r.weight, 0),
                )
            }
            profiles++
        }
    }
    assert.equal(count, 79)
    assert(profiles > 79)
    assert(fallback > 0)
})
test('6507 followup literal PetSpecialType boundaries use actual9919/31/45/5 and proper combined model/flash fields', () => {
    for (const [roll, type, color] of [
        [0, 0, 0],
        [9918, 0, 0],
        [9919, 1, 1],
        [9949, 1, 1],
        [9950, 2, 0],
        [9994, 2, 0],
        [9995, 3, 1],
        [9999, 3, 1],
    ]) {
        const { p, audit } = draw(tables, 20004001, 500023, roll)
        assert.equal(audit.rolled_special, type)
        assert.equal(audit.routed_special, type)
        assert.equal(p.special, type)
        assert.equal(p.color, color)
        assert.equal(p.colorful, 0)
    }
})
test('6507 followup absent model moves only exact1/3 mass to normal, not renormalization or increasedflash', () => {
    const a = hatchAppearanceProfile(tables, 40003007, 500609)
    assert.deepEqual(
        a.transfers.map((r) => [r.from, r.to, r.weight]),
        [
            [1, 0, 31],
            [3, 0, 5],
        ],
    )
    assert.deepEqual(
        a.effective_weights.map((r) => r.weight),
        [9955, 0, 45, 0, 0, 0],
    )
    for (const roll of [9919, 9995]) {
        const { p, audit } = draw(tables, 40003007, 500609, roll)
        assert.equal(p.special, 0)
        assert.equal(audit.routed_special, 0)
        assert([1, 3].includes(audit.rolled_special))
    }
    assert.equal(draw(tables, 40003007, 500609, 9950).p.special, 2)
})
test('6507 followup enum2/4/5 and zero-weight cases keep real palettes and flash combinations without a fabricated model', () => {
    const t = withProbability('0#9000|2#0|4#500|5#500')
    for (const [roll, type] of [
        [8999, 0],
        [9000, 4],
        [9499, 4],
        [9500, 5],
        [9999, 5],
    ]) {
        const { p } = draw(t, 20004001, 500023, roll)
        assert.equal(p.special, type)
        assert.equal(p.color, 0)
        assert.equal(p.colorful, type ? 1001 : 0)
    }
    assert.equal(draw(withProbability('0#0|2#10000'), 20004001, 500023, 0).p.special, 2)
})
test('6507 followup configurable strict or disabled policy is explicit and malformed table rows never become free fallback', () => {
    try {
        policy.missingAppearance = 'reject'
        assert.throws(
            () => hatchAppearanceProfile(tables, 40003007, 500609),
            (e) => e.code === ErrorCode.FunctionClosed,
        )
        policy.missingAppearance = 'fallback-normal'
        policy.baseMode = 'disabled'
        assert.equal(hatchAppearanceProfile(tables, 20004001, 500023), null)
    } finally {
        policy.baseMode = 'table-special-enum'
        policy.missingAppearance = 'fallback-normal'
    }
    for (const value of ['', '0#9999', '0#10000|0#0', '0#10000|6#0', '0#10001|1#-1'])
        assert.throws(
            () => hatchAppearanceProfile(withProbability(value), 20004001, 500023),
            (e) => e.code === ErrorCode.GameConfig,
        )
    assert.throws(
        () =>
            hatchAppearanceProfile(
                withProbability('0#9919|1#31|2#45|3#5', { petSpecialWeight: '1#-1' }),
                20004001,
                500023,
            ),
        (e) => e.code === ErrorCode.GameConfig,
    )
})
test('6507 followup stores original/effective mass, actualroll and finalappearance in the genuine hatch receipt', () => {
    const f = setup()
    try {
        start(f, 1)
        f.advance(18000)
        const out = f.call('HatOutPetEgg', { build_guid: 18, egg_guid: 1 }),
            id = out.find((p) => p.id === 6507).data.pet_guid,
            a = f.state().hatchReceipts['18:1'].appearance,
            pet = f.state().pets.find((p) => p.guid === id)
        assert.equal(a.egg_id, 40003007)
        assert.equal(a.pet_id, 500609)
        assert.deepEqual(
            a.transfers.map((r) => [r.from, r.to, r.weight]),
            [
                [1, 0, 31],
                [3, 0, 5],
            ],
        )
        assert.equal(a.final_special, pet.special)
        assert.equal(a.color, pet.color)
        assert.equal(a.colorful, pet.colorful)
        const before = f.state().hatchReceipts['18:1']
        f.call('HatOutPetEgg', { build_guid: 18, egg_guid: 1 })
        assert.deepEqual(f.state().hatchReceipts['18:1'], before)
    } finally {
        f.close()
    }
})

test('6507 followup generationversion preserves01 accepted seeds, legacycancel and receipt outcome while new eggs usev2', () => {
    const f = setup()
    try {
        start(f, 1)
        assert.equal(f.state().eggGenerationVersions[1], 2)
        f.call('CancelHatchPetEgg', { build_guid: 18, egg_guid: 1 })
        assert.equal(f.state().eggGenerationVersions[1], 2)
        f.store.transact(f.session.id, 0, (s) => delete s.eggGenerationVersions)
        start(f, 1)
        assert.equal(f.state().eggGenerationVersions[1], 1)
        f.advance(18000)
        const copy = structuredClone(f.state()),
            job = copy.home.productionJobs[18][0]
        const rule = tables.find('pet_egg', copy.petEggs.find((e) => e.guid === 1).configid).petBuilderRuleId
        const [expected] = createPets(tables, copy, job.petId, 1, rule, hatchRandom(copy.eggGenerationSeeds[1]))
        expected.special = 0
        const result = f.call('HatOutPetEgg', { build_guid: 18, egg_guid: 1 }).find((p) => p.id === 6507).data,
            receipt = f.state().hatchReceipts['18:1']
        assert.equal(receipt.generation_version, 1)
        assert.equal(receipt.appearance, undefined)
        assert.deepEqual(
            f.state().pets.find((p) => p.guid === result.pet_guid),
            expected,
        )
        assert.equal(f.state().eggGenerationVersions[1], undefined)
    } finally {
        f.close()
    }
})

test('6507 followup rejects unknown saved generation versions without consuming an egg or changing accepted results', () => {
    const f = setup()
    try {
        start(f, 1)
        f.store.transact(f.session.id, 0, (s) => {
            s.eggGenerationVersions[1] = 99
        })
        f.advance(18000)
        const before = structuredClone(f.state())
        assert.throws(
            () => f.call('HatOutPetEgg', { build_guid: 18, egg_guid: 1 }),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.close()
    }
})
test('6507 followup v1 flash/star combination and unique variant preserve original draw positions', () => {
    const p = { config_id: 500023, color: 0 }
    const plan = validateHatchEffects(tables, { configid: 20004001, egg_affix: [6, 8] }, undefined, {
        baseEnabled: false,
    })
    let draws = 0
    applyHatchEffects(tables, p, plan, (max) => {
        draws++
        return max - 1
    })
    assert.equal(draws, 1)
    assert.deepEqual(p, { config_id: 500023, color: 0, colorful: 1015, special: 5 })
    const v = { config_id: 500023, color: 0 }
    applyHatchEffects(
        tables,
        v,
        validateHatchEffects(tables, { configid: 20004001, egg_affix: [4] }, undefined, { baseEnabled: false }),
        () => {
            throw Error('v1 unique variant must not draw')
        },
    )
    assert.deepEqual(v, { config_id: 500023, color: 1, special: 1 })
})

test('6507 followup a corrupted v2 seed cannot silently migrate to a different legacy stream', () => {
    const f = setup()
    try {
        start(f, 1)
        f.store.transact(f.session.id, 0, (s) => {
            delete s.eggGenerationSeeds[1]
        })
        f.advance(18000)
        const before = structuredClone(f.state())
        assert.throws(
            () => f.call('HatOutPetEgg', { build_guid: 18, egg_guid: 1 }),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.close()
    }
})
