import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { petGeneProjection } from '../src/pet-gene-projection.js'
import { ErrorCode } from '../src/error-codes.js'

const tables = new Tables(configuration().tables)
const definitions = tables.get('pet_dna').map((row) => ({ row, projection: petGeneProjection(tables, row.id) }))

test('pure current resource classification retains107 effect,122 numeric and5 element-backed type2 definitions', () => {
    assert.equal(definitions.length, 234)
    const counts = { effect: 0, numeric: 0, element: 0 }
    for (const { row, projection } of definitions) {
        counts[projection.mode]++
        const skill = tables.find('skill', row.id)
        assert.equal(projection.skillType, skill.skillType)
        if (projection.mode === 'numeric') {
            assert(tables.find('skillsub_attrup', row.id))
            assert(!Object.hasOwn(projection, 'descriptor'), 'Numeric definitions do not gain duplicate native skills')
        } else {
            assert.deepEqual(projection.descriptor, { skill_id: row.id, skill_lv: 1, skill_slot: 0, type: 0 })
        }
    }
    assert.deepEqual(counts, { effect: 107, numeric: 122, element: 5 })
})

test('five immutable source programs retain all six distinct formula operations without flattening runtime properties', () => {
    const operations = []
    for (const { row, projection } of definitions.filter((entry) => entry.projection.mode === 'element')) {
        assert.equal(projection.skillType, 2)
        assert.equal(projection.program.binding.id, row.id)
        assert.equal(projection.sourceFingerprint.length, 64)
        assert(Object.isFrozen(projection.program))
        assert.throws(() => {
            projection.program.elements[0].parameters.functionParams[0] = 0
        }, TypeError)
        assert(
            !Object.hasOwn(projection, 'attrs'),
            'Programs are executable source definitions, not server attribute grants',
        )
        for (const track of projection.program.tracks)
            for (const line of track.lines) {
                assert.deepEqual([line.startFrame, line.endFrame], [0, 1])
                for (const inject of line.injectors) {
                    assert.equal(inject.parameters.directInjectTargetType, 0)
                    assert.equal(inject.parameters.removeElementOnEnd, false)
                    assert(
                        inject.parameters.elementDataList.every((reference) => typeof reference.local_id === 'string'),
                    )
                }
            }
        for (const { parameters, formula } of projection.program.elements) {
            assert.equal(parameters.kiBoApplyType, 1)
            assert.equal(parameters.time, -1)
            assert.equal(parameters.baseIntParams[1], formula.id)
            operations.push([
                parameters.elementConfigId,
                parameters.attributeID,
                parameters.calculateType,
                parameters.functionParams[0],
                formula.functionOutput,
            ])
        }
    }
    assert.deepEqual(
        operations.sort((a, b) => a[0] - b[0]),
        [
            [533040001, 115, 2, -840, 'A/10000'],
            [533041001, 115, 2, -1260, 'A/10000'],
            [533042001, 115, 2, -1680, 'A/10000'],
            [533809001, 115, 1, -1000, 'A/10000'],
            [533809002, 105, 1, 1100, 'A'],
            [533823001, 115, 1, -2100, 'A/10000'],
        ],
    )
})

test('changed current bindings and unsupported execution kinds cannot borrow old resources or pretend a native effect', () => {
    const id = definitions.find((entry) => entry.projection.mode === 'element').row.id
    const bad = Object.create(tables)
    bad.get = (name) =>
        name === 'skill_level'
            ? tables.get(name).map((row) => (row.skillId === id ? { ...row, subSkillId: row.subSkillId + 1 } : row))
            : tables.get(name)
    assert.throws(
        () => petGeneProjection(bad, id),
        (error) => error.code === ErrorCode.GeneConfIsNull,
    )
    const unsupported = Object.create(tables)
    unsupported.get = (name) =>
        name === 'skillsub_logic'
            ? tables.get(name).map((row) => (row.skillId === id ? { ...row, skillLogicType: 0 } : row))
            : tables.get(name)
    assert.throws(
        () => petGeneProjection(unsupported, id),
        (error) => error.code === ErrorCode.FunctionClosed,
    )
    assert.throws(
        () => petGeneProjection(tables, 0),
        (error) => error.code === ErrorCode.GeneConfIsNull,
    )
})

test('missing a previously numeric row cannot silently reclassify that gene or substitute another native program', () => {
    const id = definitions.find((entry) => entry.projection.mode === 'numeric').row.id,
        bad = Object.create(tables)
    bad.get = (name) =>
        name === 'skillsub_attrup' ? tables.get(name).filter((row) => row.id !== id) : tables.get(name)
    assert.throws(
        () => petGeneProjection(bad, id),
        (error) => error.code === ErrorCode.GeneConfIsNull,
    )
    assert.equal(petGeneProjection(tables, id).mode, 'numeric')
})

test('referenced current formula changes or missing rows cannot borrow a stale program while numeric definitions remain independent', () => {
    const elementId = definitions.find((entry) => entry.projection.mode === 'element').row.id,
        numericId = definitions.find((entry) => entry.projection.mode === 'numeric').row.id
    for (const transform of [
        (rows) => rows.map((row) => (row.id === 3 ? { ...row, functionOutput: 'A' } : row)),
        (rows) => rows.filter((row) => row.id !== 5),
    ]) {
        const bad = Object.create(tables)
        bad.get = (name) => (name === 'element_formula' ? transform(tables.get(name)) : tables.get(name))
        assert.throws(
            () => petGeneProjection(bad, elementId),
            (error) => error.code === ErrorCode.GeneConfIsNull,
        )
        assert.deepEqual(petGeneProjection(bad, numericId), { mode: 'numeric', skillType: 2 })
    }
    const unrelated = Object.create(tables)
    unrelated.get = (name) =>
        name === 'element_formula'
            ? tables
                  .get(name)
                  .map((row) => (row.id === 2 ? { ...row, functionOutput: 'unsupported unrelated formula' } : row))
            : tables.get(name)
    assert.equal(petGeneProjection(unrelated, elementId).mode, 'element')
})
