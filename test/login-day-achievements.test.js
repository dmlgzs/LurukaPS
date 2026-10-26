import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loginDayFixture } from './login-day-fixture.js'
import { achievementCatalogue, achievementPoints } from '../src/achievements.js'
import { ErrorCode } from '../src/error-codes.js'
const ids = [4030001, 4030002, 4030003, 4030004, 4030005, 4030006]
const receipts = (f) => f.state().achievements.entries
test('canonical entry acceptance can precede04:00 while its main ACK time is later,without retroactively adding a second day', () => {
    const boundary = Math.floor(1800000000 / 86400) * 86400 - 4 * 3600,
        f = loginDayFixture('login-accepted-clock', ':memory:', boundary - 1)
    try {
        let calls = 0
        f.game.clock = () => (calls++ === 0 ? boundary - 1 : boundary)
        const packets = f.enter(),
            entry = f.protocol.byName.get('CSProtoEnterGame'),
            ack = f.protocol.decode(entry.rsp, packets.find((p) => p.id === entry.id).payload)
        assert.equal(ack.time, boundary)
        assert.equal(f.state().loginDayProgress.lastDay, Math.floor((boundary - 1 + 4 * 3600) / 86400))
        assert.equal(f.state().loginDayProgress.totalDays, 1)
        f.game.clock = () => boundary
        f.enter()
        assert.equal(f.state().loginDayProgress.totalDays, 2)
    } finally {
        f.close()
    }
})
test('all six login conditions use trusted days and nonterminal imported values never become completed; valid old terminals remain without invented dates', () => {
    const f = loginDayFixture('login-achievement-contract')
    try {
        const model = achievementCatalogue(f.tables)
        assert.equal([...model.rules.values()].filter((r) => r.supported).length, 131)
        assert(ids.every((id) => model.rules.get(id).supported))
        assert.equal([...model.rules.values()].filter((r) => r.readingCompound).length, 2)
        f.enter()
        f.edit((s) => {
            delete s.loginDayProgress
            for (const id of ids)
                s.achievements.entries[id] = { value: model.byId.get(id).param, finishTime: 0, claimed: false }
        })
        f.call('ActivityGet')
        assert.equal(f.state().loginDayProgress, undefined)
        for (const id of ids) {
            assert.equal(receipts(f)[id].value, 0)
            assert.equal(receipts(f)[id].finishTime, 0)
        }
        f.edit((s) => (s.achievements.entries[4030001] = { value: 7, finishTime: 1799990000, claimed: true }))
        f.call('ActivityGet')
        assert.equal(receipts(f)[4030001].claimed, true)
        assert.equal(f.state().loginDayProgress, undefined)
        f.edit((s) => (s.achievements.entries[4030004] = { value: 7, finishTime: 0, claimed: true }))
        const before = f.state()
        assert.throws(
            () => f.call('AchievementReward', { u32: 4030004 }),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.close()
    }
})
test('365 actual5001 entry days complete all six thresholds with configured empty rewards and34 points; repeats and a later streak gap are idempotent', () => {
    const f = loginDayFixture('login-achievement365')
    try {
        for (let day = 1; day <= 365; day++) {
            if (day > 1) f.time(f.now() + 86400)
            f.enter('EnterGame', { reconnect: day % 2 === 0 })
            for (const id of ids) {
                const row = achievementCatalogue(f.tables).byId.get(id),
                    saved = receipts(f)[id]
                assert.equal(saved.value, Math.min(day, row.param))
                assert.equal(saved.finishTime > 0, day >= row.param)
            }
        }
        assert.equal(f.state().loginDayProgress.totalDays, 365)
        const actualPoints = ids.reduce((n, id) => n + achievementCatalogue(f.tables).byId.get(id).achPoint, 0)
        assert.equal(actualPoints, 34)
        assert(achievementPoints(f.tables, f.state()) >= actualPoints)
        for (const id of ids) {
            assert.equal(achievementCatalogue(f.tables).byId.get(id).reward, '')
            const entry = f.protocol.byName.get('CSProtoAchievementReward')
            const decode = (packets) => f.protocol.decode(entry.rsp, packets.find((p) => p.id === entry.id).payload)
            assert.deepEqual(decode(f.call('AchievementReward', { u32: id })).rewards, [])
            const once = receipts(f)[id]
            assert.deepEqual(decode(f.call('AchievementReward', { u32: id })).rewards, [])
            assert.deepEqual(receipts(f)[id], once)
        }
        f.time(f.now() + 2 * 86400)
        f.enter()
        assert.equal(f.state().loginDayProgress.streakDays, 1)
        assert.equal(f.state().loginDayProgress.longestStreak, 365)
        assert(ids.every((id) => receipts(f)[id].claimed))
    } finally {
        f.close()
    }
})
test('seventh real entry completion,9902 ACK and SQLite claim failures roll back full state; trusted value can complete a formerly full nonterminal receipt', () => {
    const f = loginDayFixture('login-achievement-atomic')
    try {
        for (let day = 1; day <= 6; day++) {
            if (day > 1) f.time(f.now() + 86400)
            f.enter()
        }
        f.time(f.now() + 86400)
        let before = f.state(),
            encode = f.protocol.encode.bind(f.protocol)
        const sync = f.protocol.byName.get('CSProtoAchievementSync').rsp
        f.protocol.encode = (type, value) => {
            if (type === sync) throw Error('test-login-ach-sync')
            return encode(type, value)
        }
        assert.throws(() => f.enter(), /test-login-ach-sync/)
        assert.deepEqual(f.state(), before)
        f.protocol.encode = encode
        f.enter()
        assert(receipts(f)[4030001].finishTime > 0)
        // This is a nonterminal compatibility receipt,not a source fact. Existing
        // seven real observed days must be able to finish it even at equal value.
        f.edit((s) => (s.achievements.entries[4030004] = { value: 7, finishTime: 0, claimed: false }))
        const ack = f.protocol.byName.get('CSProtoAchievementReward').rsp
        before = f.state()
        f.protocol.encode = (type, value) => {
            if (type === ack) throw Error('test-login-ach-ack')
            return encode(type, value)
        }
        assert.throws(() => f.call('AchievementReward', { u32: 4030004 }), /test-login-ach-ack/)
        assert.deepEqual(f.state(), before)
        f.protocol.encode = encode
        f.store.db.exec(
            "CREATE TEMP TRIGGER reject_login_claim BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'test-login-claim-sql'); END",
        )
        assert.throws(() => f.call('AchievementReward', { u32: 4030004 }), /test-login-claim-sql/)
        assert.deepEqual(f.state(), before)
        f.store.db.exec('DROP TRIGGER reject_login_claim')
        f.call('AchievementReward', { u32: 4030004 })
        assert.equal(receipts(f)[4030004].claimed, true)
        f.call('AchievementReward', { u32: 4030004 })
        assert.equal(receipts(f)[4030004].claimed, true)
    } finally {
        f.close()
    }
})
test('seven real dates and reward receipt survive file reopen; another account does not inherit them', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'login-day-ach-')),
        file = path.join(dir, 'test.sqlite')
    let f = loginDayFixture('login-achievement-file', file)
    try {
        for (let day = 1; day <= 7; day++) {
            if (day > 1) f.time(f.now() + 86400)
            f.enter()
        }
        f.call('AchievementReward', { u32: 4030001 })
        const time = f.now(),
            saved = f.state().loginDayProgress
        f.close()
        f = loginDayFixture('login-achievement-file', file, time)
        f.enter()
        assert.deepEqual(f.state().loginDayProgress, saved)
        assert.equal(receipts(f)[4030001].claimed, true)
        const other = loginDayFixture('login-achievement-file-other', file, time)
        try {
            other.enter()
            assert.equal(other.state().loginDayProgress.totalDays, 1)
            assert.equal(other.state().achievements.entries[4030001].finishTime, 0)
        } finally {
            other.close()
        }
    } finally {
        f.close()
        const target = path.resolve(dir)
        assert.equal(path.dirname(target), path.resolve(os.tmpdir()))
        assert(path.basename(target).startsWith('login-day-ach-'))
        fs.rmSync(target, { recursive: true, force: true })
    }
})
