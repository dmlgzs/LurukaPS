// New actual combined corrected519 + current106012; count561 must be verified in execution, not inferred.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const artifacts =
    process.env.NORMAL_106012_ARTIFACTS ?? fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-current106012-'))
fs.mkdirSync(artifacts, { recursive: true })
process.env.NORMAL_SUCCESSOR_ARTIFACTS = artifacts
process.env.NORMAL_PROGRESSION_ARTIFACTS = artifacts
process.env.LURUKAPS_DIAGNOSTICS_FILE = path.join(artifacts, 'diagnostics.jsonl')
process.env.LURUKAPS_REWARD_SOURCE_LOG = path.join(artifacts, 'reward-source.jsonl')
const [{ reachCurrent106012 }, { WorldObjectCatalog }, { worldCondition }, { normalSuccessorFlow }] = await Promise.all(
    [
        import('./prefix-correction-prerequisite.js'),
        import('../src/world-objects.js'),
        import('../src/handlers/world-objects.js'),
        import('./prefix-correction-flow.js'),
    ],
)

export function reachCurrent106013() {
    const context = reachCurrent106012()
    const { f, driver } = context
    const prefixRequests = f.requestCount()
    const actions = []
    const profiles = new Map([
        [101051, { type: 0, tag: 0, clicks: 0 }],
        [101052, { type: 0, tag: 0, clicks: 0 }],
        [101801, { type: 2, tag: 0, clicks: 0 }],
        [101802, { type: 0, tag: 1, clicks: 1, choice: { dialog: 10180205, optionIndex: 0 } }],
        [101807, { type: 0, tag: 0, clicks: 0 }],
        [101809, { type: 2, tag: 0, clicks: 0 }],
        [101810, { type: 0, tag: 0, clicks: 1, choice: { dialog: 10181009, optionIndex: 0 } }],
    ])
    const playStory = (id, phase = 'normal') => {
        const profile = profiles.get(id)
        assert(profile, 'Current106012 story source required: ' + id)
        assert.equal(f.tables.find('story', id).storyType, profile.type)
        actions.push({ kind: 'current-source-story-complete', id, phase, ...profile, unityPlayback: false })
        driver.call('SetStoryId', {
            story_id: id,
            story_type: profile.type,
            tag: profile.tag,
            param: profile.clicks,
            is_skip: false,
        })
    }
    const flow = normalSuccessorFlow(
        f,
        { ...driver, playStory },
        {
            npcStoryCompletion(data) {
                playStory(data.storyId)
            },
            afterSourceAction(kind) {
                if (kind !== 'TaskCoverPlayTalkData') return false
                const current = flow.actions.at(-1)
                assert.equal(current.taskId, 106012)
                assert.equal(current.nodeId, 15)
                const covers = driver.graphs
                    .get(106012)
                    .transports.flatMap((row) => row.__type_TaskNodeNPCTalkData?.coverDatas ?? [])
                assert.deepEqual(
                    covers.map((row) => [row.argKey1, row.argKey2, row.argKey3]),
                    [
                        [106012007, 200, 101806],
                        [106012011, 200, 101808],
                    ],
                )
                actions.push({ kind: 'local-talk-override-installed', covers, noOptionalInteractionClaimed: true })
                return true
            },
            conditionAfterLifecycle: {
                start(taskId, node, indexes) {
                    const data = node.__type_TaskConditionNodeData?.taskCondAfterActionList
                    const slots = data ? (Array.isArray(data) ? data : [data]) : []
                    const pending = []
                    for (const slot of slots) {
                        if (!indexes.includes(slot.coditionIndex)) continue
                        for (const union of slot.conditionAfterAction) {
                            const story = union.__type_TaskActionBaseData?.__type_TaskOpenStoryData
                            assert(story && story.isPlayEndCb === false)
                            assert.equal(story.storyId, 101807)
                            actions.push({
                                kind: 'condition-after-local-start-before-ACK',
                                taskId,
                                nodeId: node.id,
                                index: slot.coditionIndex,
                                story: story.storyId,
                                watchReportMayFollowACK: true,
                            })
                            actions.push({
                                kind: 'condition-after-local-complete-before-ACK',
                                taskId,
                                nodeId: node.id,
                                index: slot.coditionIndex,
                                story: story.storyId,
                                callbackThenWatchSerialization: true,
                            })
                            pending.push(story.storyId)
                        }
                    }
                    return pending
                },
                report(taskId, node, indexes) {
                    if (taskId === 106012 && node.id === 15) {
                        assert(
                            actions.some(
                                (row) =>
                                    row.kind === 'condition-after-local-complete-before-ACK' && row.story === 101807,
                            ),
                        )
                        assert(
                            !actions.some((row) => row.kind === 'current-source-story-complete' && row.id === 101807),
                        )
                        const packets = driver.call('TaskClientCondAfter', {
                            task_id: taskId,
                            node_id: node.id,
                            indexes,
                        })
                        assert(packets.some((row) => row.id === 9863))
                        actions.push({ kind: 'actual9863-ACK-before6060', taskId, nodeId: node.id, indexes })
                    } else
                        driver.call('MultiTaskClientCondAfter', {
                            task_params: [{ task_id: taskId, node_id: node.id, indexes }],
                        })
                },
                complete(pending) {
                    for (const id of pending ?? [])
                        playStory(id, 'watch-after9863-ACK-local-playback-already-completed')
                },
            },
        },
    )
    let transferred = false
    try {
        assert.equal(prefixRequests, 519)
        assert.deepEqual(
            f
                .state()
                .tasks.find((row) => row.task_id === 106012)
                .nodes.map((row) => row.node_id),
            [12],
        )
        assert.equal(f.state().world.map_id, 701)
        const world = new WorldObjectCatalog(f.tables)
        const { row, spawner, pos } = world.object(701, 200001)
        assert.equal(spawner.objectType, 303)
        assert(worldCondition(row.appearCond, f.state()))
        assert.equal(row.interactOverrideParams, '10#20006')
        assert.equal(f.tables.find('world_borthpos', 20006).cityId, 200)
        driver.move(pos)
        driver.call('EnterWorldMap', { map_id: 200, point_id: 20006, creator_id: f.state().player.basic_info.id })
        driver.call('MapLoadFinish')
        assert.equal(f.state().world.map_id, 200)
        actions.push({
            kind: 'actual-current-portal',
            world: 701,
            object: row.id,
            point: 20006,
            taskTransferClaimed: false,
        })
        for (let count = 0; f.state().tasks.some((row) => row.task_id === 106012); count++) {
            assert(count < 9, 'bounded current106012 graph')
            flow.step(106012)
        }
        assert.equal(f.state().taskRecords.find((row) => row.task_id === 106012).count, 1)
        assert.deepEqual(
            flow.visits.map((row) => row.nodeId),
            [12, 13, 14, 9, 15, 7, 10],
        )
        assert.equal(actions.filter((row) => row.kind === 'current-source-story-complete').length, 7)
        const stable = { pets: f.state().pets.map((pet) => pet.guid), points: [...f.state().world.points] }
        context.consume(f.coldLogin())
        assert.equal(f.state().taskRecords.find((row) => row.task_id === 106012).count, 1)
        assert.deepEqual(
            f.state().pets.map((pet) => pet.guid),
            stable.pets,
        )
        assert.deepEqual(f.state().world.points, stable.points)
        transferred = true
        return { ...context, task106012Flow: flow, task106012Actions: actions, artifacts }
    } finally {
        fs.writeFileSync(
            path.join(artifacts, 'current106012.json'),
            JSON.stringify(
                {
                    boundary:
                        'genuine corrected519 prerequisite and same memory store; actual requests with current explicit local visual/story completion models; no GM/checkpoint/level/owned edits',
                    prefixRequests,
                    requestsAfterPrefix: f.requestCount() - prefixRequests,
                    visits: flow.visits,
                    actions,
                    final: f.summary(),
                },
                null,
                2,
            ) + '\n',
        )
        if (!transferred) f.close()
    }
}
