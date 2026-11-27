import test from 'node:test'
import assert from 'node:assert/strict'
import { taskPlayableResetFixture } from './task-playable-reset-fixture.js'
import { ErrorCode } from '../src/error-codes.js'

test('an aborted6250 run with a real62024 finish cannot satisfy the fresh500024 task on re-entry', () => {
    const f = taskPlayableResetFixture('current-task-playable-reset')
    try {
        f.enter()
        f.finishPlayable()
        f.call('CampaignQuit')
        assert.equal(f.state().storyCampaignClears?.[10200], undefined)
        assert(f.state().playableFinishes[62024])
        f.enter()
        const task = f.state().tasks.find((task) => task.task_id === 500024)
        assert.deepEqual(
            task.nodes.map((node) => [node.node_id, node.node_values]),
            [[2, [0]]],
        )
        assert.equal(f.state().playableFinishes[62024], undefined)
        assert.equal(f.state().playableRuns[62024], undefined)
        assert.equal(
            f.state().taskRecords.some((record) => record.task_id === 500024),
            false,
        )
        f.coldLogin()
        assert.deepEqual(f.state().tasks.find((task) => task.task_id === 500024).nodes[0].node_values, [0])
    } finally {
        f.close()
    }
})

test('a delayed finish without a new Start cannot restore the aborted attempt or update the fresh task', () => {
    const f = taskPlayableResetFixture('current-task-playable-late-finish')
    try {
        f.enter()
        f.finishPlayable()
        f.call('CampaignQuit')
        f.enter()
        const before = f.state()
        assert.throws(
            () => f.call('PlayableFinish', { playId: 62024, index: 0, score: 0 }),
            (error) => error.code === ErrorCode.InvalidArgument,
        )
        assert.deepEqual(f.state(), before)
        assert.deepEqual(f.state().tasks.find((task) => task.task_id === 500024).nodes[0].node_values, [0])
    } finally {
        f.close()
    }
})

test('failed campaign response encoding rolls back task replay and playable cleanup before a successful retry', () => {
    const f = taskPlayableResetFixture('current-task-playable-codec')
    try {
        f.enter()
        f.finishPlayable()
        f.call('CampaignQuit')
        const before = f.state(),
            encode = f.protocol.encode.bind(f.protocol)
        const syncType = f.protocol.byName.get('CSProtoCampaignInfoSync').rsp
        let fail = true
        f.protocol.encode = (name, value) => {
            if (fail && name === syncType && value.dungeon_id === 10200) {
                fail = false
                throw Error('test campaign replay encode failure')
            }
            return encode(name, value)
        }
        assert.throws(
            () => f.call('CampaignCreate', { group_id: 248, difficulty: 1 }),
            /test campaign replay encode failure/,
        )
        assert.equal(fail, false)
        assert.deepEqual(f.state(), before)
        f.protocol.encode = encode
        f.enter()
        assert.equal(f.state().playableFinishes[62024], undefined)
        assert.deepEqual(f.state().tasks.find((task) => task.task_id === 500024).nodes[0].node_values, [0])
    } finally {
        f.close()
    }
})

test('reconnecting to the same active instance retains its actual playable finish instead of replaying a fresh entry', () => {
    const f = taskPlayableResetFixture('current-task-playable-same-instance')
    try {
        f.enter()
        f.finishPlayable()
        const before = f.state()
        f.coldLogin()
        assert.equal(f.state().storyCampaign.instance_id, before.storyCampaign.instance_id)
        assert.deepEqual(f.state().playableFinishes[62024], before.playableFinishes[62024])
        assert.deepEqual(f.state().tasks.find((task) => task.task_id === 500024).nodes[0].node_values, [1])
        assert.equal(f.state().world.map_id, 6250)
    } finally {
        f.close()
    }
})
