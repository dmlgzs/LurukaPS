import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { TaskGraphs } from '../src/tasks.js'
import { currentTaskGuideInput } from './current-task-guide-input.js'

const tables = new Tables(configuration().tables)
const graph = new TaskGraphs(tables).get(106016)
const create = () => currentTaskGuideInput(tables, graph, 35)

test('current guide resolves its task NPC,unit,AI overrides and seven actual path points', () => {
    const model = create()
    assert.deepEqual(model.source, {
        task: 106016,
        node: 35,
        npc: 106016030,
        template: 600633,
        spawner: 70196,
        unit: 103007,
        ai: 100575,
        path: 100100,
        map: 100,
    })
    assert.equal(model.points.length, 7)
    assert.deepEqual(model.points[0], { x: 601.85, y: 205.49, z: -245.67 })
    assert.deepEqual(model.points.at(-1), { x: 564.6, y: 211.92, z: -288.76 })
})

test('arrival,terminal patrol and player contact are all required;duplicates cannot advance or emit twice', () => {
    const model = create()
    model.playerAt(model.points[0])
    assert.equal(model.takeSignal(), null)
    assert.throws(() => model.arrive(1, model.points[1]), /linear path/)
    assert.throws(() => model.arrive(0, { ...model.points[0], x: model.points[0].x + 2 }), /not reached/)
    for (const [index, point] of model.points.entries()) {
        assert.equal(model.arrive(index, point), true)
        assert.equal(model.arrive(index, point), false)
        if (index < model.points.length - 1) assert.equal(model.takeSignal(), null)
    }
    assert.equal(model.takeSignal(), null)
    const end = model.points.at(-1)
    model.playerAt({ ...end, y: end.y + 9 })
    assert.equal(model.takeSignal(), null)
    model.playerAt(end)
    assert.deepEqual(model.takeSignal(), { event: 2008, signalType: 0, taskId: 106016 })
    assert.equal(model.takeSignal(), null)
})

test('unknown node,missing path,ambiguous actor and unsupported unit-property overrides cannot create an input producer', () => {
    assert.throws(() => currentTaskGuideInput(tables, graph, 999), /guide node/)
    const actor = graph.npcs.find((npc) => npc.createNpcId === 106016030)
    assert.throws(
        () => currentTaskGuideInput(tables, { ...graph, npcs: [...graph.npcs, actor] }, 35),
        /Unique current guide/,
    )
    const missing = { find: (name, id) => (name === 'world_path_node' ? null : tables.find(name, id)) }
    assert.throws(() => currentTaskGuideInput(missing, graph, 35), /linear guide path/)
    const overridden = {
        find: (name, id) =>
            name === 'world_spawner' ? { ...tables.find(name, id), property: 1 } : tables.find(name, id),
    }
    assert.throws(() => currentTaskGuideInput(overridden, graph, 35))
})
