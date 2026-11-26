import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const artifactDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-weekly-story-current-'))
process.env.LURUKAPS_DIAGNOSTICS_FILE = path.join(artifactDirectory, 'diagnostics.jsonl')
process.env.LURUKAPS_REWARD_SOURCE_LOG = path.join(artifactDirectory, 'reward-source.jsonl')
process.env.LURUKAPS_WEEKLY_STORY_TRACE_DIR = path.join(artifactDirectory, 'trace')
console.log('[weekly-story-test-artifacts] ' + artifactDirectory)
const { createWeeklyStoryFixture } = await import('./weekly-story-current-fixture.js')

function rejectedWithoutEffects(f, action) {
    const before = f.protectedState()
    assert.throws(action, (error) => Number.isInteger(error.code))
    assert.deepEqual(f.protectedState(), before)
}
function beforeEndDamage(f) {
    const before = f.hp(),
        record = structuredClone(f.state().weeklyDungeonRecords)
    try {
        f.hurt(true)
    } catch (error) {
        assert(Number.isInteger(error.code))
    }
    assert.deepEqual(f.hp(), before, 'intro has no accepted HP damage')
    assert(!f.run().battle_start_time)
    assert.deepEqual(f.state().weeklyDungeonRecords, record)
}
function end(f) {
    const p = f.plan()
    f.call('PlayerStoryStop', { story_id: p.story_id, op: 1 })
    assert.equal(f.run().materialStory.phase, 'done')
    assert.equal(f.run().battle_start_time, f.now())
    const before = f.protectedState()
    f.call('PlayerStoryStop', { story_id: p.story_id, op: 1 })
    assert.deepEqual(f.protectedState(), before, 'same-run END replay has no repeated progression')
}
function finishBoss(f, id) {
    const before = f.hp()
    f.hurt(true)
    for (const old of before) assert.equal(f.hp().find((row) => row.uuid === old.uuid).hp, old.hp - 1)
    f.advanceMs(2)
    f.hurt()
    assert(f.hp().every((row) => row.hp === 0 && row.alive_state === 1))
    assert(f.run().battle_complete)
    assert.equal(f.state().weeklyDungeonRecords[id].success_count, 1)
}
function claim(f) {
    const box = f.chest(),
        stamina = f.balance(3),
        quota = f.balance(104),
        reply = f.reply('StaminaBoxGet', f.call('StaminaBoxGet', { box_id: box.id, times: 1 }))
    assert(reply.reward.rewards.length > 0)
    assert.equal(f.balance(3), stamina - 40n)
    assert.equal(f.balance(104), quota - 1n)
    const after = f.assets()
    assert.deepEqual(f.reply('StaminaBoxGet', f.call('StaminaBoxGet', { box_id: box.id, times: 1 })).reward.rewards, [])
    assert.deepEqual(f.assets(), after)
    return box
}

for (const id of [101, 201, 301])
    test(`current weekly${id} real intro readiness/END gates/HP clear/settlement replay`, () => {
        const f = createWeeklyStoryFixture('weekly-story-current-' + id, id === 301 ? { pastTaskIds: [106022] } : {})
        try {
            const origin = structuredClone(f.state().world)
            f.enter(id)
            f.positionForTrigger()
            const packets = f.trigger(),
                start = f.assertBossPublishedBeforeStory(packets)
            assert.equal(start.story_id, f.plan().story_id)
            assert.equal(start.target_id, f.plan().boss_id)
            assert.equal(start.start_time, f.now())
            assert.equal(f.run().materialStory.phase, 'playing')
            if (id === 201) assert.equal(f.boss().length, 2, 'current201 has both real pack slots')
            rejectedWithoutEffects(f, () => f.call('PlayerStoryStop', { story_id: f.plan().story_id + 1, op: 1 }))
            rejectedWithoutEffects(f, () => f.call('PlayerStoryStop', { story_id: f.plan().story_id, op: 99 }))
            rejectedWithoutEffects(f, () => f.call('PlayerStoryStop', { story_id: f.plan().story_id, op: 2 }))
            beforeEndDamage(f)
            if (id === 101) {
                const old = f.session(),
                    began = f.run().materialStory.started_at
                f.advanceMs(1000)
                const replay = [...f.login(), ...f.ready()]
                assert.equal(f.state().world.map_id, f.run().map_id)
                const notice = f.packet(replay, 'SCProtoPlayerStoryStart')
                assert(notice, 'pending story replays on the real new connection')
                assert.equal(notice.story_id, start.story_id)
                assert.equal(f.run().materialStory.started_at, began)
                assert.equal(f.run().materialStory.playback_started_at, f.now())
                rejectedWithoutEffects(f, () => f.call('PlayerStoryStop', { story_id: f.plan().story_id, op: 1 }, old))
            }
            end(f)
            finishBoss(f, id)
            const beforeSettlement = f.assets(),
                box = f.chest()
            if (id === 301) {
                f.call('StaminaBoxGiveUp', { box_id: box.id })
                assert.deepEqual(f.assets(), beforeSettlement)
                const receipt = structuredClone(f.run().chest_given_up)
                f.call('StaminaBoxGiveUp', { box_id: box.id })
                assert.deepEqual(f.run().chest_given_up, receipt)
                rejectedWithoutEffects(f, () => f.call('StaminaBoxGet', { box_id: box.id, times: 1 }))
            } else {
                claim(f)
                if (id === 101) {
                    const quota = f.balance(104),
                        fee = f.balance(3)
                    f.call('MultiCampaignRestart')
                    assert(!f.run().battle_complete && !f.run().materialStory)
                    assert.equal(f.balance(104), quota)
                    assert.equal(f.balance(3), fee)
                    rejectedWithoutEffects(f, () => f.call('PlayerStoryStop', { story_id: start.story_id, op: 1 }))
                }
            }
            f.call('MultiCampaignQuit')
            assert.equal(f.run(), undefined)
            assert.equal(f.state().world.map_id, origin.map_id)
            f.login()
            assert.equal(f.run(), undefined)
            assert.equal(f.state().weeklyDungeonRecords[id].success_count, 1)
        } finally {
            f.close()
        }
    })

test('current weekly101 real11270 and paid9974 encoder faults rollback SQL/pending/currency/owned state', () => {
    const f = createWeeklyStoryFixture('weekly-story-current-codec')
    const failEncoding = (type, action) => {
        const before = f.protectedState(),
            sql = f.rawSQL(),
            pending = f.store.pending.get(f.state().player.basic_info.id),
            pendingState = pending?.state,
            pendingCopy = structuredClone(pending),
            encode = f.protocol.encode
        let faults = 0
        f.protocol.encode = function (name, ...args) {
            if (name === type) {
                faults++
                throw Error('weekly-current-real-codec')
            }
            return encode.call(this, name, ...args)
        }
        try {
            assert.throws(action, /weekly-current-real-codec/)
        } finally {
            f.protocol.encode = encode
        }
        assert.equal(faults, 1, 'fault must reach the real outgoing encoder')
        assert.deepEqual(f.protectedState(), before)
        assert.deepEqual(f.rawSQL(), sql)
        assert.strictEqual(f.store.pending.get(f.state().player.basic_info.id), pending)
        assert.strictEqual(f.store.pending.get(f.state().player.basic_info.id)?.state, pendingState)
        assert.deepEqual(f.store.pending.get(f.state().player.basic_info.id), pendingCopy)
    }
    try {
        f.enter(101)
        f.positionForTrigger()
        failEncoding(f.protocol.byName.get('SCProtoPlayerStoryStart').rsp, () => f.trigger())
        f.assertBossPublishedBeforeStory(f.trigger())
        end(f)
        finishBoss(f, 101)
        failEncoding(f.protocol.byName.get('CSProtoStaminaBoxGet').rsp, () =>
            f.call('StaminaBoxGet', { box_id: f.chest().id, times: 1 }),
        )
        claim(f)
    } finally {
        f.close()
    }
})
