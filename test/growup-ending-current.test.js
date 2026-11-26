import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { GrowupSystem } from '../src/growup.js'
import { growupEndingTrial, growupEndingMatchesTrial } from '../src/growup-ending.js'
import { commitPermanentEnding, preparePermanent, permanentModel } from '../src/growup-permanent.js'
import { ErrorCode } from '../src/error-codes.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables)

test('all current ending rows resolve difficulty dictionary keys and exact final trial references', () => {
    const endings = tables.get('game_events_cul_end')
    assert.equal(endings.length, 10)
    let bindings = 0
    for (const ending of endings) {
        for (const tuple of ending.trial.split('|')) {
            const [difficulty, trialId] = tuple.split('#').map(Number)
            const trial = growupEndingTrial(tables, ending, difficulty)
            assert.equal(trial.trialId, trialId)
            assert.equal(trial.systemId, ending.systemId)
            assert.equal(trial.phase, 3)
            assert.equal(trial.difficult, difficulty)
            assert(growupEndingMatchesTrial(tables, ending, trial, difficulty))
            assert.equal(growupEndingMatchesTrial(tables, ending, trial, difficulty === 0 ? 1 : 0), false)
            bindings++
        }
    }
    assert.equal(bindings, 15)
    const normalOnly = endings.find((row) => row.systemId === 60001 && row.endingId === 101)
    assert.equal(growupEndingTrial(tables, normalOnly, 1), undefined)
    const paired = endings.find((row) => row.systemId === 60002 && row.endingId === 201)
    assert.equal(growupEndingTrial(tables, paired, 0).trialId, 311)
    assert.equal(growupEndingTrial(tables, paired, 1).trialId, 321)
    assert.throws(
        () => permanentModel(new GrowupSystem(tables), 60002),
        (error) => error.code === ErrorCode.FunctionClosed,
    )
})

test('malformed or numeric current raw mappings reject strictly without old-table or last-value fallback', () => {
    const ending = tables.get('game_events_cul_end').find((row) => row.systemId === 60001 && row.endingId === 101)
    for (const trial of [
        301,
        '301',
        '',
        '0#301|',
        '#301',
        '0#0',
        '0#301|0#301',
        '1#301',
        '0#101',
        '0#302',
        '0#311',
        '0#999999',
        '0#301|1#999999',
        '-1#301',
        '9007199254740992#301',
    ])
        assert.throws(
            () => growupEndingTrial(tables, { ...ending, trial }, 0),
            (error) => error.code === ErrorCode.GameConfig,
        )
    for (const difficulty of [-1, '0', 0.1, NaN])
        assert.throws(
            () => growupEndingTrial(tables, ending, difficulty),
            (error) => error.code === ErrorCode.GameConfig,
        )
})

function fixture(account, file) {
    const protocol = new Protocol(cfg.base),
        store = new Store(file),
        session = {}
    const game = new Game(protocol, store, tables, { clock: () => 1800000000, rng: () => 0 })
    let seq = 1
    const call = (name, value = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, value) })
    }
    call('EnterGame', { open_id: account })
    store.transact(session.id, 0, (state) => {
        // Trusted qualification baseline, not a claim that this fixture played the guide or training cycle.
        state.taskRecords = tables.get('task').map((row) => ({ task_id: row.id, count: 1 }))
        state.tasks = []
    })
    const state = () => store.load(session.id).state
    const system = game.activities.growup,
        catalog = game.activities
    const row = catalog.rows.find((value) => value.id === 60001)
    const start = () =>
        call('ActivityGrowUpStartSelectReq', { activity_id: 60001, starting_id: 101, select_assist_char_ids: [] })
    const reset = () => {
        call('ActivityGrowUpResetReq', { activity_id: 60001 })
        start()
    }
    const training = (finalId) =>
        store.transact(session.id, 0, (s) => {
            const g = s.activities[60001].growup
            g.growup_train_attr.forEach((attr) => {
                attr.attr_value = 1000
            })
            Object.assign(g, {
                cur_stage: 3,
                cur_growup_stage: 13,
                cur_growup_trail_stage: 3,
                select_trail_id: finalId,
            })
            g.trails = [101, 201, finalId].map((trail_id) => ({ trail_id, star: 3, score: '6000', guid: g.guid }))
            s.acceptedCultTrials ??= {}
            for (const result of g.trails) s.acceptedCultTrials[`${g.guid}:${result.trail_id}`] = true
        })
    const complete = (finalId, options = {}) =>
        store.transact(session.id, 0, (s) => {
            const entry = s.activities[60001],
                g = entry.growup
            const trial = tables
                .get('game_events_cul_trial')
                .find((value) => value.systemId === 60001 && value.trialId === finalId)
            const snapshot = system.finish(g, 60001, trial)
            options.capture?.(snapshot)
            const proof = system.endingCompletionProof(snapshot, g)
            assert(proof)
            assert.equal(system.endingCompletionProof(structuredClone(snapshot), g), undefined)
            assert.equal(system.endingCompletionProof(snapshot, structuredClone(g)), undefined)
            const value = snapshot.top_rating
            snapshot.top_rating = '0'
            assert.equal(system.endingCompletionProof(snapshot, g), undefined)
            snapshot.top_rating = value
            const context = {
                id: session.id,
                state: s,
                now: 1800000000,
                pushBefore(name, data) {
                    const type = protocol.byName.get(name).rsp
                    if (options.failPublication) throw Error('ending publication codec failure')
                    protocol.encode(type, data)
                },
            }
            for (const unproven of [structuredClone(snapshot), { ...structuredClone(snapshot), completed: true }])
                assert.throws(
                    () => commitPermanentEnding(context, catalog, row, entry, unproven, 'trial-completion'),
                    (error) => error.code === ErrorCode.GameConfig,
                )
            snapshot.top_rating = '0'
            assert.throws(
                () => commitPermanentEnding(context, catalog, row, entry, snapshot, 'trial-completion'),
                (error) => error.code === ErrorCode.GameConfig,
            )
            snapshot.top_rating = value
            if (options.stale) {
                assert.equal(system.endingCompletionProof(options.stale, g), undefined)
                assert.throws(
                    () => commitPermanentEnding(context, catalog, row, entry, options.stale, 'trial-completion'),
                    (error) => error.code === ErrorCode.GameConfig,
                )
            }
            commitPermanentEnding(context, catalog, row, entry, snapshot, 'trial-completion')
            return { snapshot, proof }
        })
    start()
    return {
        game,
        protocol,
        store,
        session,
        system,
        catalog,
        row,
        state,
        call,
        start,
        reset,
        training,
        complete,
        hash: () =>
            createHash('sha256')
                .update(JSON.stringify(store.load(session.id)))
                .digest('hex'),
    }
}

test('actual60001 five-ending producer preserves count gates, completion provenance, rollback and numeric history', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-growup-ending-'))
    const file = path.join(directory, 'state.sqlite')
    const f = fixture('growup-ending-current', file)
    try {
        // Attribute gate passes but no completed ending yet:102 must not self-unlock at first completion.
        f.training(302)
        const first = f.hash()
        assert.throws(
            () => f.complete(302),
            (error) => error.code === ErrorCode.CultEndNotComplete,
        )
        assert.equal(f.hash(), first)
        f.training(301)
        f.complete(301)
        for (let ending = 102; ending <= 105; ending++) {
            f.reset()
            const finalId = 200 + ending
            f.training(finalId)
            if (ending === 102) {
                let failed
                const before = f.hash()
                assert.throws(
                    () =>
                        f.complete(finalId, {
                            failPublication: true,
                            capture: (snapshot) => {
                                failed = snapshot
                            },
                        }),
                    /codec failure/,
                )
                assert.equal(f.hash(), before)
                f.store.db.exec(
                    "CREATE TRIGGER ending_abort BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'ending-sql-abort'); END",
                )
                try {
                    assert.throws(() => f.complete(finalId), /ending-sql-abort/)
                } finally {
                    f.store.db.exec('DROP TRIGGER ending_abort')
                }
                assert.equal(f.hash(), before)
                f.complete(finalId, { stale: failed })
            } else f.complete(finalId)
        }
        let entry = f.state().activities[60001]
        assert.deepEqual(
            entry.growup.end_data.complete_end.map((record) => record.id),
            [101, 102, 103, 104, 105],
        )
        assert.equal(Object.keys(entry.growupPermanent.endings).length, 5)
        // The pre-existing dictionary includes the selected ID on a repeat; never drop it from80003 count.
        for (const finalId of [302, 305]) {
            f.reset()
            f.training(finalId)
            const { proof } = f.complete(finalId)
            assert(proof.completedBefore.includes(finalId - 200))
        }
        entry = f.state().activities[60001]
        assert.equal(entry.growup.end_data.complete_end.length, 5)
        assert.equal(Object.keys(entry.growupPermanent.endings).length, 7)
        const legacy = structuredClone(entry),
            records = JSON.stringify(legacy.growup.end_data.complete_end)
        delete legacy.growupPermanent
        const migrated = preparePermanent(f.system, legacy, 60001, f.session.id, 1800000000)
        assert(migrated.unlocked.includes(100))
        assert.equal(migrated.migration.skipped.length, 4)
        assert.equal(JSON.stringify(legacy.growup.end_data.complete_end), records)
        const selfOnly = {
            growup: {
                end_data: {
                    complete_end: [
                        structuredClone(entry.growup.end_data.complete_end.find((record) => record.id === 102)),
                    ],
                },
            },
        }
        const kept = JSON.stringify(selfOnly.growup.end_data)
        assert.equal(
            Object.keys(preparePermanent(f.system, selfOnly, 60001, f.session.id, 1800000000).endings).length,
            0,
        )
        assert.equal(JSON.stringify(selfOnly.growup.end_data), kept)
        // Actual archive request still requires its existing accepted-trial receipts and complete ending.
        const request = { activity_id: 60001, starting_id: 101, archive_id: 1 }
        const beforeArchive = f.hash(),
            encode = f.protocol.encode
        const archiveType = f.protocol.byName.get('CSProtoSyncArchiveGrowupData').rsp
        f.protocol.encode = function (name, ...args) {
            if (name === archiveType) throw Error('archive codec failure')
            return encode.call(this, name, ...args)
        }
        try {
            assert.throws(() => f.call('ArchiveGrowupData', request), /codec failure/)
        } finally {
            f.protocol.encode = encode
        }
        assert.equal(f.hash(), beforeArchive)
        const archived = f.call('ArchiveGrowupData', request)
        const data = f.protocol.decode(archiveType, archived.find((packet) => packet.id === 9616).payload)
        assert.equal(data.data[0].archive[0].ending_id, 105)
        assert.equal(f.state().activities[60001].growup.end_data.complete_end.length, 5)
        const saved = structuredClone(f.state().activities[60001])
        f.store.close()
        const reopened = new Store(file),
            protocol = new Protocol(cfg.base),
            who = {}
        try {
            const game = new Game(protocol, reopened, tables, { clock: () => 1800000000, rng: () => 0 })
            const enter = protocol.byName.get('CSProtoEnterGame')
            game.dispatch(who, {
                id: enter.id,
                seq: 1,
                payload: protocol.encode(enter.req, { open_id: 'growup-ending-current', reconnect: true }),
            })
            const restored = reopened.load(who.id).state.activities[60001]
            assert.deepEqual(restored.growup.end_data, saved.growup.end_data)
            assert.deepEqual(restored.growup.trails, saved.growup.trails)
            assert.deepEqual(restored.growupPermanent, saved.growupPermanent)
            assert.deepEqual(restored.growupArchive, saved.growupArchive)
        } finally {
            reopened.close()
        }
    } finally {
        if (f.store.db.open) f.store.close()
        assert(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep + 'lurukaps-growup-ending-'))
        for (const name of fs.readdirSync(directory)) {
            assert(['state.sqlite', 'state.sqlite-journal'].includes(name))
            fs.unlinkSync(path.join(directory, name))
        }
        fs.rmdirSync(directory)
    }
})

test('runtime difficulty mismatch rejects before changing a completed record or its historical IDs', () => {
    const system = new GrowupSystem(tables),
        g = system.fresh(60001)
    g.cur_starting_difficult_lv = 1
    const before = structuredClone(g)
    const trial = tables.get('game_events_cul_trial').find((row) => row.systemId === 60001 && row.trialId === 301)
    assert.throws(
        () => system.finish(g, 60001, trial),
        (error) => error.code === ErrorCode.CultInvalidEndId,
    )
    assert.deepEqual(g, before)
    g.cur_starting_difficult_lv = 0
    g.cur_starting_id = 101
    g.trails = [111, 201, 301].map((trail_id) => ({ trail_id, star: 3, score: '6000', guid: '4294967297' }))
    const mixed = structuredClone(g)
    assert.throws(
        () => system.finish(g, 60001, trial),
        (error) => error.code === ErrorCode.InvalidArgument,
    )
    assert.deepEqual(g, mixed)
})
