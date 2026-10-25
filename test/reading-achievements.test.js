import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { readingAchievementFixture } from './reading-achievement-fixture.js'
import { achievementCatalogue, achievementPoints, achievementSnapshot } from '../src/achievements.js'
import { parseAchievementExpression } from '../src/achievement-expression.js'
import {
    readingAchievementRule,
    readingAchievementValue,
    compileReadingConjunction,
} from '../src/reading-achievements.js'
import { ErrorCode } from '../src/error-codes.js'
import { parseRewards } from '../src/rewards.js'

const six = [1040001, 1040002, 3020033, 3020034, 3020035, 3020036]
const branchBooks = (tables) => {
    const series = new Map(tables.get('library_series').map((r) => [r.id, String(r.subId).split('|').map(Number)]))
    return [
        ...new Set(
            tables
                .get('library_branch')
                .flatMap((r) => String(r.seriesId).split('|').map(Number))
                .flatMap((id) => series.get(id)),
        ),
    ].sort((a, b) => a - b)
}

test('full six-target catalogue and bounded AST support only the two proven Boolean AND shapes, leaving eleven compounds closed', () => {
    const f = readingAchievementFixture('reading-ast-contract')
    try {
        const model = achievementCatalogue(f.tables),
            compounds = model.rows.filter((r) => /&&|\|\|/.test(r.finishCondition))
        assert.equal([...model.rules.values()].filter((r) => r.supported).length, 105)
        assert(six.every((id) => model.rules.get(id).supported))
        assert.equal(compounds.length, 13)
        assert.deepEqual(
            compounds.filter((r) => model.rules.get(r.id).supported).map((r) => r.id),
            [3020033, 3020034],
        )
        assert.equal(compounds.filter((r) => !model.rules.get(r.id).supported).length, 11)
        const leaf = '15032#10001#10001',
            other = '15032#10001#10002'
        for (const text of [
            '',
            leaf + ';globalThis.readingInjected=true',
            leaf + '&&',
            '(' + leaf,
            '('.repeat(20) + leaf + ')'.repeat(20),
            '1'.repeat(2049),
            leaf + '&' + other,
        ])
            assert.equal(parseAchievementExpression(text), null)
        for (const text of [
            `(${leaf})||(${other})`,
            `(${leaf})&&(999999#1)`,
            `(${leaf})&&(${leaf})`,
            `(${leaf})&&(13064#0#0#20)`,
            `(${leaf})&&((${other})||(15032#10001#10003))`,
        ])
            assert.equal(compileReadingConjunction(f.tables, parseAchievementExpression(text), 2), null)
        assert.equal(compileReadingConjunction(f.tables, parseAchievementExpression(`(${leaf})&&(${other})`), 3), null)
        assert.equal(
            compileReadingConjunction(
                f.tables,
                { type: 'and', left: { type: 'leaf' }, right: { type: 'leaf', tokens: [15032, 10001, 10002] } },
                2,
            ),
            null,
        )
        assert.equal(globalThis.readingInjected, undefined)
        for (const tokens of [
            [13064, 1, 0, 20],
            [13064, 0, 1, 20],
            [15032, 10013, 10001],
        ])
            assert.equal(readingAchievementRule(f.tables, tokens), false)
        assert.equal(branchBooks(f.tables).length, 57)
    } finally {
        f.store.close()
    }
})

test('actual11026/type28 completes all six using unread owned volumes and ordered leaf vectors; non-UI books stay owned but uncounted', () => {
    const f = readingAchievementFixture('reading-full-family')
    try {
        const model = achievementCatalogue(f.tables),
            ui = branchBooks(f.tables),
            outside = f.tables
                .get('library_readings')
                .map((r) => r.id)
                .filter((id) => !ui.includes(id)),
            pointsBefore = achievementPoints(f.tables, f.state())
        assert.equal(outside.length, 16)
        for (const id of outside) f.acquire(id)
        assert.equal(Object.keys(f.state().readingBooks).length, 16)
        assert.equal(readingAchievementValue(f.tables, f.state(), [13064, 0, 0, 50]), 0)
        assert(six.every((id) => !f.state().achievements.entries[id]?.finishTime))
        let packets = f.acquire(10002)
        assert.deepEqual(f.wire(packets, 3020033).count, [0, 1, 0])
        assert.equal(f.state().achievements.entries[3020033].value, 1)
        packets = f.acquire(10001)
        assert.deepEqual(f.wire(packets, 3020033).count, [1, 1, 0])
        assert.throws(
            () => f.call('AchievementReward', { u32: 3020033 }),
            (e) => e.code === ErrorCode.AchievementIsRunning,
        )
        packets = f.acquire(10003)
        assert.deepEqual(f.wire(packets, 3020033).count, [1, 1, 1])
        assert(Number(f.wire(packets, 3020033).finish_time) > 0)
        packets = f.acquire(20008)
        assert.deepEqual(f.wire(packets, 3020034).count, [0, 0, 1])
        f.acquire(20006)
        packets = f.acquire(20007)
        assert.deepEqual(f.wire(packets, 3020034).count, [1, 1, 1])
        for (const [book, id] of [
            [10015, 1040001],
            [20023, 1040002],
        ]) {
            packets = f.acquire(book)
            assert.deepEqual(f.wire(packets, id).count, [1])
            assert.equal(f.state().readingBooks[book].book_state, 0)
        }
        f.call('ReadHandbookRead', { book_id: [10015] })
        packets = f.acquire(10015)
        assert.equal(f.wire(packets, 1040001), undefined)
        assert.equal(f.state().readingBooks[10015].book_state, 1)
        assert(!packets.some((p) => p.id === 11025))
        for (const id of ui) {
            if (f.state().readingBooks[id]) continue
            f.acquire(id)
            const count = readingAchievementValue(f.tables, f.state(), [13064, 0, 0, 50])
            if (count === 20) assert(f.state().achievements.entries[3020035].finishTime > 0)
            if (count === 50) assert(f.state().achievements.entries[3020036].finishTime > 0)
        }
        assert.equal(Object.keys(f.state().readingBooks).length, 73)
        assert.equal(readingAchievementValue(f.tables, f.state(), [13064, 0, 0, 50]), 57)
        assert.equal(
            achievementPoints(f.tables, f.state()) - pointsBefore,
            six.reduce((n, id) => n + model.byId.get(id).achPoint, 0),
        )
        for (const id of six) {
            assert(f.state().achievements.entries[id].finishTime > 0)
            assert.deepEqual(
                f.reply(f.call('AchievementReward', { u32: id }), 9902).rewards,
                parseRewards(model.byId.get(id).reward),
            )
            assert(f.state().achievements.entries[id].claimed)
            assert.deepEqual(f.reply(f.call('AchievementReward', { u32: id }), 9902).rewards, [])
        }
    } finally {
        f.store.close()
    }
})

test('last real volume, partial leaf vector and9902 reward are atomic across9900/11025/ACK encoding and SQLite save failures', () => {
    const f = readingAchievementFixture('reading-atomic')
    try {
        f.acquire(10001)
        f.acquire(10002)
        for (const name of ['CSProtoAchievementSync', 'CSProtoReadHandbookInfoSync', 11026]) {
            const before = f.state(),
                original = f.game.packet
            let hit = false
            f.game.packet = function (n, value, options) {
                if (n === name) {
                    hit = true
                    throw Error('reading-source-codec')
                }
                return original.call(this, n, value, options)
            }
            assert.throws(() => f.acquire(10003), /reading-source-codec/)
            assert(hit)
            assert.deepEqual(f.state(), before)
            f.game.packet = original
        }
        const beforeSql = f.state()
        f.store.db.exec(
            "CREATE TEMP TRIGGER b169_abort BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'reading-source-save'); END",
        )
        assert.throws(() => f.acquire(10003), /reading-source-save/)
        assert.deepEqual(f.state(), beforeSql)
        f.store.db.exec('DROP TRIGGER b169_abort')
        f.acquire(10003)
        const earned = f.state(),
            original = f.game.packet
        f.game.packet = function (n, value, options) {
            if (n === 9902) throw Error('reading-reward-ACK')
            return original.call(this, n, value, options)
        }
        assert.throws(() => f.call('AchievementReward', { u32: 3020033 }), /reading-reward-ACK/)
        assert.deepEqual(f.state(), earned)
        f.game.packet = original
        f.call('AchievementReward', { u32: 3020033 })
        assert(f.state().achievements.entries[3020033].claimed)
    } finally {
        f.store.close()
    }
})

test('unearned imported scalar/vector cannot satisfy reading; legacy terminal stays terminal without fabricating owned leaves', () => {
    const f = readingAchievementFixture('reading-import-boundary')
    try {
        f.edit((s) => {
            s.achievements.entries[3020033] = { value: 3, finishTime: 1799999900, claimed: true }
            s.achievements.entries[3020034] = { value: 3, finishTime: 0, claimed: false, leafCounts: [1, 1, 1] }
            s.achievements.entries[1040001] = { value: 1, finishTime: 0, claimed: false }
            s.achievements.entries[3020035] = { value: 20, finishTime: 0, claimed: false }
        })
        const packets = f.call('ActivityGet'),
            state = f.state()
        assert.equal(Object.keys(state.readingBooks ?? {}).length, 0)
        assert.deepEqual(f.wire(packets, 3020033).count, [0, 0, 0])
        assert.equal(state.achievements.entries[3020033].finishTime, 1799999900)
        assert.equal(state.achievements.entries[3020033].claimed, true)
        assert.equal(state.achievements.entries[3020033].value, 3)
        assert.equal(state.achievements.entries[3020034].value, 0)
        assert.deepEqual(state.achievements.entries[3020034].leafCounts, [0, 0, 0])
        assert.equal(state.achievements.entries[1040001].value, 0)
        assert.equal(state.achievements.entries[3020035].value, 0)
        assert.throws(
            () => f.call('AchievementReward', { u32: 3020034 }),
            (e) => e.code === ErrorCode.AchievementIsRunning,
        )
        assert.deepEqual(f.wire(f.acquire(10002), 3020033).count, [0, 1, 0])
        f.edit((s) => {
            s.achievements.entries[1040001].claimed = true
        })
        const bad = f.state()
        assert.throws(
            () => f.call('ActivityGet'),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), bad)
    } finally {
        f.store.close()
    }
})

test('real reading vectors and claimed rewards survive SQLite close/reopen and remain account-local', () => {
    const scratch = path.resolve('../scratch')
    fs.mkdirSync(scratch, { recursive: true })
    const file = path.join(scratch, 'reading-' + Date.now() + '.sqlite')
    let f = readingAchievementFixture('reading-sqlite', file)
    try {
        for (const id of [10001, 10002, 10003]) f.acquire(id)
        f.call('AchievementReward', { u32: 3020033 })
        const saved = f.state().achievements.entries[3020033]
        f.store.close()
        f = readingAchievementFixture('reading-sqlite', file)
        assert.deepEqual(f.state().achievements.entries[3020033], saved)
        const full = achievementSnapshot(f.tables, f.state(), 1800000000).achievements.find((r) => r.id === 3020033)
        assert.deepEqual(full.count, [1, 1, 1])
        assert.deepEqual(f.reply(f.call('AchievementReward', { u32: 3020033 }), 9902).rewards, [])
        const other = readingAchievementFixture('reading-sqlite-other', file)
        try {
            assert.equal(Object.keys(other.state().readingBooks ?? {}).length, 0)
        } finally {
            other.store.close()
        }
    } finally {
        f.store.close()
    }
})
