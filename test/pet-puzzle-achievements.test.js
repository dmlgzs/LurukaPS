import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { puzzleFixture, puzzleProtocol, puzzleTables } from './pet-puzzle-progress-fixture.js'
import { achievementCatalogue, observeAchievements } from '../src/achievements.js'
import { petPuzzleProgressValue } from '../src/pet-puzzle-progress.js'
import { ErrorCode } from '../src/error-codes.js'
const ids = [3020010, 3020011, 3020012]
const count = (f) => petPuzzleProgressValue(puzzleTables, f.state(), [12048, 0, 0, 100])
const decode = (packets) => packets.find((packet) => packet.id === 9902).data
function firstWorlds(f, n) {
    const entries = f.worldEntries()
    assert.ok(entries.length >= n)
    for (const entry of entries.slice(0, n)) f.finishWorld(entry)
    return entries
}

test('complete12048 family reaches20/50/100 through99 real world roots plus one real playable and claims all three once', () => {
    const f = puzzleFixture('puzzle-achievement-all')
    try {
        const model = achievementCatalogue(puzzleTables)
        assert.deepEqual(
            model.rows
                .filter((r) => model.rules.get(r.id).tokens?.[0] === 12048)
                .map((r) => [r.id, r.param, model.rules.get(r.id).supported]),
            [
                [3020010, 20, true],
                [3020011, 50, true],
                [3020012, 100, true],
            ],
        )
        const entries = firstWorlds(f, 19)
        assert.equal(count(f), 19)
        f.edit((s) => {
            s.world.map_id = 610
        })
        f.call('PlayableStart', { u32: 10011 })
        f.call('PlayableStep', { playId: 10011, is_step: true, finish_step: 1 })
        f.call('PlayableFinish', { playId: 10011, ext_context: f.context(1) })
        assert.equal(count(f), 20)
        // Current three rows grant achievement points rather than row items.
        assert.deepEqual(decode(f.call('AchievementReward', { u32: ids[0] })).rewards, [])
        for (let index = 19; index < 99; index++) {
            f.finishWorld(entries[index])
            if (count(f) === 50) assert.deepEqual(decode(f.call('AchievementReward', { u32: ids[1] })).rewards, [])
        }
        assert.equal(count(f), 100)
        assert.deepEqual(decode(f.call('AchievementReward', { u32: ids[2] })).rewards, [])
        const facts = f.state().petPuzzleProgress
        assert.equal(Object.values(facts.facts).filter((fact) => fact.kind === 'world').length, 99)
        assert.equal(Object.values(facts.facts).filter((fact) => fact.kind === 'playable').length, 1)
        for (const id of ids) {
            assert.equal(f.state().achievements.entries[id].claimed, true)
            assert.deepEqual(decode(f.call('AchievementReward', { u32: id })).rewards, [])
        }
        assert.deepEqual(f.state().petPuzzleProgress, facts)
        console.log('[pet-puzzle-test] actual-world-completions=99 actual-playable-completions=1 thresholds=20,50,100')
    } finally {
        f.close()
    }
})

test('unfinished imported values cannot invent puzzle history; valid old terminal receipts remain monotone and malformed terminal data rejects', () => {
    const f = puzzleFixture('puzzle-achievement-legacy')
    try {
        const state = f.state()
        for (const id of ids)
            state.achievements.entries[id] = {
                value: achievementCatalogue(puzzleTables).byId.get(id).param,
                finishTime: 0,
                claimed: false,
            }
        observeAchievements(puzzleTables, state, 1800000000)
        assert.ok(
            ids.every(
                (id) => state.achievements.entries[id].value === 0 && state.achievements.entries[id].finishTime === 0,
            ),
        )
        assert.equal(state.petPuzzleProgress, undefined)
        state.achievements.entries[ids[0]] = { value: 20, finishTime: 1, claimed: true }
        observeAchievements(puzzleTables, state, 1800000000)
        assert.deepEqual(state.achievements.entries[ids[0]], { value: 20, finishTime: 1, claimed: true })
        state.achievements.entries[ids[0]].value = 19
        assert.throws(
            () => observeAchievements(puzzleTables, state, 1800000000),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.throws(
            () => f.call('AchievementReward', { u32: ids[0] }),
            (e) => e.code === ErrorCode.AchievementIsRunning,
        )
    } finally {
        f.close()
    }
})

test('the20th real source sync,9902 ACK and SQLite claim failures roll facts/rewards/receipts back, then each succeeds once', () => {
    const f = puzzleFixture('puzzle-achievement-atomic'),
        encode = puzzleProtocol.encode
    try {
        const entries = firstWorlds(f, 19),
            next = entries[19]
        f.near(next)
        let before = f.state()
        puzzleProtocol.encode = function (type, data) {
            if (type === puzzleProtocol.byName.get('CSProtoAchievementSync').rsp) throw Error('puzzle-ach-sync')
            return encode.call(this, type, data)
        }
        assert.throws(() => f.call('WorldObjInteract', { objs: [f.request(next)] }), /puzzle-ach-sync/)
        assert.deepEqual(f.state(), before)
        puzzleProtocol.encode = encode
        f.call('WorldObjInteract', { objs: [f.request(next)] })
        assert.equal(count(f), 20)
        // Legitimate source can finish an equal full but nonterminal imported
        // scalar; this is receipt compatibility, not invented source history.
        f.edit((s) => {
            s.achievements.entries[ids[0]] = { value: 20, finishTime: 0, claimed: false }
        })
        before = f.state()
        puzzleProtocol.encode = function (type, data) {
            if (type === puzzleProtocol.byId.get(9902).rsp) throw Error('puzzle-ach-ACK')
            return encode.call(this, type, data)
        }
        assert.throws(() => f.call('AchievementReward', { u32: ids[0] }), /puzzle-ach-ACK/)
        assert.deepEqual(f.state(), before)
        puzzleProtocol.encode = encode
        f.store.db.exec(
            "CREATE TRIGGER reject_puzzle_achievement BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT, 'puzzle-ach-SQL'); END",
        )
        assert.throws(() => f.call('AchievementReward', { u32: ids[0] }), /puzzle-ach-SQL/)
        assert.deepEqual(f.state(), before)
        f.store.db.exec('DROP TRIGGER reject_puzzle_achievement')
        f.call('AchievementReward', { u32: ids[0] })
        assert.equal(f.state().achievements.entries[ids[0]].claimed, true)
        assert.deepEqual(decode(f.call('AchievementReward', { u32: ids[0] })).rewards, [])
    } finally {
        puzzleProtocol.encode = encode
        f.close()
    }
})

test('real puzzle facts survive SQLite reopen and no account or old completion inventory backfills another ledger', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-puzzle-progress-')),
        file = path.join(dir, 'test.sqlite')
    let f
    try {
        f = puzzleFixture('puzzle-file-a', file)
        const entry = f.worldEntries()[0]
        f.finishWorld(entry)
        const ledger = f.state().petPuzzleProgress
        f.close()
        f = puzzleFixture('puzzle-file-a', file, false)
        assert.deepEqual(f.state().petPuzzleProgress, ledger)
        f.finishWorld(entry)
        assert.deepEqual(f.state().petPuzzleProgress, ledger)
        const other = {}
        f.call('EnterGame', { open_id: 'puzzle-file-b' }, other)
        assert.equal(f.store.load(other.id).state.petPuzzleProgress, undefined)
        const noHistory = f.state()
        delete noHistory.petPuzzleProgress
        assert.equal(petPuzzleProgressValue(puzzleTables, noHistory, [12048, 0, 0, 100]), 0)
        assert.ok(noHistory.worldObjects[`${entry.map}:${entry.id}`].complete)
    } finally {
        f?.close()
        const resolved = path.resolve(dir)
        assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()))
        assert.ok(path.basename(resolved).startsWith('pet-puzzle-progress-'))
        fs.rmSync(resolved, { recursive: true, force: true })
    }
})
