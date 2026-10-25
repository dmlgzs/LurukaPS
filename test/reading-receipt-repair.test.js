import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readingAchievementFixture } from './reading-achievement-fixture.js'
import { achievementCatalogue } from '../src/achievements.js'
import { ErrorCode } from '../src/error-codes.js'

const targets = [1040001, 1040002, 3020033, 3020034, 3020035, 3020036]
function acquireAll(f) {
    const series = new Map(f.tables.get('library_series').map((r) => [r.id, String(r.subId).split('|').map(Number)]))
    const ids = [
        ...new Set(
            f.tables
                .get('library_branch')
                .flatMap((r) => String(r.seriesId).split('|').map(Number))
                .flatMap((id) => series.get(id)),
        ),
    ]
    for (const id of ids) f.acquire(id)
    assert.equal(Object.keys(f.state().readingBooks).length, 57)
    assert(targets.every((id) => f.state().achievements.entries[id]?.finishTime > 0))
}
function unfinishedFull(f) {
    f.edit((s) => {
        for (const id of targets)
            s.achievements.entries[id] = { ...s.achievements.entries[id], finishTime: 0, claimed: false }
    })
}

test('9902 repairs equal full unfinished progress for all six actual owned reading targets and claims once', () => {
    const f = readingAchievementFixture('reading-receipt-full')
    try {
        acquireAll(f)
        unfinishedFull(f)
        const books = structuredClone(f.state().readingBooks)
        for (const id of targets) {
            const result = f.reply(f.call('AchievementReward', { u32: id }), 9902)
            assert.deepEqual(result.rewards, [])
            const row = f.state().achievements.entries[id]
            assert.equal(row.finishTime, 1800000000)
            assert.equal(row.claimed, true)
            if ([3020033, 3020034].includes(id)) assert.deepEqual(row.leafCounts, [1, 1, 1])
        }
        const completed = structuredClone(f.state().achievements)
        for (const id of targets) assert.deepEqual(f.reply(f.call('AchievementReward', { u32: id }), 9902).rewards, [])
        assert.deepEqual(f.state().achievements, completed)
        assert.deepEqual(f.state().readingBooks, books)
    } finally {
        f.store.close()
    }
})

test('fake full reading progress with insufficient actual owned volumes stays unfinished and cannot claim', () => {
    const f = readingAchievementFixture('reading-receipt-unearned')
    try {
        f.acquire(10003)
        f.edit((s) => {
            s.achievements.entries[1040001] = { value: 1, finishTime: 0, claimed: false }
            s.achievements.entries[3020033] = { value: 3, finishTime: 0, claimed: false, leafCounts: [1, 1, 1] }
        })
        f.call('ActivityGet')
        assert.deepEqual(f.state().achievements.entries[3020033], {
            value: 1,
            finishTime: 0,
            claimed: false,
            leafCounts: [0, 0, 1],
        })
        assert.deepEqual(f.state().achievements.entries[1040001], { value: 0, finishTime: 0, claimed: false })
        for (const id of [1040001, 3020033])
            assert.throws(
                () => f.call('AchievementReward', { u32: id }),
                (e) => e.code === ErrorCode.AchievementIsRunning,
            )
        assert.deepEqual(Object.keys(f.state().readingBooks), ['10003'])
    } finally {
        f.store.close()
    }
})

test('all six reading terminal receipts with value below param are rejected before9902 grant, claimed or unclaimed', () => {
    const f = readingAchievementFixture('reading-receipt-malformed')
    try {
        acquireAll(f)
        const original = structuredClone(f.state().achievements.entries),
            model = achievementCatalogue(f.tables)
        for (const id of targets)
            for (const claimed of [false, true]) {
                f.edit((s) => {
                    s.achievements.entries = structuredClone(original)
                    s.achievements.entries[id] = {
                        ...s.achievements.entries[id],
                        value: model.byId.get(id).param - 1,
                        finishTime: 1799999900,
                        claimed,
                    }
                })
                const before = structuredClone(f.state())
                assert.throws(
                    () => f.call('AchievementReward', { u32: id }),
                    (e) => e.code === ErrorCode.GameConfig,
                )
                assert.deepEqual(f.state(), before)
            }
    } finally {
        f.store.close()
    }
})

test('receipt repair and claim roll back together on9900/9902/SQLite failure and persist once after restart', () => {
    const scratch = fileURLToPath(new URL('../../scratch', import.meta.url))
    fs.mkdirSync(scratch, { recursive: true })
    const file = path.join(scratch, 'reading-receipt-' + Date.now() + '.sqlite')
    let f = readingAchievementFixture('reading-receipt-atomic', file)
    try {
        acquireAll(f)
        unfinishedFull(f)
        for (const type of ['cs.SCAchievementSync', 'cs.Rewards']) {
            const before = structuredClone(f.state()),
                encode = f.protocol.encode
            f.protocol.encode = function (name, value) {
                if (name === type || 'cs.' + name === type) throw Error('reading-repair-codec')
                return encode.call(this, name, value)
            }
            try {
                assert.throws(() => f.call('AchievementReward', { u32: 3020033 }), /reading-repair-codec/)
            } finally {
                f.protocol.encode = encode
            }
            assert.deepEqual(f.state(), before)
        }
        const before = structuredClone(f.state())
        f.store.db.exec(
            `CREATE TEMP TRIGGER reading_receipt_abort BEFORE UPDATE ON players WHEN OLD.account_id=${f.session.id} BEGIN SELECT RAISE(ABORT,'reading-repair-SQL'); END`,
        )
        try {
            assert.throws(() => f.call('AchievementReward', { u32: 3020033 }), /reading-repair-SQL/)
        } finally {
            f.store.db.exec('DROP TRIGGER reading_receipt_abort')
        }
        assert.deepEqual(f.state(), before)
        f.call('AchievementReward', { u32: 3020033 })
        assert.equal(f.state().achievements.entries[3020033].claimed, true)
        const receipt = structuredClone(f.state().achievements.entries[3020033]),
            books = structuredClone(f.state().readingBooks)
        f.store.close()
        f = readingAchievementFixture('reading-receipt-atomic', file)
        assert.deepEqual(f.state().achievements.entries[3020033], receipt)
        assert.deepEqual(f.state().readingBooks, books)
        assert.deepEqual(f.reply(f.call('AchievementReward', { u32: 3020033 }), 9902).rewards, [])
        assert.deepEqual(f.state().achievements.entries[3020033], receipt)
    } finally {
        f.store.close()
    }
})
