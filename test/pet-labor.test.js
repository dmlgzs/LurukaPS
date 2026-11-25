import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { initialPetLaborFromPolicy, fixedPetLabor, petLaborDefinitions } from '../src/pet-labor.js'
import { ErrorCode } from '../src/error-codes.js'
import policy from '../configs/pet-labor-policy.json' with { type: 'json' }
import { createPets, petData, repairPetProfiles, customizedPetRewardDefinition } from '../src/pets.js'
import { planPetEvolution } from '../src/pet-evolution.js'
import { registerPetEvolution } from '../src/handlers/pet-evolution.js'
import { Protocol } from '../src/protocol.js'

const tables = new Tables(configuration().tables)
const rng = (min, max) => (max === undefined ? 0 : min)

test('all current home profiles initialize within their configured score ranges without legacy training tables', () => {
    const reads = []
    const source = {
        get(name) {
            reads.push(name)
            assert.notEqual(name, 'home_labor_train')
            return tables.get(name)
        },
        find(name, id) {
            reads.push(name)
            assert.notEqual(name, 'home_labor_train')
            return tables.find(name, id)
        },
    }
    for (const row of tables.get('pet_home_talent')) {
        const labor = initialPetLaborFromPolicy(source, row.id, policy)
        assert.equal(labor.length, row.laborType.split('|').length)
        assert.deepEqual(
            labor.map((entry) => entry.labor_id),
            row.laborType.split('|').map(Number),
        )
        labor.forEach((entry, index) => {
            const [minimum] = row.laborScoreLimit.split('|')[index].split('#').map(Number)
            assert.equal(entry.labor_grade, minimum)
            assert.equal(entry.upper_labor_grade, minimum)
            assert.equal(entry.labor_exp, 0)
            assert(tables.find('home_labor_efficiency', entry.labor_grade))
        })
    }
    assert(reads.includes('home_labor_efficiency'))
    assert.deepEqual(initialPetLaborFromPolicy(source, 500001, policy), [
        { labor_id: 3, labor_grade: 20, upper_labor_grade: 20, labor_exp: 0 },
    ])
})

test('labor initialization requires an explicit local policy and does not default to a full ceiling', () => {
    for (const altered of [undefined, { ...policy, upperGrade: undefined }, { ...policy, officiallyVerified: true }])
        assert.throws(
            () => initialPetLaborFromPolicy(tables, 500001, altered),
            (error) => error.code === ErrorCode.GameConfig,
        )
})

function alteredHome(update, missingScore) {
    return {
        get(name) {
            const rows = tables.get(name)
            return name === 'home_labor_efficiency' ? rows.filter((row) => row.id !== missingScore) : rows
        },
        find(name, id) {
            return name === 'pet_home_talent' ? { ...tables.find(name, id), ...update } : tables.find(name, id)
        },
    }
}

test('malformed or missing type, score ranges and efficiency rows fail instead of dropping labor', () => {
    for (const update of [
        { laborType: undefined },
        { laborType: '3|3', laborScoreLimit: '20#35|20#35' },
        { laborType: '99999' },
        { laborType: '3|4' },
        { laborScoreLimit: '' },
        { laborScoreLimit: undefined },
        { laborScoreLimit: '0#35' },
        { laborScoreLimit: '35#20' },
        { laborScoreLimit: '20#35#40' },
        { laborScoreLimit: '#35' },
        { laborScoreLimit: '20#4294967295' },
    ])
        assert.throws(
            () => petLaborDefinitions(alteredHome(update), 500001),
            (error) => error.code === ErrorCode.GameConfig,
        )
    assert.throws(
        () => petLaborDefinitions(alteredHome({}, 25), 500001),
        (error) => error.code === ErrorCode.GameConfig,
    )
})

test('explicit customized scores use the current efficiency domain and keep their own score ceiling', () => {
    assert.deepEqual(fixedPetLabor(tables, 500001, '40', policy), [
        { labor_id: 3, labor_grade: 40, upper_labor_grade: 40, labor_exp: 0 },
    ])
    for (const score of [undefined, '', '0', '101', '20|30', '20.5'])
        assert.throws(
            () => fixedPetLabor(tables, 500001, score, policy),
            (error) => error.code === ErrorCode.GameConfig,
        )
})

test('a pet with no home labor definition has no fabricated work type', () => {
    const source = {
        find(name, id) {
            return name === 'pet_home_talent' ? undefined : tables.find(name, id)
        },
    }
    assert.deepEqual(initialPetLaborFromPolicy(source, 500001, policy), [])
})

test('Xunlang petData and createPets share the approved local labor initialization', () => {
    const source = {
        get(name) {
            assert.notEqual(name, 'home_labor_train')
            return tables.get(name)
        },
        find(name, id) {
            assert.notEqual(name, 'home_labor_train')
            return tables.find(name, id)
        },
    }
    const direct = petData(source, 500001, '1', 101, 1001, rng)
    const state = { pets: [], petBoxes: [], petCatalogVersion: 2 }
    const [created] = createPets(source, state, 500001, 1, 1001, rng)
    assert.deepEqual(created.labor_infos, direct.labor_infos)
    assert.deepEqual(created.labor_infos, [{ labor_id: 3, labor_grade: 20, upper_labor_grade: 20, labor_exp: 0 }])
    assert.equal(state.pets[0], created)
    assert(state.recordPets.includes(500001))
})

test('repair initializes a missing labor profile and preserves legal saved scores, ceilings and experience', () => {
    const missing = petData(tables, 500001, '1', 101, 1001, rng)
    const preserved = petData(tables, 500001, '2', 102, 1001, rng)
    delete missing.labor_infos
    preserved.labor_infos = [{ labor_id: 3, labor_grade: 77, upper_labor_grade: 90, labor_exp: 12 }]
    const before = structuredClone(preserved.labor_infos)
    const state = { pets: [missing, preserved] }
    assert.equal(repairPetProfiles(tables, state), true)
    assert.deepEqual(missing.labor_infos, [{ labor_id: 3, labor_grade: 20, upper_labor_grade: 20, labor_exp: 0 }])
    assert.deepEqual(preserved.labor_infos, before)
    assert.equal(repairPetProfiles(tables, state), false)
})

test('all current actual evolution routes keep shared saved labor and initialize newly configured types', () => {
    let count = 0
    for (const row of tables.get('pet_rank').filter((row) => row.nextPetId > 0)) {
        const pet = petData(tables, row.petId, '1', 101, 1001, rng)
        pet.lv = Math.max(1, row.levelNeed)
        pet.labor_infos.forEach((entry) => {
            entry.labor_grade = 77
            entry.upper_labor_grade = 90
            entry.labor_exp = 12
        })
        const before = structuredClone(pet)
        const plan = planPetEvolution(tables, { pets: [pet] }, pet, rng)
        const previous = new Map(pet.labor_infos.map((entry) => [entry.labor_id, entry]))
        const definitions = petLaborDefinitions(tables, row.nextPetId)
        assert.deepEqual(
            plan.update.labor_infos.map((entry) => entry.labor_id),
            definitions.map((entry) => entry.laborId),
        )
        plan.update.labor_infos.forEach((entry, index) => {
            const old = previous.get(entry.labor_id)
            assert.deepEqual(
                entry,
                old ?? {
                    labor_id: definitions[index].laborId,
                    labor_grade: definitions[index].minimum,
                    upper_labor_grade: definitions[index].minimum,
                    labor_exp: 0,
                },
            )
            assert.notEqual(entry, old)
        })
        assert.deepEqual(pet, before)
        count++
    }
    assert(count > 0)
})

test('all explicit customized labor definitions use current score rows', () => {
    let count = 0
    for (const row of tables.get('pet_customized').filter((row) => row.laborScoreType === 1)) {
        const labor = fixedPetLabor(tables, row.petId, row.laborScore, policy)
        assert.deepEqual(
            labor.map((entry) => entry.labor_grade),
            row.laborScore.split('|').map(Number),
        )
        count++
    }
    assert(count > 0)
    const definition = customizedPetRewardDefinition(tables, 100001)
    assert.deepEqual(
        definition.labor,
        fixedPetLabor(tables, definition.config.petId, definition.config.laborScore, policy),
    )
})

test('actual evolution handler preserves shared labor, archives removed labor and syncs four fields on the current wire', () => {
    let evolve
    registerPetEvolution((name, handler) => {
        if (name === 'RankUpPet') evolve = handler
    })
    const protocol = new Protocol(configuration().base)
    const sync = protocol.byName.get('CSProtoPetInfoSync')
    for (const id of [500079, 500045]) {
        const row = tables.get('pet_rank').find((entry) => entry.petId === id)
        const pet = petData(tables, id, '1', 101, 1001, rng)
        pet.lv = row.levelNeed
        pet.labor_infos.forEach((entry) => {
            entry.labor_grade = 77
            entry.upper_labor_grade = 90
            entry.labor_exp = 12
        })
        const before = structuredClone(pet)
        const packets = []
        const state = {
            pets: [pet],
            petCatalogVersion: 2,
            mountSaddles: [],
            player: { basic_info: { gold: 0 }, sbag_infos: { items: [{ itemid: 499002, itemnum: 1 }] } },
        }
        const context = {
            tables,
            state,
            now: 100,
            randomInt: rng,
            pushBefore(name, data) {
                packets.push({ name, data })
            },
        }
        pet.work_build = 42
        assert.throws(
            () => evolve(context, { u64: pet.guid }),
            (error) => error.code === ErrorCode.PetInWork,
        )
        pet.work_build = 0
        const expected = planPetEvolution(tables, state, pet, rng).update.labor_infos
        evolve(context, { u64: pet.guid })
        assert.equal(state.pets[0], pet)
        assert.equal(pet.guid, before.guid)
        assert.equal(pet.config_id, row.nextPetId)
        assert.deepEqual(pet.labor_infos, expected)
        assert.deepEqual(state.petEvolutionProfiles[pet.guid][id].labor_infos, before.labor_infos)
        assert.deepEqual(pet.comprehension, before.comprehension)
        assert.deepEqual(pet.gene_infos, before.gene_infos)
        assert.equal(state.petEvolutionHistory[pet.guid][0].to, row.nextPetId)
        assert.equal(packets[0].name, 'CSProtoRideMountInfo')
        const decoded = protocol.decode(sync.rsp, protocol.encode(sync.rsp, { pet_infos: { pets: [pet] } }))
        assert.deepEqual(decoded.pet_infos.pets[0].labor_infos, pet.labor_infos)
    }
})
