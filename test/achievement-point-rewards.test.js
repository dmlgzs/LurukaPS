import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { achievementFixture } from './achievement-fixture.js'
import { achievementCatalogue, achievementPoints } from '../src/achievements.js'
import { ErrorCode } from '../src/error-codes.js'

function completeKnownSources(f) {
    const model = achievementCatalogue(f.tables)
    f.store.transact(f.session.id, 0, (s) => {
        s.player.basic_info.lv = 80
        for (const row of model.rows) {
            if (!model.rules.get(row.id).supported) continue
            const [kind, ...p] = model.rules.get(row.id).tokens
            if (kind === 2007 || kind === 12045) {
                s.taskRecords ??= []
                if (!s.taskRecords.some((t) => t.task_id === p[0]))
                    s.taskRecords.push({ task_id: p[0], count: 1, time: 1799999900 })
            }
            if (kind === 13002)
                for (const hero of s.player.heros_info.heros) hero.hero_lv = Math.max(hero.hero_lv, p[0])
        }
    })
}

test('9905 uses award row ID, counts completed unclaimed achievements, and pays actual currency before ACK', () => {
    const f = achievementFixture('achievement-points')
    try {
        completeKnownSources(f)
        const before = f.state().player.basic_info.diamond
        const packets = f.call('GetAchievementPointReward', { u32: 1 })
        assert.deepEqual(f.reply(packets, 9905), {
            rewards: [{ itemtype: 10, itemid: 1, itemnum: 100, exts: [], ext_context: [], varitems: [] }],
            src: 20,
        })
        assert.equal(f.state().player.basic_info.diamond, before + 100)
        assert.equal(f.state().player.attr_infos.attrs.find((a) => a.attr_id === 1).attr_val, String(before + 100))
        assert.equal(f.state().achievements.lastAwardPoint, 100)
        assert(Object.values(f.state().achievements.entries).every((row) => !row.claimed))
        assert(achievementPoints(f.tables, f.state()) >= 100)
        const syncIndex = packets.findIndex((p) => p.id === 9900),
            replyIndex = packets.findIndex((p) => p.id === 9905)
        assert(syncIndex >= 0 && syncIndex < replyIndex)
        assert.equal(
            f.protocol.decode('SCAchievementSync', packets[syncIndex].payload).last_achievement_award_point,
            100,
        )
        assert.deepEqual(f.reply(f.call('GetAchievementPointReward', { u32: 1 }), 9905), { rewards: [] })
        assert.equal(f.state().player.basic_info.diamond, before + 100)
    } finally {
        f.store.close()
    }
})

test('all 17 tiers use real configured rewards once when supplied valid future event receipts', () => {
    const f = achievementFixture('achievement-all-tiers')
    try {
        // This fixture supplies canonical server completion receipts. It does
        // not prove that all 311 missing gameplay event producers are wired.
        const rows = achievementCatalogue(f.tables).rows
        f.store.transact(f.session.id, 0, (s) => {
            for (const row of rows)
                s.achievements.entries[row.id] = { value: row.param, finishTime: 1799999900, claimed: false }
        })
        assert.equal(achievementPoints(f.tables, f.state()), 1704)
        const before = f.state().player.basic_info.diamond
        const awards = f.tables.get('achievement_award').sort((a, b) => a.achiPoint - b.achiPoint)
        for (const row of awards) {
            const result = f.reply(f.call('GetAchievementPointReward', { u32: row.id }), 9905)
            assert.deepEqual(result.rewards, [
                { itemtype: 10, itemid: 1, itemnum: 100, exts: [], ext_context: [], varitems: [] },
            ])
            assert.equal(f.state().achievements.lastAwardPoint, row.achiPoint)
        }
        assert.equal(f.state().player.basic_info.diamond, before + 1700)
        assert.deepEqual(f.reply(f.call('GetAchievementPointReward', { u32: 17 }), 9905), { rewards: [] })
        assert.equal(f.state().player.basic_info.diamond, before + 1700)
    } finally {
        f.store.close()
    }
})

test('insufficient points, numeric point instead of row ID, skipped tiers and corrupt receipts are rejected atomically', () => {
    const f = achievementFixture('achievement-point-invalid')
    try {
        for (const [id, code] of [
            [1, ErrorCode.AchievementCantReward],
            [100, ErrorCode.AchievementConfFail],
            [2, ErrorCode.AchievementCantReward],
        ]) {
            const before = structuredClone(f.state())
            assert.throws(
                () => f.call('GetAchievementPointReward', { u32: id }),
                (e) => e.code === code,
            )
            assert.deepEqual(f.state(), before)
        }
        f.store.transact(f.session.id, 0, (s) => {
            s.achievements.lastAwardPoint = 1
        })
        const before = structuredClone(f.state())
        assert.throws(
            () => f.call('GetAchievementPointReward', { u32: 1 }),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})

test('point sync, currency delta and actual Rewards encoding failures roll back money and award threshold', () => {
    const f = achievementFixture('achievement-point-codec'),
        encode = f.protocol.encode
    try {
        completeKnownSources(f)
        for (const type of ['SCAchievementSync', 'PlayerData', 'Rewards']) {
            const shared = f.state(),
                before = structuredClone(shared)
            let hit = false
            f.protocol.encode = function (name, ...args) {
                if (name === type || name === 'cs.' + type) {
                    hit = true
                    throw Error('point encoding failed')
                }
                return encode.call(this, name, ...args)
            }
            assert.throws(() => f.call('GetAchievementPointReward', { u32: 1 }), /point encoding failed/)
            assert(hit, 'expected encoding hook ' + type)
            assert.deepEqual(shared, before)
            assert.deepEqual(f.state(), before)
            f.protocol.encode = encode
        }
        f.call('GetAchievementPointReward', { u32: 1 })
        assert.equal(f.state().achievements.lastAwardPoint, 100)
    } finally {
        f.protocol.encode = encode
        f.store.close()
    }
})

test('saved point award and wallet survive SQLite reopen and real login without paying twice', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-achievement-points-'))
    let f
    try {
        const file = path.join(dir, 'state.sqlite')
        f = achievementFixture('achievement-points-reopen', file)
        completeKnownSources(f)
        f.call('GetAchievementPointReward', { u32: 1 })
        const diamond = f.state().player.basic_info.diamond
        f.store.close()
        f = achievementFixture('achievement-points-reopen', file)
        assert.equal(f.state().achievements.lastAwardPoint, 100)
        assert.equal(f.state().player.basic_info.diamond, diamond)
        const sync = f.protocol.decode('SCAchievementSync', f.entryPackets.find((p) => p.id === 9900).payload)
        assert.equal(sync.last_achievement_award_point, 100)
        assert.deepEqual(f.reply(f.call('GetAchievementPointReward', { u32: 1 }), 9905), { rewards: [] })
        assert.equal(f.state().player.basic_info.diamond, diamond)
    } finally {
        f?.store.close()
        assert.equal(path.dirname(dir), os.tmpdir())
        assert(path.basename(dir).startsWith('lurukaps-achievement-points-'))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('invalid award configuration and currency overflow preserve earned points and eligibility', () => {
    const f = achievementFixture('achievement-point-bad-config')
    try {
        completeKnownSources(f)
        const row = f.tables.get('achievement_award').find((r) => r.id === 1),
            old = row.achiPoint
        row.achiPoint = 0
        const before = structuredClone(f.state())
        assert.throws(
            () => f.call('GetAchievementPointReward', { u32: 1 }),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
        row.achiPoint = old
        f.store.transact(f.session.id, 0, (s) => {
            s.player.basic_info.diamond = 0x7fffffff
            s.player.attr_infos.attrs.find((a) => a.attr_id === 1).attr_val = String(0x7fffffff)
        })
        const overflow = structuredClone(f.state())
        assert.throws(() => f.call('GetAchievementPointReward', { u32: 1 }), /Currency overflow/)
        assert.deepEqual(f.state(), overflow)
        assert.equal(f.state().achievements.lastAwardPoint, 0)
    } finally {
        f.store.close()
    }
})
