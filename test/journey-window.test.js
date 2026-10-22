import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { achievementFixture } from './achievement-fixture.js'
import { journeyModel, journeyLedger } from '../src/journey.js'

test('journey stage window acknowledgement is idempotent and cannot grant or complete a target', () => {
    const f = achievementFixture('journey-window')
    try {
        const before = f.state(),
            packets = f.call('ShowJourneyStageWindow')
        assert.ok(packets.some((p) => p.id === 11884))
        const data = f.protocol.decode('SCJourneySync', packets.find((p) => p.id === 11880).payload)
        assert.equal(data.window_show, 1)
        assert.equal(data.point_val, 0)
        assert.deepEqual(f.state().journey.targets, before.journey.targets)
        assert.deepEqual(f.state().player.sbag_infos, before.player.sbag_infos)
        f.call('ShowJourneyStageWindow')
        assert.equal(f.state().journey.windowShow, 1)
    } finally {
        f.store.close()
    }
})
test('journey window acknowledgement rolls back if its sync cannot be encoded', () => {
    const f = achievementFixture('journey-window-rollback')
    try {
        const before = f.state(),
            encode = f.protocol.encode.bind(f.protocol)
        f.protocol.encode = (name, value) => {
            if (name === 'cs.SCJourneySync') throw Error('window codec')
            return encode(name, value)
        }
        assert.throws(() => f.call('ShowJourneyStageWindow'), /window codec/)
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})
test('trace, point mask, selected real soul essence and window state survive real SQLite relogins', async () => {
    const parent = path.dirname(fileURLToPath(import.meta.url)),
        dir = fs.mkdtempSync(path.join(parent, 'journey-relogin-'))
    let f
    try {
        const file = path.join(dir, 'state.sqlite')
        f = achievementFixture('journey-all-persist', file)
        f.call('JourneyClientTrace', { journey_id: 1010001, is_trace: true })
        f.call('ShowJourneyStageWindow')
        f.store.close()
        f = achievementFixture('journey-all-persist', file)
        const first = f.protocol.decode('SCJourneySync', f.entryPackets.find((p) => p.id === 11880).payload)
        assert.equal(first.trace_id, 1010001)
        assert.equal(first.window_show, 1)
        f.call('JourneyClientTrace', { journey_id: 1010001, is_trace: false })
        // A complete imported/future ledger tests persistence of reward
        // entitlements, not implementation of the missing event producers.
        f.store.transact(f.session.id, 0, (s) => {
            const model = journeyModel(f.tables),
                ledger = journeyLedger(s)
            for (const row of model.targets)
                if (model.owner.has(row.id))
                    ledger.targets[row.id] = { value: row.targetParam, complete: true, claimed: true }
        })
        f.call('JourneyReceivePointReward')
        const [type, id] = f.tables.find('common_item', 1520901).giftBagReward.split('|')[0].split('#').map(Number)
        const reward = f.reply(f.call('JourneyReceiveSpecialReward', { u32s: [id, type] }), 11883).rewards[0]
        f.store.close()
        f = achievementFixture('journey-all-persist', file)
        const second = f.protocol.decode('SCJourneySync', f.entryPackets.find((p) => p.id === 11880).payload)
        assert.equal(second.reward_index, 63)
        assert.equal(second.window_show, 1)
        assert.equal(second.trace_id, 0)
        assert.equal(second.special_item.itemid, id)
        assert.ok(f.state().player.soulessence_infos.soulessences.some((s) => String(s.guid) === String(reward.guid)))
        assert.deepEqual(f.reply(f.call('JourneyReceivePointReward'), 11882).rewards, [])
        assert.deepEqual(f.reply(f.call('JourneyReceiveSpecialReward', { u32s: [id, type] }), 11883).rewards, [])
    } finally {
        f?.store.close()
        assert.equal(path.dirname(dir), parent)
        assert.ok(path.basename(dir).startsWith('journey-relogin-'))
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
