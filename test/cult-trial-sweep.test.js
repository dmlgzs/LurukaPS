import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fixture } from './cult-archive-fixture.js'
import { ErrorCode } from '../src/error-codes.js'
import { recordCultTrialHistory } from '../src/cult-trial-history.js'
const request = { activity_id: 60001, trial_id: 101 }
function atTrial(f, phase = 1, trial = 101, attrs = 1000) {
    f.store.transact(f.session.id, 0, (s) => {
        const g = s.activities[60001].growup
        g.cur_stage = phase
        g.cur_growup_trail_stage = phase
        g.select_trail_id = trial
        g.cur_growup_stage = phase === 1 ? 4 : phase === 2 ? 8 : 13
        g.growup_train_attr.forEach((x) => (x.attr_value = attrs))
        s.tasks = []
        s.taskRecords = f.tables.get('task').map((x) => ({ task_id: x.id, count: 1 }))
        Object.assign(s.world, f.tables.position(f.tables.find('world_borthpos', 20005)))
    })
}
function realFirstWin(f) {
    f.start()
    atTrial(f)
    f.call('EnterCultTrial', request)
    f.call('MultiCampaignPlayerLoaded')
    for (const obj of [5, 6, 7]) {
        const s = f.state(),
            targets = Object.values(s.combat.entities).filter((x) => x.object_id === obj)
        f.call('BattleInfoReduce', {
            uint64_dic: [s.cultTrial.pets[0].guid, ...targets.map((x) => x.uuid)],
            battle_info: targets.map((x, i) => ({
                hurt_info: { from_id: '1', tar_id: String(i + 2), hp_change: -x.hp },
            })),
            base_time: '0',
        })
    }
    assert.equal(f.state().cultTrial.star, 3)
    f.call('CultTrialSwitchStep', request)
    f.call('WorldPoint', { point_id: 0 })
}
test('ordinary trial history keeps best real star count and never mutates the prior transaction ledger', () => {
    const old = {
            version: 1,
            archive: [],
            trails: [{ trail_id: 101, star: 3, score: '7000', guid: 'first' }],
            history_trail_stage: 1,
            endless_max_score: '0',
            endless_max_wave: 0,
        },
        entry = { growupArchive: old }
    recordCultTrialHistory(entry, { phase: 1 }, { trail_id: 101, star: 2, score: '4500', guid: 'later' })
    assert.notEqual(entry.growupArchive, old)
    assert.deepEqual(old.trails, [{ trail_id: 101, star: 3, score: '7000', guid: 'first' }])
    assert.deepEqual(entry.growupArchive.trails, old.trails)
    recordCultTrialHistory(entry, { phase: 1 }, { trail_id: 101, star: 3, score: '8000', guid: 'best' })
    assert.equal(entry.growupArchive.trails[0].score, '8000')
    assert.equal(old.trails[0].score, '7000')
})
test('9613 uses a real three-star kill history after reset and grants only table sweep attributes/score once, without a dungeon or bag rewards', () => {
    const f = fixture('cult-sweep')
    try {
        realFirstWin(f)
        const history = f.state().activities[60001].growupArchive.trails[0]
        assert.equal(history.star, 3)
        assert(BigInt(history.score) >= 6000n)
        f.call('ActivityGrowUpResetReq', { activity_id: 60001 })
        f.start()
        atTrial(f, 1, 101, 100)
        const before = f.state(),
            g = f.g(),
            packets = f.call('SweepCultTrial', request),
            after = f.state()
        assert.equal(after.cultTrial, undefined)
        assert.deepEqual(after.world, before.world)
        assert.equal(f.g().cur_stage, 2)
        assert.equal(f.g().trails[0].score, '6000')
        assert.equal(f.g().trails[0].star, 3)
        assert.equal(f.g().final_score, '600')
        assert(after.acceptedCultTrials[g.guid + ':101'])
        assert.deepEqual(
            after.activities[60001].growupArchive.trails[0],
            history,
            'Sweep never replaces real battle history',
        )
        assert.deepEqual(after.player, before.player)
        const delta = f.decode(packets, 'CSProtoActivityGrowUpAttrChangeSync')
        assert.equal(delta.change_type, 3)
        assert(
            delta.growup_attr_change.every(
                (x) =>
                    f.g().growup_train_attr.find((a) => a.attr_id === x.attr_id).attr_value ===
                    g.growup_train_attr.find((a) => a.attr_id === x.attr_id).attr_value + x.attr_value,
            ),
        )
        assert(
            packets.findIndex((x) => x.id === f.protocol.byName.get('CSProtoActivitySync').id) <
                packets.findIndex((x) => x.id === 9613),
        )
        const receipt = f.state()
        f.call('SweepCultTrial', request)
        assert.deepEqual(f.state(), receipt)
        const login = f.protocol.byName.get('CSProtoEnterGame')
        const loginPackets = f.game.dispatch(
            {},
            { id: login.id, seq: 9999, payload: f.protocol.encode(login.req, { open_id: 'cult-sweep' }) },
        )
        assert.equal(f.state().activities[60001].growupArchive.trails[0].star, 3)
        assert.equal(f.decode(loginPackets, 'CSProtoSyncArchiveGrowupData').data[0].trails[0].star, 3)
    } finally {
        f.store.close()
    }
})
test('9613 requires the actual current phase, exact selection, history and inclusive current rank threshold', () => {
    const f = fixture('cult-sweep-gates')
    try {
        f.start()
        atTrial(f, 1, 101, 100)
        assert.throws(
            () => f.call('SweepCultTrial', request),
            (e) => e.code === ErrorCode.CultTrailNotReachSweep,
        )
        assert.throws(
            () => f.call('SweepCultTrial', { ...request, archive_id: 1 }),
            (e) => e.code === ErrorCode.CultTrailCannotSweep,
        )
        assert.throws(
            () => f.call('SweepCultTrial', { activity_id: 60001, trial_id: 306 }),
            (e) => e.code === ErrorCode.CultTrailCannotSweep,
        )
        realFirstWinForSecondFixture(f)
        atTrial(f, 2, 201, 299)
        f.store.transact(f.session.id, 0, (s) => {
            s.activities[60001].growupArchive.trails.push({
                trail_id: 201,
                star: 3,
                score: '6000',
                guid: 'trusted-history-fixture',
            })
        })
        assert.throws(
            () => f.call('SweepCultTrial', { activity_id: 60001, trial_id: 201 }),
            (e) => e.code === ErrorCode.CultTrailNotReachSweep,
        )
        atTrial(f, 2, 201, 300)
        f.call('SweepCultTrial', { activity_id: 60001, trial_id: 201 })
        assert.equal(f.g().cur_stage, 3, 'Exactly total1200 reaches rank3, no strict-greater sweep gate')
    } finally {
        f.store.close()
    }
})
function realFirstWinForSecondFixture(f) {
    // Current-start restrictions require reset before starting the actual history producer.
    f.call('ActivityGrowUpResetReq', { activity_id: 60001 })
    realFirstWin(f)
}
test('9613 rollback preserves current attributes and completion receipt if an outgoing settlement cannot encode', () => {
    const f = fixture('cult-sweep-codec')
    try {
        realFirstWin(f)
        f.call('ActivityGrowUpResetReq', { activity_id: 60001 })
        f.start()
        atTrial(f)
        const before = f.state(),
            encode = f.protocol.encode.bind(f.protocol)
        f.protocol.encode = (type, value) => {
            if (type === 'cs.ActivityGrowUpAttrChangeSync') throw Error('sweep codec')
            return encode(type, value)
        }
        assert.throws(() => f.call('SweepCultTrial', request), /sweep codec/)
        f.protocol.encode = encode
        assert.deepEqual(f.state(), before)
        f.call('SweepCultTrial', request)
        assert.equal(f.g().cur_stage, 2)
    } finally {
        f.store.close()
    }
})

test('9613 real battle history and accepted sweep receipts survive SQLite close/reopen', () => {
    const parent = path.resolve(os.tmpdir()),
        temp = fs.mkdtempSync(path.join(parent, 'cult-sweep-')),
        file = path.join(temp, 'state.sqlite')
    let f = fixture('cult-sweep-sql', file)
    try {
        realFirstWin(f)
        const history = f.state().activities[60001].growupArchive.trails
        f.call('ActivityGrowUpResetReq', { activity_id: 60001 })
        f.start()
        atTrial(f)
        f.store.close()
        f = fixture('cult-sweep-sql', file, true)
        assert.deepEqual(f.state().activities[60001].growupArchive.trails, history)
        f.call('SweepCultTrial', request)
        const score = f.g().final_score,
            attrs = f.g().growup_train_attr
        f.store.close()
        f = fixture('cult-sweep-sql', file, true)
        f.call('SweepCultTrial', request)
        assert.equal(f.g().final_score, score)
        assert.deepEqual(f.g().growup_train_attr, attrs)
        assert.deepEqual(f.state().activities[60001].growupArchive.trails, history)
    } finally {
        f.store.close()
        if (path.dirname(path.resolve(temp)) !== parent || !path.basename(temp).startsWith('cult-sweep-'))
            throw Error('Unexpected cleanup target')
        fs.rmSync(temp, { recursive: true, force: true })
    }
})

test('9613 final sweep produces the configured ending and keeps the 9811 presentation exit contract', () => {
    const f = fixture('cult-sweep-final')
    try {
        realFirstWin(f)
        atTrial(f, 3, 301, 1000)
        f.store.transact(f.session.id, 0, (s) => {
            const g = s.activities[60001].growup
            // Trusted completed second phase / previous final history fixtures;
            // the first phase above uses the real kill and acceptance producer.
            g.trails[1] = { trail_id: 201, star: 3, score: '6000', rate: 15000, guid: g.guid }
            s.acceptedCultTrials[g.guid + ':201'] = true
            s.activities[60001].growupArchive.trails.push({
                trail_id: 301,
                star: 3,
                score: '6000',
                guid: 'prior-final-fixture',
            })
            s.worldHistory = [
                {
                    map_id: s.world.map_id,
                    point_id: s.world.point_id,
                    area_id: s.world.area_id,
                    pos: { ...s.world.pos },
                    angle: s.world.angle,
                },
            ]
            Object.assign(s.world, f.tables.position(f.tables.find('world_borthpos', 10100101)))
        })
        const before = f.state(),
            packets = f.call('SweepCultTrial', { activity_id: 60001, trial_id: 301 })
        assert.equal(f.g().cur_stage, 4)
        assert.equal(f.g().cur_growup_trail_stage, 4)
        assert.equal(f.g().trails[2].trail_id, 301)
        assert.equal(f.g().trails[2].score, '6000')
        assert(f.g().end_data.complete_end.some((x) => x.id === 101))
        assert.equal(f.state().world.map_id, before.world.map_id)
        assert(packets.some((x) => x.id === 9613))
        f.call('QuitPhotoGraphScene')
        assert.equal(f.state().world.map_id, 200)
        assert.equal(f.state().cultTrial, undefined)
        assert.deepEqual(f.state().player, before.player)
    } finally {
        f.store.close()
    }
})
