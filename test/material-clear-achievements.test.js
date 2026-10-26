import test from 'node:test'
import assert from 'node:assert/strict'
import { materialClearFixture } from './material-clear-fixture.js'
import { achievementCatalogue, achievementPoints } from '../src/achievements.js'
import { materialClearRule, materialClearValue } from '../src/material-clear-progress.js'
import { parseRewards } from '../src/rewards.js'
import { ErrorCode } from '../src/error-codes.js'
const ids = [5050009, 5050010, 5050011, 5050012, 5050013, 5050014, 5050015, 5050016, 5050017]
test('all nine15010 achievement shapes validate selectors and authoritative unfinished receipts ignore invented progress', () => {
    const f = materialClearFixture('material-ach-contract')
    try {
        const model = achievementCatalogue(f.tables)
        assert.equal([...model.rules.values()].filter((r) => r.supported).length, 131)
        assert(ids.every((id) => model.rules.get(id).supported))
        for (const bad of [
            [15010, 0, 0, 0, 0, 50],
            [15010, 2, 1, 201, 0, 50],
            [15010, 0, 1, 0, 1, 50],
            [15010, 0, 1, 0, 0, 0],
        ])
            assert.equal(materialClearRule(f.tables, bad), false)
        f.win(30101)
        f.edit((s) => (s.achievements.entries[5050017] = { value: 500, finishTime: 0, claimed: false }))
        f.call('ActivityGet')
        assert.equal(
            f.read((s) => s.achievements.entries[5050017].value),
            1,
        )
        assert.equal(
            f.read((s) => s.achievements.entries[5050017].finishTime),
            0,
        )
        assert.throws(
            () => f.call('AchievementReward', { u32: 5050017 }),
            (e) => e.code === ErrorCode.AchievementIsRunning,
        )
        f.edit((s) => (s.achievements.entries[5050017] = { value: 1, finishTime: 1799999999, claimed: false }))
        const before = f.state()
        assert.throws(
            () => f.call('AchievementReward', { u32: 5050017 }),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.close()
    }
})

test('real five-hundred victories in each of the three tags complete all nine thresholds and configured claims once', () => {
    const f = materialClearFixture('material-ach-real1500')
    try {
        const model = achievementCatalogue(f.tables),
            plan = [
                [10101, ids.slice(0, 3)],
                [20101, ids.slice(3, 6)],
                [30101, ids.slice(6, 9)],
            ]
        for (const [material, targets] of plan) {
            for (let n = 1; n <= 500; n++) {
                f.win(material)
                if ([50, 100, 500].includes(n)) {
                    f.call('ActivityGet')
                    for (const id of targets) {
                        const row = model.byId.get(id),
                            saved = f.read((s) => s.achievements.entries[id])
                        assert.equal(saved.value, Math.min(row.param, n))
                        assert.equal(saved.finishTime > 0, n >= row.param)
                        if (n === row.param) {
                            const packets = f.call('AchievementReward', { u32: id }),
                                e = f.protocol.byName.get('CSProtoAchievementReward'),
                                reply = f.protocol.decode(e.rsp, packets.find((p) => p.id === e.id).payload)
                            assert.deepEqual(reply.rewards, parseRewards(row.reward))
                            assert(f.read((s) => s.achievements.entries[id].claimed))
                        }
                    }
                }
            }
            assert.equal(
                f.read((s) => s.materialDungeonRecords[material].success_count),
                500,
            )
        }
        const completed = f.read((s) => structuredClone(s.achievements))
        for (const id of ids) {
            const e = f.protocol.byName.get('CSProtoAchievementReward'),
                packets = f.call('AchievementReward', { u32: id })
            assert.deepEqual(f.protocol.decode(e.rsp, packets.find((p) => p.id === e.id).payload).rewards, [])
        }
        assert.deepEqual(
            f.read((s) => s.achievements),
            completed,
        )
        assert(achievementPoints(f.tables, f.state()) >= ids.reduce((n, id) => n + model.byId.get(id).achPoint, 0))
        assert.equal(materialClearValue(f.tables, f.state(), [15010, 0, 2, 0, 0, 500]), 500)
    } finally {
        f.close()
    }
})
