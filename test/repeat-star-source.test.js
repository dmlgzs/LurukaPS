import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { ErrorCode } from '../src/error-codes.js'
import { repeatEventTables, recordRepeatVictory, repeatSnapshot } from '../src/repeat-event.js'
import { repeatStarTrustedCount, repeatStarWireRecord, sealRepeatStarProgress } from '../src/repeat-star-progress.js'

const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tables = new Tables(process.env.LURUKAPS_TABLES)
const current = repeatEventTables(tables)
const protocol = new Protocol(base)
const mode = (state) => state.repeatEvent.levels['10001:10101'].mode_save_data[0]
const run = (overrides = {}) => ({
    kind: 'repeat',
    entrust_id: 32290,
    dungeon_id: 32290,
    instance_id: 1,
    battle_complete: true,
    repeat_event: { activity: 10001, chapter: 101, level: 10101, mode: 1 },
    battle_start_time: 100,
    end_time: 110,
    hero_deaths: 0,
    ...overrides,
})
const state = (id) => ({ player: { basic_info: { id } }, activities: { 10001: { claims: [100010101] } } })

test('source functions preserve ambiguous legacy2/3, claims and unknown versions; replay creates no typed stars', () => {
    const warnings = []
    const oldWarn = console.warn
    console.warn = (...args) => warnings.push(args)
    try {
        for (const value of [2, 3]) {
            const saved = state(92000 + value)
            saved.repeatEvent = {
                levels: {
                    '10001:10101': {
                        event_id: 10001,
                        level_id: 10101,
                        mode_save_data: [{ mode: 1, star_count: value, win_count: 8 }],
                    },
                },
            }
            recordRepeatVictory(tables, saved, run())
            assert.equal(mode(saved).star_count, value)
            assert.equal(mode(saved).star_progress, undefined)
            const a = repeatSnapshot(saved)
            repeatSnapshot(saved)
            assert.equal(a.finished_level_data[0].mode_save_data[0].star_count, value)
            assert.equal(repeatStarTrustedCount(mode(saved)), null)
            assert.deepEqual(saved.activities[10001].claims, [100010101])
        }
        assert.equal(warnings.length, 2)
        const unknown = { mode: 1, star_count: 3, star_progress: { version: 2, original: 'untouched' } }
        const snapshot = structuredClone(unknown)
        assert.deepEqual(repeatStarWireRecord(state(92005), 10001, 10101, unknown), { mode: 1, star_count: 3 })
        assert.deepEqual(unknown, snapshot)
    } finally {
        console.warn = oldWarn
    }
})

test('actual producer function selects a highest single-run mask and protobuf projects it without OR or legacy backfill', () => {
    const saved = state(92010)
    const first = run({ end_time: 400 })
    recordRepeatVictory(tables, saved, first, { freshRepeatVictory: true })
    assert.equal(first.star_mask, 3)
    assert.deepEqual(mode(saved).star_progress, { version: 1, best_count: 2, best_mask: 3 })
    const second = run({ hero_deaths: 1 })
    recordRepeatVictory(tables, saved, second, { freshRepeatVictory: true })
    assert.equal(second.star_mask, 5)
    assert.deepEqual(mode(saved).star_progress, { version: 1, best_count: 2, best_mask: 5 })
    assert.notEqual(mode(saved).star_progress.best_mask, 7)
    recordRepeatVictory(tables, saved, run(), { freshRepeatVictory: true })
    recordRepeatVictory(tables, saved, run({ end_time: 400, hero_deaths: 1 }), { freshRepeatVictory: true })
    assert.deepEqual(mode(saved).star_progress, { version: 1, best_count: 3, best_mask: 7 })
    const projected = repeatSnapshot(saved).finished_level_data[0].mode_save_data[0]
    const decoded = protocol.decode(
        'cs.RepeatEventLevelFinishedModeSavedData',
        protocol.encode('cs.RepeatEventLevelFinishedModeSavedData', projected),
    )
    assert.equal(decoded.star_count, 7)
    assert.equal(decoded.win_count, 4)
    assert.equal(mode(saved).star_count, 3)
    assert.equal(repeatStarTrustedCount(mode(saved)), 3)
    assert.deepEqual(saved.activities[10001].claims, [100010101])
})

test('versioned source integrity, event ownership and future multi-mode policy stay closed with named errors', () => {
    const saved = state(92020)
    const completed = run({ star: 3, star_mask: 7 })
    assert.throws(
        () => repeatStarTrustedCount({ star_progress: { version: 1, best_count: 3, best_mask: 3 } }),
        (error) => error.code === ErrorCode.GameConfig,
    )
    assert.throws(
        () =>
            sealRepeatStarProgress(
                current,
                saved,
                { ...completed, repeat_event: { ...completed.repeat_event, activity: 999 } },
                undefined,
                true,
            ),
        (error) => error.code === ErrorCode.GameConfig,
    )
    assert.throws(
        () => sealRepeatStarProgress(current, saved, { ...completed, star: 2 }, undefined, true),
        (error) => error.code === ErrorCode.GameConfig,
    )
    const future = {
        get: (name) => current.get(name),
        find: (name, id) =>
            name === 'repeat_event_level'
                ? { ...current.find(name, id), isHardOpen: 1, hardDungeonId: 32291 }
                : current.find(name, id),
    }
    assert.equal(sealRepeatStarProgress(future, saved, completed, undefined, true), undefined)
    assert.equal(sealRepeatStarProgress(current, saved, completed, undefined, false), undefined)
    const previous = { star_count: 3, star_progress: { version: 4, proof: 'preserve' } }
    assert.deepEqual(sealRepeatStarProgress(current, saved, completed, previous, true), previous.star_progress)
})

test('typed source transactions survive SQLite reopen and roll back codec or SQL faults without account leakage', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'repeat-star-source-'))
    const filename = path.join(directory, 'probe.sqlite')
    let store = new Store(filename)
    try {
        const first = store.login('repeat-star-a', (id) => state(id))
        const second = store.login('repeat-star-b', (id) => state(id))
        const before = store.load(first.id)
        assert.throws(
            () =>
                store.transact(first.id, 10705, (draft) => {
                    recordRepeatVictory(tables, draft, run(), { freshRepeatVictory: true })
                    throw Error('codec-injection')
                }),
            /codec-injection/,
        )
        assert.deepEqual(store.load(first.id), before)
        const originalSave = store.savePlayer
        store.savePlayer = {
            run: () => {
                throw Error('sql-injection')
            },
        }
        assert.throws(
            () =>
                store.transact(first.id, 10705, (draft) =>
                    recordRepeatVictory(tables, draft, run(), { freshRepeatVictory: true }),
                ),
            /sql-injection/,
        )
        store.savePlayer = originalSave
        assert.deepEqual(store.load(first.id), before)
        store.transact(first.id, 10705, (draft) =>
            recordRepeatVictory(tables, draft, run(), { freshRepeatVictory: true }),
        )
        assert.equal(store.load(second.id).state.repeatEvent, undefined)
        store.close()
        store = new Store(filename)
        assert.equal(repeatStarTrustedCount(mode(store.load(first.id).state)), 3)
        assert.equal(repeatSnapshot(store.load(first.id).state).finished_level_data[0].mode_save_data[0].star_count, 7)
        assert.deepEqual(store.load(first.id).state.activities[10001].claims, [100010101])
    } finally {
        store.close()
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()))
        assert(path.basename(directory).startsWith('repeat-star-source-'))
        fs.rmSync(directory, { recursive: true, force: true })
    }
})
