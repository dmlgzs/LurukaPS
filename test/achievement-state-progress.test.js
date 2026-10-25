import test from 'node:test'
import assert from 'node:assert/strict'
import { achievementFixture } from './achievement-fixture.js'
import { achievementCatalogue } from '../src/achievements.js'
import { achievementStateRule, achievementStateValue } from '../src/achievement-state-progress.js'
import { grantRewards } from '../src/rewards.js'
import { ErrorCode } from '../src/error-codes.js'
import { TaskGraphs, makeNode } from '../src/tasks.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const decode = (f, packets) =>
    packets
        .filter((row) => row.id === 9900)
        .flatMap((row) => f.protocol.decode('SCAchievementSync', row.payload).achievements)
const edit = (f, fn) => f.store.transact(f.session.id, 0, fn)
const query = (f) => f.call('ActivityGet') // ordinary transaction observes state; no fabricated completion request

test('current state-based achievements compile from real table shapes while unobserved selectors stay unsupported', () => {
    const f = achievementFixture('achievement-state-catalog')
    try {
        const model = achievementCatalogue(f.tables),
            added = model.rows.filter((row) => achievementStateRule(model.rules.get(row.id).tokens ?? []))
        assert.deepEqual(
            added.map((row) => row.id).sort(),
            [2010003, 2010004, 3010003, 3010004, 3020014, 3020015, 3020016, 4020008, 4020009],
        )
        assert(added.every((row) => model.rules.get(row.id).supported))
        assert.equal(model.rows.filter((row) => model.rules.get(row.id).supported).length, 83)
        for (const tokens of [
            [12046, 1, 100],
            [12046, 0, 100, 1],
            [13104, 100],
            [15017, 30, 1],
        ])
            assert.equal(achievementStateRule(tokens), false)
        assert.equal(model.rules.get(2010005).supported, false) // HomeReclamation is a different condition.
    } finally {
        f.store.close()
    }
})

test('species distinguishes captured evolution forms and ignores repeated captures, box ownership and previews', () => {
    const f = achievementFixture('achievement-state-species')
    try {
        const ranks = f.tables.get('pet_rank'),
            variants = ranks.filter((row) => row.petGroup === ranks[0].petGroup),
            second = ranks.find((row) => row.petGroup !== ranks[0].petGroup)
        assert(variants.length > 1)
        const state = f.state()
        assert(state.pets.length > 0)
        assert.equal(achievementStateValue(f.tables, state, [12046, 0, 100], new Map()), 0)
        edit(f, (s) => {
            s.petCaptureResults = Object.fromEntries(
                variants.map((row, index) => [index, { guid: String(index + 1), pet_id: row.petId }]),
            )
            s.petCaptureResults.next = { guid: '999', pet_id: second.petId }
            s.petCaptureResults.duplicate = { guid: '1001', pet_id: variants[0].petId }
            s.petCaptureResults.unknown = { guid: '1000', pet_id: 0xffffffff }
            s.petCaptureResults.preview = { pet_id: ranks[0].petId }
            const uncaught = ranks.find((row) => row.petGroup !== ranks[0].petGroup && row.petGroup !== second.petGroup)
            for (const guid of ['0', '00', '-1', 'not-a-guid', '18446744073709551616'])
                s.petCaptureResults['invalid:' + guid] = { guid, pet_id: uncaught.petId }
            s.pets = [] // release/consume all present pets; history remains.
        })
        const packets = query(f),
            entry = f.state().achievements.entries[4020008]
        assert.equal(entry.value, variants.length + 1)
        assert.equal(entry.finishTime, 0)
        assert.equal(decode(f, packets).find((row) => row.id === 4020008).count[0], variants.length + 1)
        assert.throws(
            () => f.call('AchievementReward', { u32: 4020008 }),
            (error) => error.code === ErrorCode.AchievementIsRunning,
        )
    } finally {
        f.store.close()
    }
})

test('one actual prologue CatchPet transaction crosses the 100-species threshold and publishes completion exactly once', () => {
    const f = achievementFixture('achievement-state-catch-producer')
    try {
        const graph = new TaskGraphs(f.tables).get(106002),
            target = ((4n << 56n) | 102056n).toString(),
            history = f.tables
                .get('pet_rank')
                .map((row) => row.petId)
                .filter((id) => id !== 500297)
                .slice(0, 99)
        assert.equal(history.length, 99)
        edit(f, (s) => {
            Object.assign(s.world, { map_id: 102, point_id: 102001, pos: { x: 46518, y: 10453, z: 34710 } })
            s.tasks = [
                {
                    task_id: 106002,
                    nodes: [{ ...makeNode(graph, 56, s), client_before: true }],
                    finish_nodes: [1],
                    reward_nodes: [],
                },
            ]
            s.taskRecords = [{ task_id: 106001, count: 1, time: 1 }]
            s.player.sbag_infos.items = [{ itemid: 1000001, itemnum: 1, itemtype: 3, guid: '600001' }]
            // Canonical imported capture history supplies 99 species; only the
            // final species is produced by a real current CatchPet request.
            s.petCaptureResults = Object.fromEntries(
                history.map((id, index) => ['history:' + index, { guid: String(700000 + index), pet_id: id }]),
            )
        })
        query(f)
        assert.equal(f.state().achievements.entries[4020008].value, 99)
        f.call('GetCatchPetInfo', { tar_id: [target], day_weather: 2, reason: 1, pet_len_id: 0 })
        const cardPackets = f.call('CatchPetCard', { item_id: 1000001, is_create: true, client_param: '1' }),
            cardEntry = f.protocol.byName.get('CSProtoCatchPetCard'),
            card = f.protocol.decode(cardEntry.rsp, cardPackets.find((row) => row.id === cardEntry.id).payload),
            request = {
                tar_id: target,
                item_id: 1000001,
                day_weather: 2,
                catch_key: card.catch_key,
                position: { x: 465.18, y: 104.53, z: 347.1 },
            },
            packets = f.call('CatchPet', request),
            achievement = decode(f, packets).find((row) => row.id === 4020008)
        assert.equal(f.state().petCaptureResults[target].pet_id, 500297)
        assert.equal(achievement.finish_time, '1800000000')
        assert.deepEqual(achievement.count, [100])
        assert.equal(f.state().achievements.entries[4020009].value, 100)
        assert.equal(f.state().achievements.entries[4020009].finishTime, 0)
        assert(!decode(f, f.call('CatchPet', request)).some((row) => row.id === 4020008))
        assert.deepEqual(f.reply(f.call('AchievementReward', { u32: 4020008 }), 9902), { rewards: [], src: 20 })
        assert.deepEqual(f.reply(f.call('AchievementReward', { u32: 4020008 }), 9902), { rewards: [] })
    } finally {
        f.store.close()
    }
})

test('actual home experience producer unlocks level achievements without borrowing player level or landscape stage', () => {
    const f = achievementFixture('achievement-state-home-producer')
    try {
        edit(f, (s) => {
            s.player.basic_info.lv = 80
            s.home.stage = 50
        })
        query(f)
        assert.equal(f.state().achievements.entries[2010003]?.finishTime ?? 0, 0)
        const required = f.tables
            .get('home_level')
            .filter((row) => row.id < 30)
            .reduce((sum, row) => sum + row.exp, 0)
        edit(f, (s) => grantRewards(f.tables, s, [{ itemtype: 10, itemid: 1003, itemnum: required }]))
        assert(f.state().home.level >= 30)
        const packets = f.call('AchievementReward', { u32: 2010003 })
        assert.equal(decode(f, packets).find((row) => row.id === 2010003).is_reward, true)
        assert.equal(f.state().achievements.entries[2010004].finishTime, 0)
        const nextExperience = f.tables
            .get('home_level')
            .filter((row) => row.id >= 30 && row.id < 50)
            .reduce((sum, row) => sum + row.exp, 0)
        edit(f, (s) => grantRewards(f.tables, s, [{ itemtype: 10, itemid: 1003, itemnum: nextExperience }]))
        assert.equal(f.state().home.level, 50)
        f.call('AchievementReward', { u32: 2010004 })
        edit(f, (s) => {
            s.home.level = 1
        })
        query(f)
        assert.equal(f.state().achievements.entries[2010003].value, 30)
        assert.equal(f.state().achievements.entries[2010003].claimed, true)
    } finally {
        f.store.close()
    }
})

test('exploration requires the exact configured map and keeps earned progress when the current map changes', () => {
    const f = achievementFixture('achievement-state-exploration')
    try {
        edit(f, (s) => {
            s.exploration.map_info = [
                { map_id: 100, lv: 9 },
                { map_id: 101, lv: 10 },
                { map_id: 102, lv: 50 },
            ]
        })
        query(f)
        assert.equal(f.state().achievements.entries[3010003].value, 9)
        assert.equal(f.state().achievements.entries[3010003].finishTime, 0)
        assert.equal(f.state().achievements.entries[3010004].finishTime, 1800000000)
        edit(f, (s) => {
            s.exploration.map_info[0].lv = 10
            s.world.map_id = 200
        })
        f.call('AchievementReward', { u32: 3010003 })
        edit(f, (s) => {
            s.exploration.map_info = []
        })
        f.call('AchievementReward', { u32: 3010004 })
        assert(f.state().achievements.entries[3010004].claimed)
    } finally {
        f.store.close()
    }
})

test('invalid source state or failed achievement serialization cannot partially persist progress or claims', () => {
    const f = achievementFixture('achievement-state-rollback')
    try {
        edit(f, (s) => {
            s.exploration.map_info = [{ map_id: 100, lv: -1 }]
        })
        const invalid = structuredClone(f.state())
        assert.throws(
            () => f.call('AchievementReward', { u32: 3010003 }),
            (error) => error.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), invalid)
        edit(f, (s) => {
            s.exploration.map_info = [{ map_id: 100, lv: 10 }]
        })
        const before = structuredClone(f.state()),
            original = f.game.packet
        f.game.packet = function (name, ...args) {
            if (name === 'CSProtoAchievementSync') throw Error('achievement state packet fault')
            return original.call(this, name, ...args)
        }
        assert.throws(() => f.call('AchievementReward', { u32: 3010003 }), /achievement state packet fault/)
        assert.deepEqual(f.state(), before)
        f.game.packet = original
        f.call('AchievementReward', { u32: 3010003 })
        assert(f.state().achievements.entries[3010003].claimed)
    } finally {
        f.store.close()
    }
})

test('all 200 known capture receipts can earn both real tiers and persisted claims survive reopening without present pets', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'luruka-achievement-state-')),
        file = path.join(directory, 'achievement.sqlite')
    let f
    try {
        f = achievementFixture('achievement-state-persisted', file)
        const ids = f.tables
            .get('pet_rank')
            .slice(0, 200)
            .map((row) => row.petId)
        assert.equal(new Set(ids).size, 200)
        edit(f, (s) => {
            // Valid imported history tests both actual thresholds, not proof
            // that this test caught 200 pets or that all 205 are world-spawned.
            s.petCaptureResults = Object.fromEntries(
                ids.map((id, index) => [index, { pet_id: id, guid: String(index + 1) }]),
            )
            s.pets = []
        })
        f.call('AchievementReward', { u32: 4020008 })
        f.call('AchievementReward', { u32: 4020009 })
        const receipts = structuredClone(f.state().achievements.entries)
        f.store.close()
        f = null
        f = achievementFixture('achievement-state-persisted', file)
        assert.deepEqual(f.state().achievements.entries, receipts)
        assert.deepEqual(f.reply(f.call('AchievementReward', { u32: 4020009 }), 9902), { rewards: [] })
        assert(!decode(f, query(f)).length)
    } finally {
        f?.store.close()
        assert.equal(path.dirname(directory), path.resolve(os.tmpdir()))
        assert(path.basename(directory).startsWith('luruka-achievement-state-'))
        for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(file + suffix)) fs.unlinkSync(file + suffix)
        fs.rmdirSync(directory)
    }
})
