import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runCurrentFlightMilestone } from './next106015-flight-runner.js'
import { normalSuccessorFlow } from './prefix-correction-flow.js'

export async function runCurrentHomeApproach({ outputDirectory, afterApproach } = {}) {
    const directory = outputDirectory ?? fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-home106015-'))
    fs.mkdirSync(directory, { recursive: true })
    const proof = {
        boundary:
            'Genuine3099 prerequisite; real declared world/own-home portals and bounded dynamic-item callback input; no GM/save edits/Unity execution',
    }
    await runCurrentFlightMilestone({
        outputDirectory: directory,
        afterFlight({ f, driver, observer }) {
            const before = f.requestCount(),
                local = []
            const assets = () => ({
                bag: f.state().player.sbag_infos,
                taskItems: f.state().taskItems,
                attrs: f.state().player.attr_infos,
            })
            const flow = normalSuccessorFlow(f, driver, {
                npcStoryCompletion: (data) => driver.playStory(data.storyId),
                specialNpcCompletion(data) {
                    assert.equal(data.specialNpcType, 3)
                    assert.equal(data.isNowCreate, true)
                    assert.equal(data.npcData.entityType, 33)
                    assert.equal(data.npcData.objType, 12)
                    assert.equal(f.tables.find('world_spawner', data.npcData.spawnerId).objectType, 12)
                    assert.equal(data.npcData.sceneId, f.state().world.map_id)
                    driver.move({ x: data.npcData.posX, y: data.npcData.posY, z: data.npcData.posZ })
                    // Current BreakItemComponent060083d4 dynamic branch calls
                    // CheckIsTaskSpecialNpc,then returns before TryInteractObject.
                    // Supply its successful local break callback; do not fabricate
                    // a generic loot request or grant an item from an NPC ID.
                    local.push({
                        kind: 'dynamic-item-break-callback',
                        target: data.npcData.createNpcId,
                        type: data.specialNpcType,
                    })
                },
            })
            try {
                assert.equal(before, 3099)
                while (f.state().tasks.find((task) => task.task_id === 106015).nodes[0].node_id !== 62) {
                    assert(flow.visits.length < 15)
                    const id = f.state().tasks.find((task) => task.task_id === 106015).nodes[0].node_id
                    const beforeAssets = id === 73 ? assets() : undefined
                    flow.step(106015)
                    if (id === 73) {
                        assert.deepEqual(assets(), beforeAssets)
                        driver.call('ClientBehaviourRecord', { key: 2519, args: [106015002, 106015, 73, 0, 1] })
                        assert.deepEqual(assets(), beforeAssets)
                        assert.equal(f.state().tasks.find((task) => task.task_id === 106015).nodes[0].node_id, 23)
                        local.push({ kind: 'duplicate-special-callback-no-award' })
                    }
                }
                const arrived = f.state()
                assert.equal(
                    arrived.world.map_id,
                    Number(f.tables.get('game').find((row) => row.title === 'HOME_ID').value),
                )
                assert.equal(arrived.tasks.find((task) => task.task_id === 106015).nodes[0].node_values[0], 0)
                f.coldLogin()
                assert.equal(f.state().tasks.find((task) => task.task_id === 106015).nodes[0].node_id, 62)
                assert.equal(f.state().tasks.find((task) => task.task_id === 106015).nodes[0].node_values[0], 0)
                assert(!f.state().taskRecords.some((task) => task.task_id === 106015))
                proof.final = {
                    requests: f.requestCount(),
                    task: 106015,
                    node: 62,
                    world: f.state().world,
                    pendingGuided: [10041, 10047, 10042, 10048].map((id) => f.tables.find('task_condition', id)),
                }
                const result = afterApproach?.({ f, driver, observer, flow })
                assert(!result?.then, 'Home continuation must run synchronously')
            } finally {
                Object.assign(proof, { before, after: f.requestCount(), visits: flow.visits, local })
                fs.writeFileSync(
                    path.join(directory, 'home-approach106015.json'),
                    JSON.stringify({ ...proof, trace: observer.trace.slice(before) }, null, 2) + '\n',
                )
            }
        },
    })
    return proof
}
