import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runCurrentMemoryMilestone } from './next106013-memory-runner.js'

test('current106013 post-memory NPC and created-enemy nodes finish naturally and survive cold login', async () => {
    const artifactRoot =
        process.env.NORMAL_106013_ARTIFACTS ?? fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-106013-end-'))
    fs.mkdirSync(artifactRoot, { recursive: true })
    process.env.LURUKAPS_DIAGNOSTICS_FILE = path.join(artifactRoot, 'diagnostics.jsonl')
    process.env.LURUKAPS_REWARD_SOURCE_LOG = path.join(artifactRoot, 'reward-source.jsonl')
    const [{ normalSuccessorFlow }, { stepCurrentCreatedTaskEnemyNode }] = await Promise.all([
        import('./prefix-correction-flow.js'),
        import('./next106013-created-enemy-node.js'),
    ])
    const profiles = new Map([
        [101087, { type: 0, tag: 0, clicks: 0, terminal: 5 }],
        [101064, { type: 3, tag: 0, clicks: 0, terminal: 1 }],
        [101065, { type: 0, tag: 0, clicks: 0, terminal: 30 }],
        [101069, { type: 1, tag: 0, clicks: 0 }],
        [101066, { type: 2, tag: 0, clicks: 0 }],
        [101068, { type: 2, tag: 0, clicks: 0 }],
        [101072, { type: 2, tag: 0, clicks: 0 }],
        [101073, { type: 2, tag: 0, clicks: 0 }],
        [101067, { type: 0, tag: 0, clicks: 0, terminal: 6 }],
        [101088, { type: 0, tag: 0, clicks: 0, terminal: 9 }],
        [101071, { type: 0, tag: 0, clicks: 0, terminal: 11 }],
        [101074, { type: 0, tag: 0, clicks: 0, terminal: 31 }],
        [101089, { type: 0, tag: 0, clicks: 0, terminal: 18 }],
        [101075, { type: 3, tag: 0, clicks: 0, terminal: 1 }],
        [101076, { type: 0, tag: 0, clicks: 0, terminal: 14 }],
        [101080, { type: 0, tag: 0, clicks: 0, terminal: 94 }],
    ])
    const watches = [],
        battles = [],
        taskWireSync = { finish: [], cold: [] }
    let before, final, visits
    try {
        await runCurrentMemoryMilestone({
            artifactRoot,
            afterMemory({ f, driver, observer }) {
                before = f.requestCount()
                assert.equal(before, 673, 'real shared memory prefix must run without a checkpoint')
                const playStory = (id) => {
                    const profile = profiles.get(id)
                    assert(profile, 'Current post-memory story not recovered: ' + id)
                    assert.equal(f.tables.find('story', id).storyType, profile.type)
                    // Explicit full local playback and the recovered concrete
                    //choices have completed before reporting. Do not infer
                    //tags/clicks from task requirements or a generic default.
                    driver.call('SetStoryId', {
                        story_id: id,
                        story_type: profile.type,
                        tag: profile.tag,
                        param: profile.clicks,
                        is_skip: false,
                    })
                    watches.push({ id, ...profile, nativePlayback: false })
                }
                const decodeTaskSyncs = (packets) =>
                    packets
                        .filter((packet) => packet.id === 9853)
                        .map((packet) => ({
                            id: packet.id,
                            seq: packet.seq,
                            pushSeq: packet.pushSeq,
                            decoded: f.protocol.decode(f.protocol.byId.get(packet.id).rsp, packet.payload),
                        }))
                const reportingDriver = {
                    ...driver,
                    call(name, ...args) {
                        const packets = driver.call(name, ...args)
                        if (name === 'TaskFinish') taskWireSync.finish.push(...decodeTaskSyncs(packets))
                        return packets
                    },
                }
                const flow = normalSuccessorFlow(
                    f,
                    { ...reportingDriver, playStory },
                    {
                        npcStoryCompletion(data) {
                            const profile = profiles.get(data.storyId)
                            assert(profile)
                            if (data.storyTag > 0) assert.equal(profile.tag, data.storyTag)
                            playStory(data.storyId)
                        },
                    },
                )
                try {
                    for (let count = 0; f.state().tasks.some((task) => task.task_id === 106013); count++) {
                        assert(count < 12, 'bounded current106013 final nodes')
                        const nodeId = f.state().tasks.find((task) => task.task_id === 106013).nodes[0].node_id
                        if ([15, 19].includes(nodeId))
                            battles.push(...stepCurrentCreatedTaskEnemyNode(f, reportingDriver, flow, 106013))
                        else flow.step(106013)
                    }
                    assert.equal(f.state().taskRecords.find((task) => task.task_id === 106013).count, 1)
                    assert.deepEqual(
                        flow.visits.map((row) => row.nodeId),
                        [11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
                    )
                    const expected = [
                        101087, 101064, 101065, 101066, 101069, 101068, 101067, 101088, 101071, 101072, 101073, 101074,
                        101089, 101075, 101076, 101080,
                    ]
                    assert.deepEqual(
                        watches.map((row) => row.id),
                        expected,
                    )
                    const delta = observer.trace.slice(before)
                    assert(delta.every((row) => !row.error))
                    assert.equal(
                        delta.filter((row) => row.id === 9904 && [2520, 2525].includes(row.request.key)).length,
                        0,
                    )
                    assert.deepEqual(
                        delta.filter((row) => row.id === 6060).map((row) => row.request),
                        expected.map((id) => {
                            const p = profiles.get(id)
                            return { story_id: id, is_skip: false, story_type: p.type, param: p.clicks, tag: p.tag }
                        }),
                    )
                    assert.equal(
                        battles.reduce((sum, row) => sum + row.slots.length, 0),
                        3,
                    )
                    const stable = { pets: f.state().pets.map((row) => row.guid), points: [...f.state().world.points] }
                    const finishSyncs = taskWireSync.finish.map((row) => row.decoded)
                    assert(finishSyncs.some((row) => row.del_tasks.includes(106013)))
                    assert(
                        finishSyncs
                            .flatMap((row) => row.task_records)
                            .some((row) => row.task_id === 106013 && row.count === 1),
                    )
                    assert(
                        finishSyncs
                            .flatMap((row) => row.tasks)
                            .some((row) => row.task_id === 996001 && row.nodes.some((node) => node.node_id === 6)),
                    )
                    taskWireSync.cold.push(...decodeTaskSyncs(f.coldLogin()))
                    const coldSyncs = taskWireSync.cold.map((row) => row.decoded)
                    assert(
                        coldSyncs
                            .flatMap((row) => row.task_records)
                            .some((row) => row.task_id === 106013 && row.count === 1),
                    )
                    assert(
                        coldSyncs
                            .flatMap((row) => row.tasks)
                            .some((row) => row.task_id === 996001 && row.nodes.some((node) => node.node_id === 6)),
                    )
                    assert(!coldSyncs.flatMap((row) => row.tasks).some((row) => row.task_id === 106013))
                    assert.equal(f.state().taskRecords.find((task) => task.task_id === 106013).count, 1)
                    assert.deepEqual(
                        f.state().pets.map((row) => row.guid),
                        stable.pets,
                    )
                    assert.deepEqual(f.state().world.points, stable.points)
                    assert.equal(
                        f.requestCount(),
                        740,
                        'execute the full current chapter and genuine cold-login request',
                    )
                    assert.equal(observer.trace.length, f.requestCount())
                } finally {
                    visits = flow.visits
                    final = {
                        requests: f.requestCount(),
                        newRequests: f.requestCount() - before,
                        summary: f.summary(),
                        record: f.state().taskRecords.find((task) => task.task_id === 106013),
                    }
                }
            },
        })
    } finally {
        fs.writeFileSync(
            path.join(artifactRoot, 'post-memory.json'),
            JSON.stringify(
                {
                    boundary:
                        'genuine normal shared673 prerequisite, explicit current story/local input models and actualHP0/taskSync; no GM/state injection/native renderer claim',
                    before,
                    final,
                    visits,
                    watches,
                    battles,
                    taskWireSync,
                },
                null,
                2,
            ) + '\n',
        )
    }
})
