import assert from 'node:assert/strict'
import { taskOverrideNodeIds } from '../src/task-action-data.js'

// Bounded successful arrival/contact inputs for current3217420 guide tree
// bevtree_task_guide01_new (raw SHA0ccc528b0b5b9926fa48184f0fbdd8e632d5c95f6a5e7d822fc865d7095d7f58).
// This does not execute the44-node Unity tree,NavMesh,animations or AOI.
export function currentTaskGuideInput(tables, graph, nodeId) {
    const node = graph.nodes.get(nodeId)
    assert(node, 'Current guide node required')
    const conditions = node.__type_TaskConditionNodeData?.conditionList ?? []
    assert.equal(conditions.length, 1)
    const condition = conditions[0]
    assert.equal(condition.contentType, 16100)
    const base = condition.__type_TaskConditionBaseData
    const receiver = base.__type_TaskCondSignalReceiverData
    assert(receiver && receiver.signalType === 0 && receiver.npcId === 0)
    // Other AI actors can legitimately share this node. Qualify the concrete
    // producer indicated by current mapData,not every actor with any AI.
    const sources = graph.npcs.filter(
        (npc) =>
            npc.createNpcId === base.mapData?.targetId &&
            npc.overrideAI > 0 &&
            taskOverrideNodeIds(npc).includes(nodeId),
    )
    assert.equal(sources.length, 1, 'Unique current guide actor source required')
    const npc = sources[0]
    const template = tables.find('worldmap_' + npc.sceneId, npc.npcId)
    assert(template && template.spawnerId === npc.spawnerId)
    const spawner = tables.find('world_spawner', template.spawnerId)
    assert(spawner && spawner.basicType === 1 && spawner.objectType === 1 && spawner.property === 0)
    const unit = tables.find('unit', spawner.resourceId)
    assert(unit?.model, 'Current NPC model mapping required')
    const ai = tables.find('world_ai', npc.overrideAI)
    assert.equal(ai?.path, 'Config/World/Graph/BehaviorTree/bevtree_task_guide01_new.asset')
    const parameters = new Map(
        String(ai.paramInt)
            .split('|')
            .filter(Boolean)
            .map((token) => {
                const fields = token.split('#')
                assert.equal(fields.length, 2)
                const value = Number(fields[1])
                assert(Number.isSafeInteger(value))
                return [fields[0], value]
            }),
    )
    assert.equal(parameters.get('TaskId'), graph.config.id)
    const path = tables.find('world_path_node', parameters.get('pathId'))
    assert(path && path.sceneId === npc.sceneId && !path.pathJumpNode, 'Current linear guide path required')
    const points = path.pathNode.split('|').map((token) => {
        const values = token.split('#').map(Number)
        assert(values.length === 3 && values.every(Number.isFinite))
        return { x: values[0], y: values[1], z: values[2] }
    })
    assert(points.length > 1)
    const spawn = { x: npc.posX / 100, y: npc.posY / 100, z: npc.posZ / 100 }
    const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
    assert(distance(spawn, points[0]) <= 1, 'Qualified guide starts at its first path point')
    let next = 0,
        actor = spawn,
        player = null,
        sent = false
    const visits = []
    const position = (value) => {
        assert(value && ['x', 'y', 'z'].every((key) => Number.isFinite(value[key])))
        return { x: value.x, y: value.y, z: value.z }
    }
    return {
        source: {
            task: graph.config.id,
            node: nodeId,
            npc: npc.createNpcId,
            template: npc.npcId,
            spawner: spawner.id,
            unit: unit.id,
            ai: ai.id,
            path: path.id,
            map: npc.sceneId,
        },
        points,
        arrive(index, value) {
            const current = position(value)
            assert(Number.isSafeInteger(index) && index >= 0 && index < points.length)
            assert(distance(current, points[index]) <= 1, 'Actor has not reached the configured guide point')
            if (index === next - 1) return false
            assert.equal(index, next, 'Guide arrival must follow the current linear path')
            actor = current
            visits.push({ index, position: current })
            next++
            return true
        },
        playerAt(value) {
            player = position(value)
        },
        takeSignal() {
            // Source7→8→9→10: reached final target,isPatrolEnd,then the
            // player's attached trigger(radius4/halfHeight8). No event early.
            if (sent || next !== points.length || !player) return null
            if (Math.hypot(player.x - actor.x, player.z - actor.z) > 4 || Math.abs(player.y - actor.y) > 8) return null
            sent = true
            return { event: 2008, signalType: receiver.signalType, taskId: parameters.get('TaskId') }
        },
        snapshot: () => ({ next, actor, player, sent, visits: structuredClone(visits), localInputOnly: true }),
    }
}
