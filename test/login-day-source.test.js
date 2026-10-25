import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loginDayFixture } from './login-day-fixture.js'
import { loginDayFacts, loginDayProgressValue, recordLoginDay } from '../src/login-day-progress.js'
import { achievementCatalogue } from '../src/achievements.js'
import { ErrorCode } from '../src/error-codes.js'
const facts = (f) => loginDayFacts(f.tables, f.state())
test('only actual5001 main entry records one canonical accepted-request day; auth,internal5009,ordinary,tick and same-day reconnect do not create more', () => {
    const f = loginDayFixture('login-source-entry')
    try {
        assert.equal(f.state().loginDayProgress, undefined)
        assert(
            [0, 6].includes(
                achievementCatalogue(f.tables).rows.filter(
                    (r) =>
                        [15048, 20003].includes(Number(r.finishCondition.split('#')[0])) &&
                        achievementCatalogue(f.tables).rules.get(r.id).supported,
                ).length,
            ),
        )
        f.enter('RenterGame')
        assert.equal(f.state().loginDayProgress, undefined)
        f.enter()
        assert.equal(facts(f).totalDays, 1)
        f.enter('EnterGame', { reconnect: true })
        assert.equal(facts(f).totalDays, 1)
        const before = facts(f)
        f.time(f.now() + 86400)
        f.call('Ping')
        f.game.tick(f.id)
        f.call('ActivityGet')
        assert.deepEqual(facts(f), before)
        f.enter('RenterGame')
        assert.deepEqual(facts(f), before)
        f.enter('EnterGame', { reconnect: true })
        assert.equal(facts(f).totalDays, 2)
        assert.equal(facts(f).streakDays, 2)
        assert.throws(() => f.call('EnterGame', { open_id: 'login-source-entry' }))
        assert.equal(facts(f).totalDays, 2)
    } finally {
        f.close()
    }
})
test('four-o-clock boundary uses captured entry time;365 real entry days produce365 and a gap starts only current streak over', () => {
    const boundary = Math.floor(1800000000 / 86400) * 86400 - 4 * 3600
    const f = loginDayFixture('login-source365', ':memory:', boundary - 1)
    try {
        f.enter()
        const first = facts(f).firstDay
        f.time(boundary)
        f.enter()
        assert.equal(facts(f).streakDays, 2)
        for (let day = 2; day < 365; day++) {
            f.time(boundary + (day - 1) * 86400)
            f.enter('EnterGame', { reconnect: day % 2 === 0 })
            assert.equal(facts(f).totalDays, day + 1)
        }
        assert.equal(facts(f).longestStreak, 365)
        assert.equal(facts(f).lastDay - first, 364)
        f.time(f.now() + 2 * 86400)
        f.enter()
        assert.equal(facts(f).totalDays, 366)
        assert.equal(facts(f).streakDays, 1)
        assert.equal(facts(f).longestStreak, 365)
        assert.equal(loginDayProgressValue(f.tables, f.state(), [15048, 365]), 365)
        assert.equal(loginDayProgressValue(f.tables, f.state(), [20003, 365]), 365)
    } finally {
        f.close()
    }
})
test('old age,limited calendars and claims never become lifetime dates; missing history starts at one and damaged facts fail without repair', () => {
    const f = loginDayFixture('login-source-old')
    try {
        f.edit((s) => {
            s.createdAt = 1
            s.dailyActive = {}
            s.mall ??= {}
            s.mall.novicePack = { loginDays: [1, 2, 3] }
            s.monthlyCard = { claim_until: 1900000000 }
        })
        // Isolate unrelated malformed entitlements from the source reader: these
        // fields are not consulted by loginDayFacts and cannot become its dates.
        const old = f.state()
        assert.equal(loginDayFacts(f.tables, old).totalDays, 0)
        f.edit((s) => {
            delete s.mall.novicePack
            delete s.monthlyCard
        })
        f.enter()
        assert.equal(facts(f).totalDays, 1)
        for (const bad of [
            null,
            {},
            { ...facts(f), totalDays: null },
            { ...facts(f), revision: 0 },
            { ...facts(f), longestStreak: 2 },
            { ...facts(f), resetHour: -1 },
        ]) {
            f.edit((s) => (s.loginDayProgress = bad))
            const before = f.state()
            assert.throws(
                () => f.enter(),
                (e) => e.code === ErrorCode.GameConfig,
            )
            assert.deepEqual(f.state(), before)
        }
    } finally {
        f.close()
    }
})

test('valid backward clocks and calendar changes pause statistics without refusing entry; invalid config and account facts remain strict', () => {
    const f = loginDayFixture('login-source-clock-policy'),
        messages = [],
        warn = console.warn
    console.warn = (...args) => {
        if (args[0] === '[login-day-progress]') messages.push(args)
        else warn(...args)
    }
    try {
        f.enter()
        const saved = facts(f),
            time = f.now()
        f.time(time - 86400)
        f.enter()
        f.enter()
        assert.deepEqual(facts(f), saved)
        assert.equal(messages.length, 1)
        f.time(time)
        f.enter()
        f.time(time - 86400)
        f.enter()
        assert.equal(messages.length, 2)
        const changed = {
            get: (name) =>
                name === 'game'
                    ? f.tables
                          .get(name)
                          .map((row) => (row.title === 'DAILY_REFRESH_TIME' ? { ...row, value: '5' } : row))
                    : f.tables.get(name),
        }
        const state = f.state(),
            before = structuredClone(state)
        assert.equal(recordLoginDay(changed, state, time + 86400), false)
        assert.deepEqual(state, before)
        assert.equal(messages.length, 3)
        recordLoginDay(changed, state, time + 86400)
        assert.equal(messages.length, 3)
        for (const value of [null, '', true, ' 4', '24']) {
            const bad = {
                get: (name) =>
                    name === 'game'
                        ? f.tables
                              .get(name)
                              .map((row) => (row.title === 'DAILY_REFRESH_TIME' ? { ...row, value } : row))
                        : f.tables.get(name),
            }
            assert.throws(
                () => recordLoginDay(bad, structuredClone(state), time),
                (e) => e.code === ErrorCode.GameConfig,
            )
        }
    } finally {
        console.warn = warn
        f.close()
    }
})
test('main ACK,login snapshot encoding and real SQLite save failures roll back accepted login days and retry adds exactly one', () => {
    const f = loginDayFixture('login-source-atomic')
    try {
        f.enter()
        f.time(f.now() + 86400)
        for (const name of ['CSProtoEnterGame', 'CSProtoAchievementSync']) {
            const type = f.protocol.byName.get(name).rsp,
                encode = f.protocol.encode.bind(f.protocol),
                before = f.state()
            f.protocol.encode = (current, value) => {
                if (current === type) throw Error('test-login-encode')
                return encode(current, value)
            }
            assert.throws(() => f.enter(), /test-login-encode/)
            assert.deepEqual(f.state(), before)
            f.protocol.encode = encode
        }
        const before = f.state()
        f.store.db.exec(
            "CREATE TEMP TRIGGER reject_login_save BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'test-login-sql'); END",
        )
        assert.throws(() => f.enter(), /test-login-sql/)
        assert.deepEqual(f.state(), before)
        f.store.db.exec('DROP TRIGGER reject_login_save')
        f.enter()
        assert.equal(facts(f).totalDays, 2)
        f.enter()
        assert.equal(facts(f).totalDays, 2)
    } finally {
        f.close()
    }
})
test('durable facts survive reopen,another account remains empty and source readers are pure', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'login-day-source-')),
        file = path.join(dir, 'test.sqlite')
    let f = loginDayFixture('login-source-file', file)
    try {
        f.enter()
        f.time(f.now() + 86400)
        f.enter()
        const saved = f.state(),
            time = f.now()
        const copy = structuredClone(saved)
        loginDayFacts(f.tables, copy)
        assert.deepEqual(copy, saved)
        f.close()
        f = loginDayFixture('login-source-file', file, time)
        assert.equal(facts(f).totalDays, 2)
        f.enter()
        assert.equal(facts(f).totalDays, 2)
        const other = loginDayFixture('login-source-other', file, time)
        try {
            assert.equal(facts(other).totalDays, 0)
            other.enter()
            assert.equal(facts(other).totalDays, 1)
        } finally {
            other.close()
        }
    } finally {
        f.close()
        const target = path.resolve(dir)
        assert.equal(path.dirname(target), path.resolve(os.tmpdir()))
        assert(path.basename(target).startsWith('login-day-source-'))
        fs.rmSync(target, { recursive: true, force: true })
    }
})
