import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { tourFixture } from './kibo-tour-fixture.js'
import { ErrorCode } from '../src/error-codes.js'
const activity = (s) => s.activities?.[8001]?.kiboTour
const start = (f, id, ids = f.petIds()) => f.call('StartKiboTour', { activity_id: 8001, tour_id: id, pet_id_list: ids })
test('10407 creates a real permanent-pet trip, sends activity/pet state before empty ACK and repeats without extending time or quotas', () => {
    const f = tourFixture('tour-start-real')
    try {
        const ids = f.petIds(2),
            before = f.state(),
            packets = start(f, 1001, ids),
            ledger = activity(f.state()),
            run = ledger.runs[1001]
        assert.equal(run.start_time, f.now)
        assert.equal(run.end_time, f.now + 10)
        assert.equal(run.state, 0)
        assert.equal(ledger.total_times, 0)
        assert.equal(ledger.next_attempt, 2)
        assert.deepEqual(run.pet_ids, ids)
        assert.equal(f.state().player.basic_info.gold, before.player.basic_info.gold)
        assert.deepEqual(f.state().player.sbag_infos, before.player.sbag_infos)
        assert.ok(ids.every((id) => f.state().pets.find((p) => p.guid === id).tour_state === 1))
        const ack = f.protocol.byName.get('CSProtoStartKiboTour').id,
            sync = f.protocol.byName.get('CSProtoPetInfoSync').id
        assert.ok(packets.findIndex((p) => p.id === sync) < packets.findIndex((p) => p.id === ack))
        const snapshot = f.decode(packets, 'ActivitySync').activitys.find((x) => x.id === 8001).data.tour_group
        assert.equal(snapshot.total_times, 0)
        assert.equal(snapshot.tour_data[0].tour_id, 1001)
        assert.deepEqual(Object.keys(snapshot.tour_data[0]).sort(), [
            'end_time',
            'pet_ids',
            'start_time',
            'state',
            'tour_id',
        ])
        const saved = structuredClone(ledger)
        f.advance(1)
        start(f, 1001, ids)
        assert.deepEqual(activity(f.state()), saved)
        assert.throws(
            () => start(f, 1001, [ids[0]]),
            (e) => e.code === ErrorCode.ActivityTourExist,
        )
    } finally {
        f.close()
    }
})
test('10407 validates activity gate, real catalogue, party shape, ownership, and current quota using exact client errors atomically', () => {
    const f = tourFixture('tour-start-validation')
    try {
        const ids = f.petIds(7)
        for (const [r, code] of [
            [{ activity_id: 1, tour_id: 1001, pet_id_list: [ids[0]] }, ErrorCode.NoActivityConf],
            [{ activity_id: 2001, tour_id: 1001, pet_id_list: [ids[0]] }, ErrorCode.ActivityTypeNotEqual],
            [{ activity_id: 8001, tour_id: 9999, pet_id_list: [ids[0]] }, ErrorCode.ActivityInvalidTourConf],
            [{ activity_id: 8001, tour_id: 1001, pet_id_list: [] }, ErrorCode.ActivityTourNonePets],
            [{ activity_id: 8001, tour_id: 1001, pet_id_list: ids }, ErrorCode.ActivityTourPetsDataError],
            [{ activity_id: 8001, tour_id: 1001, pet_id_list: [ids[0], ids[0]] }, ErrorCode.ActivityTourPetsDataError],
            [
                { activity_id: 8001, tour_id: 1001, pet_id_list: ['18446744073709551615'] },
                ErrorCode.ActivityTourPetsDataError,
            ],
        ]) {
            const before = f.state()
            assert.throws(
                () => f.call('StartKiboTour', r),
                (e) => e.code === code,
            )
            assert.deepEqual(f.state(), before)
        }
        f.edit((s) => (s.taskRecords = []))
        assert.throws(
            () => start(f, 1001, [ids[0]]),
            (e) => e.code === ErrorCode.ActivityConditionNone,
        )
        f.edit((s) => (s.taskRecords = [{ task_id: 106013, count: 1 }]))
        start(f, 1001, [ids[0]])
        assert.throws(
            () => start(f, 1002, [ids[0]]),
            (e) => e.code === ErrorCode.ActivityHavePetAlreadyTour,
        )
        start(f, 1002, [ids[1]])
        start(f, 1003, [ids[2]])
        assert.throws(
            () => start(f, 1004, [ids[3]]),
            (e) => e.code === ErrorCode.ActivityTourLimit,
        )
        f.edit((s) => (activity(s).total_times = 21))
        assert.throws(
            () => start(f, 1004, [ids[3]]),
            (e) => e.code === ErrorCode.ActivityTotalTourLimit,
        )
    } finally {
        f.close()
    }
})
test('tour timer uses seconds, completes at the exact boundary through real Game.tick and never issues rewards by elapsed time alone', () => {
    const f = tourFixture('tour-start-tick')
    try {
        const id = f.petIds()[0]
        start(f, 1001, [id])
        f.advance(9)
        assert.equal(f.game.activities.due(f.state(), f.now), false)
        f.advance(1)
        assert.equal(f.game.activities.due(f.state(), f.now), true)
        const before = f.state().player.sbag_infos,
            packets = f.game.tick(f.session.id, f.session)
        assert.ok(f.decode(packets, 'ActivitySync'))
        assert.equal(activity(f.state()).runs[1001].state, 1)
        assert.equal(activity(f.state()).total_times, 0)
        assert.deepEqual(f.state().player.sbag_infos, before)
        assert.equal(f.state().pets.find((p) => p.guid === id).tour_state, 1)
        assert.equal(f.game.activities.due(f.state(), f.now), false)
    } finally {
        f.close()
    }
})
test('trip presentation extends only its own account and event, while Start still refuses past the original hard window', () => {
    const f = tourFixture('tour-start-hard-vs-view')
    try {
        f.hardEnd = f.now + 2
        start(f, 1001)
        const hard = f.game.activities.window(
            f.game.activities.rows.find((r) => r.id === 8001),
            f.now,
        )
        const view = f.snapshot(),
            window = view.confs.find((r) => r.activity_id === 8001)
        assert.ok(window.end_time > hard.end_time)
        const times = f.game.activities.commonTimes(f.now, f.state()).data_list
        assert.equal(Number(times.find((t) => t.time_id === 998006).end_time), window.end_time)
        const other = structuredClone(f.state())
        other.activities = {}
        assert.equal(
            f.game.activities.snapshot(other, f.now).confs.find((r) => r.activity_id === 8001).end_time,
            hard.end_time,
        )
        assert.equal(
            f.game.activities.window(
                f.game.activities.rows.find((r) => r.id === 8001),
                f.now,
            ).end_time,
            hard.end_time,
        )
        f.advance(3)
        assert.ok(
            f.snapshot().activitys.some((r) => r.id === 8001),
            'already started trip remains reachable',
        )
        assert.throws(
            () => start(f, 1002, f.petIds(1, activity(f.state()).runs[1001].pet_ids)),
            (e) => e.code === ErrorCode.ActivityTimeLimit,
        )
        f.game.activities.rows.push({
            ...f.game.activities.rows.find((r) => r.id === 2001),
            id: 999999,
            timelimit: 998006,
        })
        assert.throws(
            () => start(f, 1002, f.petIds(1, activity(f.state()).runs[1001].pet_ids)),
            (e) => e.code === ErrorCode.FunctionClosed,
        )
        f.game.activities.rows.pop()
    } finally {
        f.close()
    }
})
test('tour start response encoding failure rolls back reservation, activity counters, pet mirrors and display state', () => {
    const f = tourFixture('tour-start-codec')
    try {
        const before = f.state(),
            encode = f.protocol.encode.bind(f.protocol),
            type = f.protocol.byName.get('CSProtoStartKiboTour').rsp
        f.protocol.encode = (t, v) => {
            if (t === type) throw Error('tour start codec')
            return encode(t, v)
        }
        assert.throws(() => start(f, 1001), /tour start codec/)
        f.protocol.encode = encode
        assert.deepEqual(f.state(), before)
    } finally {
        f.close()
    }
})
test('tour active attempt and pet reservation survive actual temporary SQLite close/reopen and complete normally after reconnect', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tour-start-')),
        file = path.join(dir, 'state.sqlite'),
        f = tourFixture('tour-start-reopen', { file })
    try {
        const id = f.petIds()[0]
        start(f, 1001, [id])
        const run = activity(f.state()).runs[1001]
        f.reopen()
        assert.deepEqual(activity(f.state()).runs[1001], run)
        assert.equal(f.state().pets.find((p) => p.guid === id).tour_state, 1)
        f.advance(10)
        f.game.tick(f.session.id, f.session)
        assert.equal(activity(f.state()).runs[1001].state, 1)
        f.reopen()
        assert.equal(activity(f.state()).runs[1001].state, 1)
        assert.equal(activity(f.state()).total_times, 0)
    } finally {
        f.close()
        fs.rmSync(file, { force: true })
        fs.rmdirSync(dir)
    }
})
