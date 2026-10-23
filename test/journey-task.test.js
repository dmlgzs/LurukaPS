import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { achievementFixture } from './achievement-fixture.js'
import { heroData } from '../src/player.js'
import { mainHeroConfigId } from '../src/main-hero.js'
import { ErrorCode } from '../src/error-codes.js'
import { journeyModel, journeyLedger, observeJourney, journeySnapshot } from '../src/journey.js'

function progress(f, level = 20) {
    f.store.transact(f.session.id, 0, (s) => {
        const hero = heroData(mainHeroConfigId(f.tables, s.player.basic_info.sex), f.session.id, 1)
        hero.hero_lv = level
        s.player.heros_info.heros = [hero]
    })
}
test('journey publishes all referenced CBT3 targets; orphan tutorial rewards remain inactive', () => {
    const f = achievementFixture('journey-catalogue')
    try {
        const model = journeyModel(f.tables),
            packet = f.entryPackets.find((p) => p.id === 11880)
        assert.equal(model.targets.length, 315)
        assert.equal(model.tasks.length, 259)
        assert.equal(model.byKind.size, 68)
        const data = f.protocol.decode('SCJourneySync', packet.payload)
        assert.equal(data.journey_target.length, 295)
        assert.equal(data.journey_task.length, 259)
        assert.deepEqual(
            data.journey_group.map((r) => r.group_id),
            [1, 2, 3, 4, 5],
        )
        assert.equal(data.journey_task.find((r) => r.task_id === 20000).task_is_unlock, true)
        assert.equal(data.journey_task.find((r) => r.task_id === 20001).task_is_unlock, false)
        assert.throws(
            () => f.call('JourneyTaskFinish', { u32s: [6042009] }),
            (e) => e.code === ErrorCode.JourneyConfError,
        )
        assert.equal(f.state().journey.targets[6042009]?.claimed ?? false, false)
    } finally {
        f.store.close()
    }
})
test('journey claims a real configured level target via shared rewards exactly once', () => {
    const f = achievementFixture('journey-level-claim')
    try {
        progress(f)
        const packets = f.call('JourneyTaskFinish', { u32s: [1010002] })
        const reply = f.reply(packets, 9869)
        // Shared player-XP grants can additionally award table-defined level
        // up resources; keep those instead of asserting only two UI rows.
        assert.ok(reply.rewards.some((r) => r.itemtype === 10 && r.itemid === 10 && r.itemnum === 400))
        assert.ok(reply.rewards.some((r) => r.itemtype === 3 && r.itemid === 501000 && r.itemnum === 1))
        assert.equal(f.state().player.sbag_infos.items.find((i) => i.itemid === 501000).itemnum, 1)
        const snapshot = f.protocol.decode('SCJourneySync', packets.find((p) => p.id === 11880).payload)
        assert.equal(snapshot.journey_target.find((r) => r.target_id === 1010002).target_reward_status, 2)
        assert.equal(snapshot.point_val, 5)
        assert.deepEqual(f.reply(f.call('JourneyTaskFinish', { u32s: [1010002] }), 9869).rewards, [])
        assert.equal(f.state().player.sbag_infos.items.find((i) => i.itemid === 501000).itemnum, 1)
    } finally {
        f.store.close()
    }
})
test('unmet, unsupported, locked and malformed claims cannot manufacture progress or partial rewards', () => {
    const f = achievementFixture('journey-negative')
    try {
        assert.throws(
            () => f.call('JourneyTaskFinish', { u32s: [1010002] }),
            (e) => e.code === ErrorCode.JourneyContReward,
        )
        assert.throws(
            () => f.call('JourneyTaskFinish', { u32s: [1010006] }),
            (e) => e.code === ErrorCode.FunctionClosed,
        )
        assert.throws(
            () => f.call('JourneyTaskFinish', { u32s: [1120002] }),
            (e) => e.code === ErrorCode.JourneyTypeLock,
        )
        progress(f)
        const before = f.state()
        for (const u32s of [[], [1010002, 1010002], [1010002, 99999999], [1010002, 1010006]]) {
            assert.throws(() => f.call('JourneyTaskFinish', { u32s }))
            assert.deepEqual(f.state(), before)
        }
    } finally {
        f.store.close()
    }
})
test('ordinary request observes relevant progress and irrelevant chat does not rescan journey domains', () => {
    const f = achievementFixture('journey-observe')
    try {
        progress(f)
        // A GM request is an authoritative state change domain; observation is
        // not limited to the reward button and never trusts a client count.
        const packets = f.call('GMCommand', { command: Buffer.from('help') })
        assert.equal(f.state().journey.targets[1010002].value, 1)
        assert.ok(packets.some((p) => p.id === 11880))
        const state = f.state(),
            model = journeyModel(f.tables)
        observeJourney(f.tables, state, [12045])
        assert.equal(journeyLedger(state).targets[1010002].complete, true)
        assert.equal(
            journeySnapshot(f.tables, state).journey_target.find((r) => r.target_id === 1010002).target_reward_status,
            1,
        )
        assert.ok(model.targets.some((r) => !r.supported))
    } finally {
        f.store.close()
    }
})
test('wire encoding failure rolls back reward, point and claim receipt together', () => {
    const f = achievementFixture('journey-codec-rollback')
    try {
        progress(f)
        const before = f.state(),
            encode = f.protocol.encode.bind(f.protocol)
        f.protocol.encode = (name, value) => {
            if (/Rewards$/.test(name) && value?.rewards?.length) throw Error('injected reward codec failure')
            return encode(name, value)
        }
        assert.throws(() => f.call('JourneyTaskFinish', { u32s: [1010002] }), /codec failure/)
        assert.deepEqual(f.state(), before)
        f.protocol.encode = encode
        assert.ok(
            f.reply(f.call('JourneyTaskFinish', { u32s: [1010002] }), 9869).rewards.some((r) => r.itemid === 501000),
        )
    } finally {
        f.store.close()
    }
})
test('journey reward receipts and points survive SQLite close, reopen and login', async () => {
    const parent = path.dirname(fileURLToPath(import.meta.url))
    const dir = fs.mkdtempSync(path.join(parent, 'journey-relogin-'))
    let f
    try {
        const file = path.join(dir, 'state.sqlite')
        f = achievementFixture('journey-persist', file)
        progress(f)
        f.call('JourneyTaskFinish', { u32s: [1010002] })
        f.store.close()
        f = achievementFixture('journey-persist', file)
        const packet = f.entryPackets.find((p) => p.id === 11880)
        assert.equal(f.protocol.decode('SCJourneySync', packet.payload).point_val, 5)
        assert.deepEqual(f.reply(f.call('JourneyTaskFinish', { u32s: [1010002] }), 9869).rewards, [])
    } finally {
        f?.store.close()
        assert.equal(path.dirname(dir), parent)
        assert.ok(path.basename(dir).startsWith('journey-relogin-'))
        // VMware's extended-UNC recursive rm fails even after the database is
        // closed. This directory contains only this test's SQLite files.
        for (const name of fs.readdirSync(dir)) {
            assert.ok(/^state\.sqlite(?:-journal|-wal|-shm)?$/.test(name))
            for (let attempt = 0; ; attempt++) {
                try {
                    fs.unlinkSync(path.join(dir, name))
                    break
                } catch (error) {
                    if (error.code !== 'EBUSY' || attempt >= 20) throw error
                    await new Promise((resolve) => setTimeout(resolve, 100))
                }
            }
        }
        fs.rmdirSync(dir)
    }
})
