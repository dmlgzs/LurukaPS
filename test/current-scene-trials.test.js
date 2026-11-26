import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { ErrorCode } from '../src/error-codes.js'
import { currentSceneTrialRoster, resolveCurrentTrialGroup } from '../src/current-scene-trials.js'

const tables = new Tables(configuration().tables)

function alteredGroup(change, missing) {
    const group = structuredClone(tables.find('heropet_interim_group', 6226))
    Object.assign(group, change)
    return {
        find(name, id) {
            if (missing?.(name, id)) return undefined
            return name === 'heropet_interim_group' && id === group.id ? group : tables.find(name, id)
        },
    }
}

test('current scene trialsId resolves authoritative current heroes and pets without legacy scene fields', () => {
    const before = JSON.stringify(tables.find('heropet_interim_group', 6226))
    assert.deepEqual(currentSceneTrialRoster(tables, 6226), {
        groupId: 6226,
        force: true,
        heroes: [{ pos: 0, id: 2108103 }],
        pets: [{ pos: 0, id: 104 }],
        controlId: 0,
    })
    assert.deepEqual(currentSceneTrialRoster(tables, 6207).heroes, [
        { pos: 0, id: 1070161 },
        { pos: 1, id: 1070162 },
        { pos: 2, id: 1070163 },
    ])
    assert.equal(currentSceneTrialRoster(tables, 6209).groupId, 500001)
    assert.equal(currentSceneTrialRoster(tables, 100), null)
    assert.equal(currentSceneTrialRoster(tables, { trailGroup: '2108103', extraTrialGroup: '2108103' }), null)
    assert.equal(JSON.stringify(tables.find('heropet_interim_group', 6226)), before)
})

test('automatic slots and control hero IDs retain their current table meanings', () => {
    assert.deepEqual(resolveCurrentTrialGroup(tables, 3), {
        groupId: 3,
        force: false,
        heroes: [{ pos: -1, id: 107001 }],
        pets: [{ pos: -1, id: 102 }],
        controlId: 107001,
    })
    const forced = resolveCurrentTrialGroup(tables, 1)
    assert.equal(forced.force, true)
    assert.equal(forced.heroes[0].pos, -1)
    assert.equal(forced.controlId, 0)
})

test('malformed current rows cannot become an empty or old-array fallback roster', () => {
    for (const change of [
        { force: 2 },
        { force: true },
        { hero_id: '' },
        { hero_id: '0#2108103' },
        { hero_id: '4#2108103' },
        { hero_id: '1#2108103|' },
        { hero_id: '1#2108103|2#2108103' },
        { hero_id: '1#2108103|1#107001' },
        { control: 1 },
        { control: 108003 },
        { pet_id: '0#104' },
        { pet_id: '1#104|2#104' },
    ])
        assert.throws(
            () => resolveCurrentTrialGroup(alteredGroup(change), 6226),
            (error) => error.code === ErrorCode.GameConfig,
        )
    assert.throws(
        () => resolveCurrentTrialGroup(tables, 0),
        (error) => error.code === ErrorCode.InvalidArgument,
    )
    assert.throws(
        () => currentSceneTrialRoster(tables, { trialsId: '6226', trailGroup: '2108103' }),
        (error) => error.code === ErrorCode.GameConfig,
    )
})

test('missing current actor prototypes and attributes fail before actor creation or inventory mutation', () => {
    for (const [name, id, code] of [
        ['hero_interim', 2108103, ErrorCode.GameConfig],
        ['hero', 108003, ErrorCode.HeroNotExist],
        ['pet_customized', 104, ErrorCode.GameConfig],
        ['pet', 500156, ErrorCode.PetConfNotExist],
        ['template_value', 500156, ErrorCode.GameConfig],
    ])
        assert.throws(
            () =>
                resolveCurrentTrialGroup(
                    alteredGroup({}, (table, key) => table === name && key === id),
                    6226,
                ),
            (error) => error.code === code,
        )
})
