import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables, seedPlayer } from '../src/player.js'
import { petData, petGrade, repairPetProfiles } from '../src/pets.js'
import { initialPetComprehension } from '../src/pet-comprehension.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { petModelEligibility } from '../src/pet-model-eligibility.js'

const tables = new Tables(configuration().tables)
// This fixture tracks the current seed policy; the tests below cover profile
// generation/repair rather than the former hardcoded number of pet rows.
const seedPetCount = tables
    .get('pet')
    .filter(
        (row) =>
            row.petStage > 0 &&
            row.IsCatch === 1 &&
            tables.find('template_value', row.id) &&
            petModelEligibility(tables, row.id).eligible,
    ).length

test('builder aptitude weights respect its configured total and level-to-value ranges', () => {
    const lowest = initialPetComprehension(tables, 1001, () => 0),
        highest = initialPetComprehension(tables, 1001, (max) => max - 1)
    for (const rows of [lowest, highest]) {
        assert.equal(
            rows.reduce((sum, c) => sum + c.level, 0),
            25,
        )
        assert(
            rows.every(
                (c) =>
                    c.init_level === c.level &&
                    tables
                        .get('pet_talent_upgrade')
                        .some(
                            (row) =>
                                row.attrId === c.attr_id &&
                                row.level === c.level &&
                                c.value >= row.InterA &&
                                c.value <= row.InterB,
                        ),
            ),
        )
    }
    assert.notDeepEqual(lowest, highest)
    const premium = initialPetComprehension(tables, 2004, (max) => max - 1)
    assert.equal(
        premium.reduce((sum, c) => sum + c.level, 0),
        42,
    )
    assert(premium.every((c) => c.level >= 6))
})

test('CBT3 seed and capture pets have table-backed grades and valid gene skills', () => {
    const state = seedPlayer(tables, 1, 'pet-profile')
    assert.equal(state.pets.length, seedPetCount)
    assert(state.pets.every((p) => p.grade > 0 && p.grade <= 99999))
    assert(state.pets.every((p) => p.color === 0))
    const target = state.pets.find((p) => p.config_id === 500297)
    assert.equal(
        target.comprehension.reduce((sum, c) => sum + c.level, 0),
        25,
    )
    assert(
        target.comprehension.every(
            (c) =>
                c.init_level === c.level &&
                tables
                    .get('pet_talent_upgrade')
                    .some(
                        (row) =>
                            row.attrId === c.attr_id &&
                            row.level === c.level &&
                            c.value >= row.InterA &&
                            c.value <= row.InterB,
                    ),
        ),
    )
    assert(new Set(state.pets.flatMap((p) => p.comprehension.map((c) => c.value))).size > 6)
    assert.equal(target.grade, petGrade(tables, target))
    assert.equal(target.gene_infos.length, 8)
    assert.equal(target.gene_state, 4)
    assert.deepEqual(target.labor_infos, [{ labor_id: 5, labor_grade: 20, upper_labor_grade: 100, labor_exp: 0 }])
    const timber = state.pets.find((p) => p.config_id === 500001)
    assert(timber.labor_infos.some((x) => x.labor_id === 3 && x.labor_grade > 0))
    assert(timber.talent_id.includes(20010110))
    assert(
        target.gene_infos.every(
            (g, i) =>
                g.pos === i + 1 &&
                g.gene_lv === 1 &&
                tables.find('pet_dna', g.gene_id) &&
                tables.get('skill_level').some((row) => row.skillId === g.gene_id && row.level === 1),
        ),
    )
    const captured = petData(tables, 500297, '999', 301)
    assert.deepEqual(captured.gene_infos, target.gene_infos)
    assert.equal(captured.grade, target.grade)
})

test('legacy pet repair is idempotent and preserves customized pet state', () => {
    const state = seedPlayer(tables, 2, 'pet-repair')
    const pet = state.pets.find((p) => p.config_id === 500297)
    pet.lv = 7
    pet.grade = 0
    delete pet.gene_infos
    delete pet.gene_state
    pet.comprehension = pet.comprehension.map(({ init_level, ...c }) => ({ ...c, level: 1, value: 100 }))
    const preserved = state.pets.find((p) => p.config_id === 500001)
    preserved.grade = 12345
    preserved.gene_infos = [{ pos: 1, gene_id: 533031, gene_lv: 3 }]
    preserved.gene_state = 1
    preserved.labor_infos = [{ labor_id: 3, labor_grade: 77, upper_labor_grade: 90, labor_exp: 12 }]
    preserved.talent_id = [20010120]
    preserved.comprehension[0] = { ...preserved.comprehension[0], level: 5, value: 120, init_level: 4, cur_exp: 17 }
    const guid = pet.guid,
        box = pet.box_id,
        revision = state.petRevision || 0
    assert.equal(repairPetProfiles(tables, state), true)
    assert.equal(state.petRevision, revision + 1)
    assert.equal(pet.guid, guid)
    assert.equal(pet.box_id, box)
    assert.equal(pet.lv, 7)
    assert(pet.grade > 0)
    assert.equal(pet.gene_infos.length, 8)
    assert.equal(pet.gene_state, 4)
    assert.equal(
        pet.comprehension.reduce((sum, c) => sum + c.level, 0),
        25,
    )
    assert(
        pet.comprehension.every(
            (c) =>
                c.init_level === c.level &&
                tables
                    .get('pet_talent_upgrade')
                    .some(
                        (row) =>
                            row.attrId === c.attr_id &&
                            row.level === c.level &&
                            c.value >= row.InterA &&
                            c.value <= row.InterB,
                    ),
        ),
    )
    assert.equal(preserved.grade, 12345)
    assert.deepEqual(preserved.gene_infos, [{ pos: 1, gene_id: 533031, gene_lv: 3 }])
    assert.deepEqual(preserved.labor_infos, [{ labor_id: 3, labor_grade: 77, upper_labor_grade: 90, labor_exp: 12 }])
    assert.deepEqual(preserved.talent_id, [20010120])
    assert.deepEqual(preserved.comprehension[0], { attr_id: 1, level: 5, value: 120, init_level: 4, cur_exp: 17 })
    assert.equal(repairPetProfiles(tables, state), false)
    assert.equal(state.petRevision, revision + 1)
})

test('interim all-100 D profiles reroll once but trained attributes remain unchanged', () => {
    const state = seedPlayer(tables, 3, 'pet-interim')
    const pet = state.pets[0],
        trained = state.pets[1]
    pet.comprehension = pet.comprehension.map((c) => ({ ...c, level: 3, init_level: 3, value: 100 }))
    trained.comprehension[0] = { ...trained.comprehension[0], level: 5, init_level: 3, value: 120, cur_exp: 22 }
    const preserved = structuredClone(trained.comprehension[0])
    assert.equal(repairPetProfiles(tables, state), true)
    assert.equal(
        pet.comprehension.reduce((sum, c) => sum + c.level, 0),
        25,
    )
    assert.deepEqual(trained.comprehension[0], preserved)
    const snapshot = structuredClone(state.pets)
    assert.equal(repairPetProfiles(tables, state), false)
    assert.deepEqual(state.pets, snapshot)
})

test('legacy saved pet profiles are repaired and encoded during normal login', () => {
    const protocol = new Protocol(configuration().base),
        store = new Store(':memory:'),
        game = new Game(protocol, store, tables)
    const enter = protocol.byName.get('CSProtoEnterGame')
    const login = () =>
        game.dispatch(
            {},
            { id: enter.id, seq: 1, payload: protocol.encode(enter.req, { open_id: 'legacy-pet-profile' }) },
        )
    try {
        login()
        const account = store.db.prepare('select id from accounts where open_id=?').get('legacy-pet-profile')
        store.transact(account.id, 0, (state) => {
            for (const pet of state.pets) {
                delete pet.grade
                delete pet.color
                delete pet.gene_infos
                delete pet.gene_state
                delete pet.labor_infos
                delete pet.talent_id
                pet.comprehension = pet.comprehension.map(({ init_level, ...c }) => ({ ...c, level: 1, value: 100 }))
            }
        })
        const packets = login(),
            sync = packets.find((x) => x.id === 6517)
        assert(sync)
        const data = protocol.decode(protocol.byId.get(sync.id).rsp, sync.payload)
        assert.equal(data.pet_infos.pets.length, seedPetCount)
        assert(data.pet_infos.pets.every((p) => p.grade > 0))
        assert(data.pet_infos.pets.every((p) => p.color === 0))
        assert(
            data.pet_infos.pets.every(
                (p) =>
                    p.comprehension.length === 6 &&
                    p.comprehension.reduce((sum, c) => sum + c.level, 0) === 25 &&
                    p.comprehension.every((c) => c.init_level === c.level),
            ),
        )
        const saved = store.load(account.id).state.pets.find((p) => p.config_id === 500297)
        assert.equal(saved.gene_infos.length, 8)
        assert.equal(saved.labor_infos[0].labor_id, 5)
    } finally {
        store.close()
    }
})
