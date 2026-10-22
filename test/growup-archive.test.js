import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Protocol } from '../src/protocol.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'
const cfg = configuration()
function fixture(name = 'growup-archive', file = ':memory:') {
    const tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base),
        store = new Store(file),
        session = {},
        game = new Game(protocol, store, tables, { clock: () => 1800000000, rng: () => 0 })
    let seq = 1
    const call = (name, r = {}) => {
        const p = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, {
            id: p.id,
            seq: seq++,
            payload: p.req ? protocol.encode(p.req, r) : Buffer.alloc(0),
        })
    }
    const decode = (packets, name) => {
        const p = protocol.byName.get(name)
        return protocol.decode(p.rsp, packets.find((x) => x.id === p.id).payload)
    }
    const login = call('EnterGame', { open_id: name })
    store.transact(session.id, 0, (s) => {
        s.taskRecords = [106010, 106013, 404002].map((task_id) => ({ task_id, count: 1 }))
        s.tasks = s.tasks.filter((t) => t.task_id !== 404002)
    })
    call('ActivityGet')
    const state = () => store.load(session.id).state,
        g = () => state().activities[60001].growup
    const start = () =>
        call('ActivityGrowUpStartSelectReq', { activity_id: 60001, starting_id: 101, select_assist_char_ids: [] })
    // Trusted persisted-result fixture, not a claim that a live client earned it.
    // It uses the existing finish producer and configured final trials/score policy.
    const complete = (values = [1000, 1000, 1000, 1000]) =>
        store.transact(session.id, 0, (s) => {
            const entry = s.activities[60001],
                run = entry.growup,
                system = game.activities.growup
            run.growup_train_attr.forEach((attr, index) => {
                attr.attr_value = values[index]
            })
            Object.assign(run, { cur_stage: 3, cur_growup_stage: 13, cur_growup_trail_stage: 3, select_trail_id: 301 })
            run.trails = [101, 201, 301].map((trail_id) => ({ trail_id, star: 3, score: '6000', guid: run.guid }))
            system.finish(
                run,
                60001,
                system.tables.get('game_events_cul_trial').find((x) => x.trialId === 301 && x.systemId === 60001),
            )
            s.acceptedCultTrials = {
                ...s.acceptedCultTrials,
                ...Object.fromEntries(run.trails.map((result) => [run.guid + ':' + result.trail_id, true])),
            }
        })
    return { tables, protocol, store, game, session, call, decode, state, g, start, complete, login }
}
const request = (slot = 1) => ({ activity_id: 60001, starting_id: 101, archive_id: slot })
test('9615 archives the actual completed A-rated run before ACK without changing ordinary state, awards or inventing endless records', () => {
    const f = fixture()
    try {
        f.start()
        f.complete()
        const before = f.g(),
            owned = structuredClone(f.state().player),
            packets = f.call('ArchiveGrowupData', request())
        assert(Number(before.final_score) >= 10000 && Number(before.final_score) < 12000)
        const syncIndex = packets.findIndex((p) => p.id === 9616),
            ackIndex = packets.findIndex((p) => p.id === 9615)
        assert(syncIndex >= 0 && ackIndex > syncIndex)
        const sync = f.decode(packets, 'CSProtoSyncArchiveGrowupData'),
            entry = sync.data[0],
            saved = entry.archive[0]
        assert.equal(entry.activity_id, 60001)
        assert.equal(entry.history_trail_stage, 0)
        assert.equal(entry.endless_max_score, '0')
        assert.equal(entry.endless_max_wave, 0)
        assert.deepEqual(entry.trails, [])
        assert.equal(saved.archive_id, 1)
        assert.equal(saved.guid, before.guid)
        assert.equal(saved.ending_id, 101)
        assert.equal(saved.final_score, before.final_score)
        assert.deepEqual(saved.growup_train_attr, before.growup_train_attr)
        assert.deepEqual(saved.assist_chars, before.assist_chars)
        assert.deepEqual(saved.skill_tree_data, before.skill_tree_data)
        assert.deepEqual(f.g(), before)
        assert.deepEqual(f.state().player, owned)
        f.game.clock = () => 1800000120
        f.call('ArchiveGrowupData', request())
        assert.equal(f.state().activities[60001].growupArchive.archive[0].archive_time, '1800000000')
    } finally {
        f.store.close()
    }
})
test('9615 enforces real completion receipt, current start, four slots and table rating threshold rather than making a low result S', () => {
    const f = fixture('growup-archive-gates')
    try {
        f.start()
        assert.throws(
            () => f.call('ArchiveGrowupData', request()),
            (e) => e.code === ErrorCode.ActivityGrowUpInvalidStage,
        )
        f.complete([60, 60, 60, 60])
        assert.throws(
            () => f.call('ArchiveGrowupData', request()),
            (e) => e.code === ErrorCode.ActivityTotalScoreLess,
        )
        assert.equal(f.state().activities[60001].growupArchive, undefined)
        f.complete()
        assert.throws(
            () => f.call('ArchiveGrowupData', request(0)),
            (e) => e.code === ErrorCode.ActivityArchiveParamError,
        )
        assert.throws(
            () => f.call('ArchiveGrowupData', request(5)),
            (e) => e.code === ErrorCode.ActivityArchiveParamError,
        )
        assert.throws(
            () => f.call('ArchiveGrowupData', { ...request(), starting_id: 102 }),
            (e) => e.code === ErrorCode.ActivityStartingNotEqual,
        )
        f.store.transact(f.session.id, 0, (s) => {
            delete s.acceptedCultTrials[f.g().guid + ':301']
        })
        assert.throws(
            () => f.call('ArchiveGrowupData', request()),
            (e) => e.code === ErrorCode.CultEndNotComplete,
        )
    } finally {
        f.store.close()
    }
})
test('9615 overwrites the explicitly selected slot using a lower current valid result rather than the merged best ending book', () => {
    const f = fixture('growup-archive-overwrite')
    try {
        f.start()
        f.complete()
        f.call('ArchiveGrowupData', request())
        const first = f.state().activities[60001].growupArchive.archive[0]
        f.call('ActivityGrowUpResetReq', { activity_id: 60001 })
        assert.equal(f.g().cur_starting_id, 0)
        f.start()
        f.complete([975, 975, 975, 975])
        assert.equal(f.g().end_data.complete_end[0].top_rating, first.final_score)
        assert(Number(f.g().final_score) < Number(first.final_score))
        f.call('ArchiveGrowupData', request())
        const second = f.state().activities[60001].growupArchive.archive[0]
        assert.notEqual(second.guid, first.guid)
        assert.equal(second.final_score, f.g().final_score)
        assert.deepEqual(second.growup_train_attr, f.g().growup_train_attr)
        assert.equal(f.state().activities[60001].growupArchive.archive.length, 1)
    } finally {
        f.store.close()
    }
})
test('9615 rejects an inconsistent stored score and rolls archive changes back if 9616 encoding fails', () => {
    const f = fixture('growup-archive-rollback')
    try {
        f.start()
        f.complete()
        const before = f.state(),
            encode = f.protocol.encode.bind(f.protocol)
        f.protocol.encode = (type, value) => {
            if (type === 'cs.SyncArchiveGrowupData' && value.data?.some((x) => x.archive?.length))
                throw Error('archive codec')
            return encode(type, value)
        }
        assert.throws(() => f.call('ArchiveGrowupData', request()), /archive codec/)
        f.protocol.encode = encode
        assert.deepEqual(f.state(), before)
        f.store.transact(f.session.id, 0, (s) => {
            s.activities[60001].growup.final_score = '999999'
        })
        assert.throws(
            () => f.call('ArchiveGrowupData', request()),
            (e) => e.code === ErrorCode.GameConfig,
        )
    } finally {
        f.store.close()
    }
})
test('archives survive normal reset and SQLite restart; login initializes activity before archive data', () => {
    const parent = path.resolve(os.tmpdir()),
        temp = fs.mkdtempSync(path.join(parent, 'growup-archive-persist-')),
        file = path.join(temp, 'state.sqlite')
    let f = fixture('growup-archive-persist', file)
    try {
        f.start()
        f.complete()
        f.call('ArchiveGrowupData', request(4))
        const saved = structuredClone(f.state().activities[60001].growupArchive.archive[0])
        f.call('ActivityGrowUpResetReq', { activity_id: 60001 })
        f.store.close()
        f = fixture('growup-archive-persist', file)
        const ids = f.login.map((p) => p.id),
            activityId = f.protocol.byName.get('CSProtoActivitySync').id
        assert(ids.indexOf(activityId) >= 0 && ids.indexOf(9616) > ids.indexOf(activityId))
        const data = f.decode(f.login, 'CSProtoSyncArchiveGrowupData').data.find((x) => x.activity_id === 60001)
        assert.deepEqual(data.archive[0], saved)
        assert.equal(f.g().cur_starting_id, 0)
    } finally {
        f.store.close()
        const resolved = path.resolve(temp)
        if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('growup-archive-persist-'))
            throw Error('Unexpected archive temporary cleanup target')
        fs.rmSync(resolved, { recursive: true, force: true })
    }
})
