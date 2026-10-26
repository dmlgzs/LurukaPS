import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { reclamationFixture } from './field-reclamation-fixture.js'
import { achievementCatalogue, achievementPoints } from '../src/achievements.js'
import { fieldReclamationRule, fieldReclamationValue } from '../src/field-reclamation-progress.js'
import { ErrorCode } from '../src/error-codes.js'

const error = (code) => (e) => e.code === code
const count = (f) => fieldReclamationValue(f.state(), [12031, 0, 1])
const rows = (f) => {
    const model = achievementCatalogue(f.tables)
    return model.rows.filter((row) => model.rules.get(row.id).tokens?.[0] === 12031).sort((a, b) => a.param - b.param)
}
const saved = (f, row) => f.state().achievements?.entries?.[row.id]
const claim = (f, row) => f.call('AchievementReward', { u32: row.id })
function openClose(f) {
    const result = f.open()
    f.close(result.build.guid)
    return result
}

test('complete current reclamation family is table-driven and does not promote unknown selectors', () => {
    const f = reclamationFixture('reclamation-achievement-catalog')
    try {
        const model = achievementCatalogue(f.tables),
            family = rows(f)
        assert.deepEqual(
            family.map((row) => row.param),
            [30, 50],
        )
        assert(family.every((row) => model.rules.get(row.id).supported))
        assert.equal(
            family.reduce((sum, row) => sum + row.achPoint, 0),
            7,
        )
        assert.equal(model.rows.filter((row) => model.rules.get(row.id).supported).length, 128)
        assert.equal(count(f), 0)
        for (const t of [
            [12031, 1, 30],
            [12031, 3, 50],
            [12031, 0],
            [12031, 0, -1],
            [12031, 0, 30, 1],
        ]) {
            assert.equal(fieldReclamationRule(t), false)
            assert.equal(fieldReclamationValue(f.state(), t), null)
        }
    } finally {
        f.store.close()
    }
})

test('fifty actual accepted opens complete both thresholds, retain history after closing, and preserve claims through SQLite reopening', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reclamation-achievements-')),
        filename = path.join(directory, 'probe.sqlite')
    let f = reclamationFixture('reclamation-achievement-real', filename)
    try {
        const family = rows(f),
            startingPoints = achievementPoints(f.tables, f.state())
        for (let n = 1; n <= family.at(-1).param; n++) {
            const result = f.open()
            assert.equal(count(f), n)
            for (const row of family) assert.equal(saved(f, row)?.value ?? 0, Math.min(n, row.param))
            const milestone = family.find((row) => row.param === n)
            if (milestone) {
                assert(saved(f, milestone).finishTime > 0)
                const packets = claim(f, milestone)
                assert(packets.some((p) => p.id === 9902))
                assert.equal(saved(f, milestone).claimed, true)
                claim(f, milestone)
                const duplicate = f.open()
                assert.equal(duplicate.build.guid, result.build.guid)
                assert.equal(count(f), n)
            } else if (n === family[0].param - 1) {
                assert.throws(() => claim(f, family[0]), error(ErrorCode.AchievementIsRunning))
            }
            f.close(result.build.guid)
            assert.equal(count(f), n)
        }
        assert.equal(achievementPoints(f.tables, f.state()), startingPoints + 7)
        assert(!f.state().home.builds.some((row) => row.guid === f.state().home.reclamationProgress.lastGuid))
        f.store.close()
        f = reclamationFixture('reclamation-achievement-real', filename, true)
        assert.equal(count(f), 50)
        for (const row of family) {
            assert.equal(saved(f, row).claimed, true)
            claim(f, row)
        }
        assert.equal(achievementPoints(f.tables, f.state()), startingPoints + 7)
        const other = reclamationFixture('reclamation-achievement-other', filename)
        try {
            assert.equal(count(other), 0)
            assert(!saved(other, family[0])?.finishTime)
        } finally {
            other.store.close()
        }
        assert.equal(count(f), 50)
    } finally {
        f.store.close()
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()))
        assert(path.basename(directory).startsWith('reclamation-achievements-'))
        fs.rmSync(directory, { recursive: true, force: true })
    }
})

test('old unfinished full values cannot create history and equal-threshold progress terminates only after a real final open', () => {
    const f = reclamationFixture('reclamation-achievement-legacy'),
        row = rows(f)[0]
    try {
        f.edit((s) => {
            s.achievements.entries[row.id] = { value: row.param, finishTime: 0, claimed: false }
        })
        f.call('ActivityGet')
        assert.equal(saved(f, row).value, 0)
        assert.equal(saved(f, row).finishTime, 0)
        for (let i = 1; i < row.param; i++) openClose(f)
        assert.equal(count(f), row.param - 1)
        f.edit((s) => {
            s.achievements.entries[row.id] = { value: row.param, finishTime: 0, claimed: false }
        })
        openClose(f)
        assert.equal(count(f), row.param)
        assert(saved(f, row).finishTime > 0)
        for (const broken of [
            { value: row.param - 1, finishTime: 1799999990, claimed: false },
            { value: row.param, finishTime: 0, claimed: true },
        ]) {
            f.edit((s) => {
                s.achievements.entries[row.id] = broken
            })
            const before = f.state()
            assert.throws(() => claim(f, row), error(ErrorCode.GameConfig))
            assert.deepEqual(f.state(), before)
        }
        const terminal = { value: row.param, finishTime: 1799999990, claimed: true }
        f.edit((s) => {
            delete s.home.reclamationProgress
            s.achievements.entries[row.id] = terminal
        })
        f.call('ActivityGet')
        assert.equal(count(f), 0)
        assert.deepEqual(saved(f, row), terminal) // Explicit old terminal fixture, no historic source reconstruction.
    } finally {
        f.store.close()
    }
})

test('final-open achievement encoding and SQL errors roll back the real count, GUID and terminal receipt; claim encoding is atomic too', () => {
    const f = reclamationFixture('reclamation-achievement-rollback'),
        row = rows(f)[0]
    try {
        for (let i = 1; i < row.param; i++) openClose(f)
        const before = f.state(),
            pending = f.store.pending.get(f.session.id),
            token = f.store.readCacheToken(f.session.id)
        const encode = f.protocol.encode,
            achievementSync = f.protocol.byName.get('CSProtoAchievementSync').rsp
        f.protocol.encode = function (type, ...args) {
            if (type === achievementSync) throw Error('reclamation-achievement-codec')
            return encode.call(this, type, ...args)
        }
        try {
            assert.throws(() => f.open(), /reclamation-achievement-codec/)
        } finally {
            f.protocol.encode = encode
        }
        assert.deepEqual(f.state(), before)
        assert.equal(f.store.pending.get(f.session.id), pending)
        assert.equal(f.store.readCacheToken(f.session.id), token)
        f.store.db.exec(
            `CREATE TEMP TRIGGER reclamation_achievement_abort BEFORE UPDATE ON players WHEN OLD.account_id=${f.session.id} BEGIN SELECT RAISE(ABORT,'reclamation-achievement-SQL'); END`,
        )
        try {
            assert.throws(() => f.open(), /reclamation-achievement-SQL/)
        } finally {
            f.store.db.exec('DROP TRIGGER reclamation_achievement_abort')
        }
        assert.deepEqual(f.state(), before)
        assert.equal(f.store.pending.get(f.session.id), pending)
        const result = f.open()
        assert.equal(count(f), row.param)
        assert(saved(f, row).finishTime > 0)
        const beforeClaim = f.state(),
            response = f.protocol.byName.get('CSProtoAchievementReward').rsp
        f.protocol.encode = function (type, ...args) {
            if (type === response) throw Error('reclamation-claim-codec')
            return encode.call(this, type, ...args)
        }
        try {
            assert.throws(() => claim(f, row), /reclamation-claim-codec/)
        } finally {
            f.protocol.encode = encode
        }
        assert.deepEqual(f.state(), beforeClaim)
        claim(f, row)
        assert.equal(saved(f, row).claimed, true)
        f.close(result.build.guid)
    } finally {
        f.store.close()
    }
})
