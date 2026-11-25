import test from 'node:test'
import assert from 'node:assert/strict'
import { Tables } from '../src/player.js'
import { configuration } from '../src/config.js'
import { handbookPlan, preparePetHandbook, petHandbookSnapshot } from '../src/pet-handbook.js'
import { ErrorCode } from '../src/error-codes.js'

const tables = new Tables(configuration().tables)
const favorTasks = tables.get('iconography_task').filter((row) => row.taskcondition.startsWith('13127|'))
const declaredSpecies = [...new Set(favorTasks.map((row) => Number(row.taskcondition.split('|')[1])))]
const species = declaredSpecies.filter((id) => handbookPlan(tables, id))
const chain = (id) => handbookPlan(tables, id).chains.find((rows) => rows[0].kind === 13127)
const specimen = (id, level, extra = {}) => ({ guid: '1', config_id: id, type: 1, lv: 1, favor_lv: level, ...extra })
const stateFor = (id, level) => ({ pets: [specimen(id, level)], recordPets: [id], petRevision: 1 })
const completedFavor = (state, id) =>
    chain(id)
        .filter((task) => state.petHandbook[id].completed_tasks.includes(task.id))
        .map((task) => task.target)

test('the complete current handbook catalog compiles with favor chains for all defined species', () => {
    let plans = 0
    for (const row of tables.get('pet')) {
        const plan = handbookPlan(tables, row.id)
        if (plan) plans++
    }
    assert.equal(plans, 215)
    assert.equal(favorTasks.length, 108)
    assert.equal(declaredSpecies.length, 18)
    assert.equal(species.length, 17)
    assert.deepEqual(
        declaredSpecies.filter((id) => !handbookPlan(tables, id)),
        [500639],
    )
    for (const id of species)
        assert.deepEqual(
            chain(id).map((task) => task.target),
            [2, 4, 6, 8, 9, 10],
        )
})

test('all current favor thresholds depend on favor level of the matching permanent species', () => {
    for (const id of species)
        for (const level of [undefined, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
            const state = stateFor(id, level)
            state.pets.push(specimen(id, 10, { guid: 'trial', type: 2 }))
            state.pets.push(specimen(id === 500001 ? 500002 : 500001, 10, { guid: 'other' }))
            state.pets[0].favor_val = 0xffffffff
            preparePetHandbook(tables, state)
            assert.deepEqual(
                completedFavor(state, id),
                chain(id)
                    .filter((task) => task.target <= (level ?? 0))
                    .map((task) => task.target),
            )
            const active = state.petHandbook[id].tasks.find((task) => chain(id).some((row) => row.id === task.task_id))
            const target = chain(id).find((task) => task.id === active.task_id).target
            assert.equal(active.count, Math.min(level ?? 0, target))
            assert.equal(active.complete, (level ?? 0) >= target)
        }
})

test('same-species favor levels use the greatest observed individual level and do not add together', () => {
    const id = species[0],
        state = stateFor(id, 4)
    state.pets.push(specimen(id, 2, { guid: '2' }))
    preparePetHandbook(tables, state)
    assert.deepEqual(completedFavor(state, id), [2, 4])
    assert.equal(state.petHandbook[id].max_favor, 4)
    assert(!state.petHandbook[id].completed_tasks.includes(chain(id).find((task) => task.target === 6).id))
})

test('witnessed favor progress survives release and lower-level replacements without inventing higher attainment', () => {
    const id = species[0],
        state = stateFor(id, 6)
    preparePetHandbook(tables, state)
    const old = structuredClone(state.petHandbook[id])
    state.pets = []
    state.petRevision++
    preparePetHandbook(tables, state)
    assert.deepEqual(completedFavor(state, id), [2, 4, 6])
    assert.equal(state.petHandbook[id].total_exp, old.total_exp)
    state.pets = [specimen(id, 1)]
    state.petRevision++
    preparePetHandbook(tables, state)
    assert.deepEqual(completedFavor(state, id), [2, 4, 6])
    assert.equal(state.petHandbook[id].max_favor, 6)
    assert(!Object.hasOwn(petHandbookSnapshot(state).infos[0], 'max_favor'))
})

test('explicit completed task history is retained when the new observed maximum field is absent', () => {
    const id = species[0],
        state = stateFor(id, undefined)
    preparePetHandbook(tables, state)
    const known = chain(id).find((task) => task.target === 6)
    delete state.petHandbook[id].max_favor
    state.petHandbook[id].completed_tasks = [known.id]
    state.petHandbook[id].tasks = []
    preparePetHandbook(tables, state, { force: true })
    assert.deepEqual(completedFavor(state, id), [2, 4, 6])
    delete state.petHandbook[id].max_favor
    state.petHandbook[id].completed_tasks = []
    state.petHandbook[id].tasks = [{ task_id: chain(id).at(-1).id, count: 10, complete: true }]
    preparePetHandbook(tables, state, { force: true })
    assert.deepEqual(completedFavor(state, id), [2, 4, 6, 8, 9, 10])
})

test('missing, malformed, unrelated and incomplete records never manufacture favor completion', () => {
    const id = species[0]
    for (const value of [undefined, null, '10', 11, -1, NaN, 1.5]) {
        const state = stateFor(id, value)
        preparePetHandbook(tables, state)
        assert.deepEqual(completedFavor(state, id), [])
        state.petHandbook[id].tasks = [{ task_id: chain(id).at(-1).id, count: 10, complete: false }]
        state.petHandbook[id].completed_tasks = [99999999]
        preparePetHandbook(tables, state, { force: true })
        assert.deepEqual(completedFavor(state, id), [])
    }
    const state = stateFor(id, 2)
    preparePetHandbook(tables, state)
    state.petHandbook[id].max_favor = 99
    assert.throws(
        () => preparePetHandbook(tables, state, { force: true }),
        (error) => error.code === ErrorCode.GameConfig,
    )
})

test('adding favor support preserves the strict guard for every other unsupported handbook condition', () => {
    const first = favorTasks[0]
    const source = {
        get(name) {
            const rows = tables.get(name)
            return name === 'iconography_task'
                ? rows.map((row) =>
                      row.id === first.id
                          ? { ...row, taskcondition: row.taskcondition.replace(/^13127\|/, '13000|') }
                          : row,
                  )
                : rows
        },
    }
    assert.throws(
        () => handbookPlan(source, species[0]),
        (error) => error.code === ErrorCode.FunctionClosed,
    )
})
