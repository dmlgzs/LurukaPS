import test from 'node:test'
import assert from 'node:assert/strict'
import { farmHarvestFixture } from './farm-harvest-fixture.js'
import { achievementCatalogue, achievementPoints } from '../src/achievements.js'
import { grantRewards } from '../src/rewards.js'
import { ErrorCode } from '../src/error-codes.js'
const goals = (f) => achievementCatalogue(f.tables).rows.filter((row) => row.finishCondition.startsWith('12005#'))

test('complete12005 three-achievement family uses literal manual-field products and never inventory,worker awards or fertile19 aliasing', () => {
    const f = farmHarvestFixture('farm-achievement-classification')
    try {
        const model = achievementCatalogue(f.tables),
            rows = goals(f)
        assert.deepEqual(
            rows.map((row) => row.param),
            [50, 100, 200],
        )
        assert(rows.every((row) => model.rules.get(row.id).supported))
        assert.equal(model.rows.length, 355)
        assert(
            model.rows
                .filter((row) => row.finishCondition.startsWith('12102#'))
                .every((row) => !model.rules.get(row.id).supported),
        )
        f.edit((s) => {
            grantRewards(f.tables, s, [{ itemtype: 3, itemid: 305901, itemnum: 1000 }])
            s.home.craftCounts = { 31: 1000 }
            s.home.manualWaterCount = 1000
        })
        f.call('ActivityGet')
        assert(rows.every((row) => !f.state().achievements.entries[row.id]?.value))
        f.grow(31, 101)
        f.harvest(101)
        f.assign()
        f.grow(31)
        f.harvest(100, true)
        f.call('GetAutoWorkCropReward', { u32: 20 })
        assert(rows.every((row) => !f.state().achievements.entries[row.id]?.value))
    } finally {
        f.close()
    }
})

test('fifty real crop cycles grant200 manual products and earn every12005 achievement reward once', () => {
    const f = farmHarvestFixture('farm-achievement-two-hundred')
    try {
        const rows = goals(f)
        for (let cycle = 1; cycle <= 50; cycle++) {
            f.grow(31)
            f.harvest()
            for (const row of rows) {
                assert.equal(f.state().achievements.entries[row.id]?.value ?? 0, Math.min(row.param, cycle * 4))
                assert.equal((f.state().achievements.entries[row.id]?.finishTime ?? 0) > 0, cycle * 4 >= row.param)
            }
        }
        for (const row of rows) {
            f.call('AchievementReward', { u32: row.id })
            assert.equal(f.state().achievements.entries[row.id].claimed, true)
            const before = f.state(),
                points = achievementPoints(f.tables, before)
            const reply = f.call('AchievementReward', { u32: row.id }).find((packet) => packet.id === 9902)
            assert.deepEqual(f.protocol.decode('Rewards', reply.payload).rewards, [])
            assert.deepEqual(f.state().player, before.player)
            assert.equal(achievementPoints(f.tables, f.state()), points)
        }
    } finally {
        f.close()
    }
})

test('final actual crop9900 and9902 failures are atomic and an earned terminal receipt survives unknown old source history', () => {
    const f = farmHarvestFixture('farm-achievement-atomic')
    try {
        for (let cycle = 0; cycle < 12; cycle++) {
            f.grow(31)
            f.harvest()
        }
        f.grow(31)
        const before = f.state(),
            encode = f.protocol.encode
        let visited = false
        f.protocol.encode = function (name, payload) {
            if (name === f.protocol.byId.get(9900).rsp) {
                visited = true
                throw Error('farm-achievement-sync')
            }
            return encode.call(this, name, payload)
        }
        assert.throws(() => f.harvest(), /farm-achievement-sync/)
        assert(visited)
        assert.deepEqual(f.state(), before)
        f.protocol.encode = encode
        f.harvest()
        const row = goals(f)[0],
            ready = f.state()
        f.protocol.encode = function (name, payload) {
            if (name === f.protocol.byId.get(9902).rsp) throw Error('farm-achievement-reward')
            return encode.call(this, name, payload)
        }
        assert.throws(() => f.call('AchievementReward', { u32: row.id }), /farm-achievement-reward/)
        assert.deepEqual(f.state(), ready)
        f.protocol.encode = encode
        f.call('AchievementReward', { u32: row.id })
        const receipt = f.state().achievements.entries[row.id]
        f.edit((s) => {
            delete s.home.farmHarvestProgress
        })
        f.call('ActivityGet')
        assert.deepEqual(f.state().achievements.entries[row.id], receipt)
        assert.throws(
            () => f.call('AchievementReward', { u32: goals(f).at(-1).id }),
            (e) => e.code === ErrorCode.AchievementIsRunning,
        )
    } finally {
        f.close()
    }
})
