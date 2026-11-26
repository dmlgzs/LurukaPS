import test from 'node:test'
import assert from 'node:assert/strict'
import { TaskGraphs, makeNode } from '../src/tasks.js'
import { taskActions } from '../src/task-scenes.js'
import { tables, fixture, party } from './helpers/obt-appearance-fixture.js'

test('pet and vehicle riders follow the current control, and a real table-authorized task transfer clears riding before combat', () => {
    const graphSet = new TaskGraphs(tables)
    let transfer
    for (const row of tables.get('task')) {
        let graph
        try {
            graph = graphSet.get(row.id)
        } catch {
            continue
        }
        for (const [nodeId, node] of graph.nodes) {
            const action = taskActions(node, 'after').find((action) => {
                const point = tables.find('world_borthpos', action.__type_TaskTransferBaseData?.transferPointId)
                return point && point.cityId === 101
            })
            if (action) {
                transfer = {
                    graph,
                    taskId: row.id,
                    nodeId,
                    point: tables.find('world_borthpos', action.__type_TaskTransferBaseData.transferPointId),
                }
                break
            }
        }
        if (transfer) break
    }
    assert(transfer)
    for (const kind of ['pet', 'vehicle']) {
        const f = fixture(`mount-${kind}`)
        try {
            const { heroes } = party(f, [101010, 107001])
            f.call('EnterWorldMap', { map_id: 100, point_id: 10040 })
            f.call('SwitchWorldGroupControl', { type: 1, control: heroes[1].guid })
            let mount
            if (kind === 'pet')
                mount = f.state().pets.find((pet) => !pet.work_status && tables.find('mount', pet.config_id)).guid
            else {
                f.call('GMCommand', { command: Buffer.from('give 41 500930 1').toString('base64') })
                mount = f.state().vehicles.find((vehicle) => vehicle.conf_id === 500930).guid
            }
            f.call('WorldMapPlayerStatus', { status: 1, arg: mount })
            assert.equal(f.client.rider, heroes[1].guid)
            f.call('SwitchWorldGroupControl', { type: 1, control: heroes[0].guid })
            assert.equal(f.client.rider, heroes[0].guid)
            f.edit((state) => {
                state.tasks = [
                    {
                        task_id: transfer.taskId,
                        nodes: [{ ...makeNode(transfer.graph, transfer.nodeId, state), client_before: true }],
                        finish_nodes: [],
                        reward_nodes: [],
                    },
                ]
                state.taskEpochs ??= {}
                state.taskEpochs[transfer.taskId] = 1
            })
            f.call('EnterWorldMap', {
                task_id: transfer.taskId,
                node_id: transfer.nodeId,
                point_id: transfer.point.id,
                map_id: transfer.point.cityId,
            })
            assert.equal(f.state().world.status, 0)
            assert.equal(f.state().world.mount, '0')
            assert.equal(f.client.status, 0)
            assert.equal(f.client.mount, '0')
            assert.equal(f.client.control, heroes[0].guid)
            const attack = tables.find('hero', heroes[0].conf_id).attackSkill
            assert.doesNotThrow(() => f.call('SkillStart', { unit_id: heroes[0].guid, skill: { skill_id: attack } }))
        } finally {
            f.store.close()
        }
    }
})
