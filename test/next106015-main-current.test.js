import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { runCurrentShadowChapter } from './next106015-main-runner.js'

test('natural3156 finishes current106015 through real construction,worker,stocked food,scoped time,battle and both submissions', async () => {
    const { directory, final } = await runCurrentShadowChapter({
        outputDirectory: process.env.SHADOW_CHAPTER_106015_ARTIFACTS,
    })
    assert.equal(final.requests, 3322)
    assert.equal(final.record.count, 1)
    assert.equal(final.nextMain, 106016)
    assert.equal(final.level, 15)
    assert.equal(final.exp, 2450)
    const proof = JSON.parse(fs.readFileSync(directory + '/chapter106015.json', 'utf8'))
    assert.equal(proof.before, 3156)
    assert.equal(proof.trace.filter((row) => row.error).length, 0)
    const time = proof.trace.find((row) => row.id === 9904 && row.request.key === 1100)
    assert.deepEqual(time.request.args, [106015, 17, 0, 1])
    assert.equal(proof.state.taskTimeReports['106015:1:17:0'].format, 'indexed')
    const station = proof.events.find((row) => row.kind === 'stationed')
    assert(station)
    assert.equal(proof.state.pets.find((pet) => pet.guid === station.pet).work_status, 5)
    assert.deepEqual(
        proof.events.filter((row) => row.kind === 'submitted').map((row) => row.node),
        [30, 33],
    )
    assert.equal(proof.state.taskItems.find((item) => item.item_id === 450125).item_num, 0)
    assert.equal(proof.events.find((row) => row.kind === 'guided' && row.id === 10042).before, 1)
    assert.equal(proof.events.find((row) => row.kind === 'guided' && row.id === 10048).before, 1)
})
