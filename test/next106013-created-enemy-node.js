import assert from 'node:assert/strict'
import { nodeConditions, asList } from '../src/tasks.js'
import { taskEnemyPacks } from '../src/task-enemy-slots.js'
import { enemyDefinition } from '../src/enemy-state.js'
import { runCurrentConditionAfterQueue } from './prefix-correction-condition-phase.js'

// Current TaskEntityEnemiesGroup.useExistEnemy=false unbinds the local2039
//listener and creates task actors. Completion consumes server nodeValues;
//it does not manually report the existing-group2520 callback. This bounded
//test helper reads all current groups/inline slots and verifies realHP0 sync.
export function stepCurrentCreatedTaskEnemyNode(f, driver, flow, taskId) {
    const task = f.state().tasks.find((row) => row.task_id === taskId)
    assert.equal(task?.nodes.length, 1)
    const node = driver.graphs.get(taskId).nodes.get(task.nodes[0].node_id)
    const required = nodeConditions(node)
        .map((condition, index) => ({ condition, index }))
        .filter(({ condition }) => !condition.__type_TaskConditionBaseData?.unneedCompleted)
    assert(required.length)
    for (const { condition } of required) {
        assert.equal(condition.conditionId, 2520)
        assert.equal(
            condition.__type_TaskConditionBaseData.__type_TaskCondEnemiesGroupData.useExistEnemy,
            false,
            'this leaf cannot substitute the real existing-group sender',
        )
    }
    flow.visits.push({ taskId, nodeId: node.id, mapId: f.state().world.map_id })
    flow.perform(taskId, node, 'before')
    const request = { task_id: taskId, node_id: node.id }
    driver.call('MultiTaskClientBefore', { task_params: [request] })
    const proof = []
    for (const { condition, index } of required) {
        const data = condition.__type_TaskConditionBaseData.__type_TaskCondEnemiesGroupData
        const groups = asList(data.enemiesDatas),
            slots = [],
            synced = []
        assert(groups.length)
        const damage = (target, delta) => {
            f.advanceMs(2)
            const packets = driver.call('BattleInfoReduce', {
                base_time: String(f.nowMs()),
                uint64_dic: [f.currentGroup().control, target],
                battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: delta } }],
            })
            for (const packet of packets.filter((packet) => packet.id === 9853)) {
                const value = f.protocol
                    .decode(f.protocol.byId.get(packet.id).rsp, packet.payload)
                    .tasks.find((task) => task.task_id === taskId)
                    ?.nodes.find((value) => value.node_id === node.id)
                if (value) synced.push({ nodeId: value.node_id, values: value.node_values })
            }
        }
        for (const group of groups) {
            assert.equal(group.sceneId, f.state().world.map_id)
            assert.equal(group.__type_TaskEnemiesOverrideData.useInlineEnemySlots, true)
            driver.move({ x: group.posX, y: group.posY, z: group.posZ })
            const packs = taskEnemyPacks(f.tables, group)
            assert.equal(packs.length, asList(group.__type_TaskEnemiesOverrideData.enemySlots).length)
            for (const [slot, pack] of packs.entries()) {
                const target = ((4n << 56n) | (BigInt(slot) << 32n) | BigInt(group.createNpcId)).toString()
                const definition = enemyDefinition(f.tables, f.state(), target)
                assert.equal(definition.pack_id, pack)
                const hp = f.state().combat?.entities?.[target]?.hp ?? definition.max_hp
                assert(hp > 1)
                damage(target, -1)
                assert.equal(f.state().combat.entities[target].hp, hp - 1)
                damage(target, -(hp - 1))
                assert.equal(f.state().combat.entities[target].hp, 0)
                slots.push({ actor: target, pack, initialHp: hp, finalHp: 0, createNpcId: group.createNpcId })
            }
        }
        assert(
            synced.at(-1)?.values[index] >= 1,
            'current created-enemy node needs actual10705→9853 value before condition-after; no artificial2520 refresh',
        )
        proof.push({ taskId, nodeId: node.id, index, useExistEnemy: false, slots, synced })
    }
    const indexes = required.map(({ index }) => index)
    if (!runCurrentConditionAfterQueue(f, driver, taskId, node, indexes))
        driver.call('MultiTaskClientCondAfter', { task_params: [{ ...request, indexes }] })
    flow.perform(taskId, node, 'after')
    driver.call('MultiTaskClientAfter', { task_params: [request] })
    assert(
        !f
            .state()
            .tasks.find((task) => task.task_id === taskId)
            ?.nodes.some((row) => row.node_id === node.id),
    )
    return proof
}
