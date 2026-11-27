import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { currentSunyaInput } from './current-sunya-input.js'
const tables = new Tables(configuration().tables)
const source = JSON.parse(fs.readFileSync(new URL('../configs/playable-enemies.json', import.meta.url))).playables.find(
    (row) => row.id === 62043,
)
// Explicit serialized identity inputs for pure tests;integration uses the
// real WorldObjEnemyInfo response and actual damage RPCs.
const roster = source.groups.flatMap((group) =>
    group.enemies.map((_, slot) => ({
        uuid: ((7n << 56n) | (BigInt(slot) << 32n) | BigInt(group.index + 1)).toString(),
        index: group.index,
        enemy_group: group.enemy_group,
    })),
)
const input = () => currentSunyaInput(tables, roster)
function clear(model, index) {
    for (const target of model.definition.waves[index].targets) model.observeDead(target)
    model.observeWaveClear(index)
}

test('current sunya enables exactly two configured wave tags and leaves the third group unused', () => {
    const model = input()
    assert.deepEqual(
        model.definition.waves.map((row) => [row.index, row.tag, row.targets.length]),
        [
            [0, 'monster_1', 4],
            [1, 'monster_2', 5],
        ],
    )
    assert.equal(model.definition.ignored.length, 8)
    assert.equal(model.takeFinish(), null)
})
test('a source wave must start and clear all its own targets before the second wave can enter', () => {
    const model = input(),
        first = model.enterBattle()
    assert.equal(first.needsStart, true)
    assert.throws(() => model.observeDead(first.wave.targets[0]), /start required/)
    model.acknowledgeStart()
    assert.throws(() => model.observeWaveClear(0), /Every active-wave/)
    assert.throws(() => model.observeDead(model.definition.ignored[0]), /Only the active/)
    clear(model, 0)
    model.advance(1.999)
    assert.throws(() => model.enterBattle())
    model.advance(0.001)
    assert.equal(model.enterBattle().needsStart, false)
})
test('two clears still require the final director observation and emit only one finish', () => {
    const model = input()
    model.enterBattle()
    model.acknowledgeStart()
    clear(model, 0)
    model.advance(2)
    model.enterBattle()
    clear(model, 1)
    assert.equal(model.takeFinish(), null)
    assert.throws(() => model.observeFinalDirectorEnd())
    assert.equal(model.beginFinalPerformance(), 4)
    assert.equal(model.takeFinish(), null)
    model.observeFinalDirectorEnd()
    assert.deepEqual(model.takeFinish(), { playId: 62043, step: 10 })
    assert.equal(model.takeFinish(), null)
})
