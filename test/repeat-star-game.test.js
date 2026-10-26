import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { repeatFixture } from './helpers/repeat-event-fixture.js'
import { getEntrustCatalog } from '../src/entrust.js'
import { repeatSnapshot, repeatEntryPlan } from '../src/repeat-event.js'
import { ErrorCode } from '../src/error-codes.js'
import { repeatStarTrustedCount } from '../src/repeat-star-progress.js'

// Reuses only the pre-existing public Game fixture, not B205's new fixture.
const request = { activity: 10001, chapter: 101, level: 10101, mode: 1 }
const savedMode = (f) => f.state().repeatEvent?.levels?.['10001:10101']?.mode_save_data.find((row) => row.mode === 1)
function begin(f, restart = false) {
    f.call(restart ? 'RepeatEventReEnterLevelReq' : 'RepeatEventEnterLevelReq', request)
    f.call('MultiCampaignPlayerLoadFinish')
    const stages = getEntrustCatalog(f.tables).stages(32290)
    f.interact(stages[0].row.id)
    return stages.filter((stage) => stage.type === 50)
}
function kill(f, objectId, damage) {
    const state = f.state()
    const actor = state.player.heros_info.battle_infos.find((row) => row.hp > 0).hero_id
    const enemies = Object.values(state.combat.entities).filter((row) => row.object_id === objectId && row.hp > 0)
    assert(enemies.length > 0)
    return f.call('BattleInfoReduce', {
        uint64_dic: [actor, ...enemies.map((row) => row.uuid)],
        base_time: '0',
        battle_info: enemies.map((row, index) => ({
            hurt_info: { from_id: '1', tar_id: String(index + 2), hp_change: damage ?? -row.hp },
        })),
    })
}
function loseOneHero(f) {
    const state = f.state()
    const hero = state.player.heros_info.battle_infos.find((row) => row.hp > 0)
    const enemy = Object.values(state.combat.entities).find((row) => row.hp > 0)
    f.call('BattleInfoReduce', {
        uint64_dic: [enemy.uuid, hero.hero_id],
        base_time: '0',
        battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -hero.hp } }],
    })
    assert.equal(f.state().entrust.run.hero_deaths, 1)
}

test('actual10502/10705 fresh victories keep the best single run across two different2-star masks, improvements, lower runs and exit/reentry', () => {
    const f = repeatFixture('repeat-star-game-best')
    try {
        let waves = begin(f)
        f.tick(300)
        for (const wave of waves) kill(f, wave.row.id)
        assert.equal(f.state().entrust.run.star_mask, 3)
        assert.deepEqual(savedMode(f).star_progress, { version: 1, best_count: 2, best_mask: 3 })
        const firstInstance = f.state().entrust.run.instance_id
        waves = begin(f, true)
        assert.notEqual(f.state().entrust.run.instance_id, firstInstance)
        loseOneHero(f)
        for (const wave of waves) kill(f, wave.row.id)
        assert.equal(f.state().entrust.run.star_mask, 5)
        assert.deepEqual(savedMode(f).star_progress, { version: 1, best_count: 2, best_mask: 5 })
        assert.notEqual(savedMode(f).star_progress.best_mask, 7)
        waves = begin(f, true)
        for (const wave of waves) kill(f, wave.row.id)
        assert.deepEqual(savedMode(f).star_progress, { version: 1, best_count: 3, best_mask: 7 })
        f.call('EndDungeonScene', { result: 3 })
        assert.equal(savedMode(f).win_count, 3)
        f.call('StaminaBoxGet', { box_id: 3001001, times: 1 })
        assert.equal(savedMode(f).win_count, 3)
        f.call('MultiCampaignQuit')
        waves = begin(f)
        f.tick(300)
        for (const wave of waves) kill(f, wave.row.id)
        assert.equal(f.state().entrust.run.star, 2)
        assert.deepEqual(savedMode(f).star_progress, { version: 1, best_count: 3, best_mask: 7 })
        const projected = repeatSnapshot(f.state()).finished_level_data[0].mode_save_data[0]
        const type = 'cs.RepeatEventLevelFinishedModeSavedData'
        assert.equal(f.protocol.decode(type, f.protocol.encode(type, projected)).star_count, 7)
        assert.equal(savedMode(f).win_count, 4)
    } finally {
        f.store.close()
    }
})

test('actual last-wave codec/SQL faults preserve deferred combat and source, then one retry commits the new mask once', () => {
    const f = repeatFixture('repeat-star-game-atomic')
    try {
        const waves = begin(f)
        for (const wave of waves.slice(0, -1)) kill(f, wave.row.id)
        const lastId = waves.at(-1).row.id
        kill(f, lastId, -1)
        const before = f.state()
        const pending = f.store.pending.get(f.session.id)
        const beforeToken = f.store.readCacheToken(f.session.id)
        const oldPacket = f.game.packet
        f.game.packet = function (name, ...args) {
            if (name === 'CSProtoWorldMapSync') throw Error('repeat-star-game-codec')
            return oldPacket.call(this, name, ...args)
        }
        try {
            assert.throws(() => kill(f, lastId), /repeat-star-game-codec/)
        } finally {
            f.game.packet = oldPacket
        }
        assert.deepEqual(f.state(), before)
        assert.equal(f.store.pending.get(f.session.id), pending)
        assert.equal(f.store.readCacheToken(f.session.id), beforeToken)
        assert(Number.isSafeInteger(f.session.id) && f.session.id > 0)
        f.store.db.exec(
            `CREATE TEMP TRIGGER repeat_star_game_abort BEFORE UPDATE ON players WHEN OLD.account_id=${f.session.id} BEGIN SELECT RAISE(ABORT,'repeat-star-game-SQL'); END`,
        )
        try {
            assert.throws(() => kill(f, lastId), /repeat-star-game-SQL/)
        } finally {
            f.store.db.exec('DROP TRIGGER repeat_star_game_abort')
        }
        assert.deepEqual(f.state(), before)
        assert.equal(f.store.pending.get(f.session.id), pending)
        kill(f, lastId)
        assert.equal(repeatStarTrustedCount(savedMode(f)), 3)
        assert.equal(savedMode(f).win_count, 1)
        const disk = JSON.parse(
            f.store.db.prepare('SELECT state FROM players WHERE account_id=?').get(f.session.id).state,
        )
        assert.equal(disk.repeatEvent.levels['10001:10101'].mode_save_data[0].star_progress.best_mask, 7)
        f.call('EndDungeonScene', { result: 3 })
        assert.equal(savedMode(f).win_count, 1)
    } finally {
        f.store.close()
    }
})

test('actual SQLite login keeps new wire7 and legacy claimed receipts; an untyped same-second finished recovery stays untrusted', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'repeat-star-game-'))
    const filename = path.join(directory, 'probe.sqlite')
    let f = repeatFixture('repeat-star-game-reopen', filename)
    try {
        const waves = begin(f)
        // A legal old claimed receipt is a fixture; this source stage does not claim81002.
        f.store.transact(f.session.id, 0, (state) => {
            ;(state.activities ??= {})[10001] ??= { opened: 0, claims: [] }
            state.activities[10001].claims = [100010101]
        })
        for (const wave of waves) kill(f, wave.row.id)
        const original = savedMode(f).star_count
        assert.equal(repeatStarTrustedCount(savedMode(f)), 3)
        f.store.close()
        f = repeatFixture('repeat-star-game-reopen', filename)
        assert.equal(savedMode(f).star_count, original)
        assert.equal(repeatSnapshot(f.state()).finished_level_data[0].mode_save_data[0].star_count, 7)
        assert.deepEqual(f.state().activities[10001].claims, [100010101])
        // Explicit imported legacy recovery fixture, not a newly completed battle.
        f.store.transact(f.session.id, 0, (state) => {
            const legacy = state.repeatEvent.levels['10001:10101'].mode_save_data[0]
            delete legacy.star_progress
            legacy.star_count = 3
            state.entrust.run.battle_complete = false
        })
        f.call('EndDungeonScene', { result: 3 })
        assert.equal(savedMode(f).star_progress, undefined)
        assert.equal(savedMode(f).star_count, 3)
        assert.deepEqual(f.state().activities[10001].claims, [100010101])
    } finally {
        f.store.close()
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()))
        assert(path.basename(directory).startsWith('repeat-star-game-'))
        fs.rmSync(directory, { recursive: true, force: true })
    }
})

test('actual zero-star clear then three-star replay keeps raw0 but unlocks the next level only after the trusted upgrade commits', () => {
    const f = repeatFixture('repeat-star-zero-replay-gate')
    const nextRequest = { ...request, level: 10102 }
    try {
        let waves = begin(f)
        for (const wave of waves.slice(0, -1)) kill(f, wave.row.id)
        loseOneHero(f)
        const challenge = getEntrustCatalog(f.tables).get(32290, 'repeat').dungeon.challenge
        const limits = String(challenge)
            .split('|')
            .map((part) => part.split('#').map(Number))
            .filter(([kind]) => kind === 3006)
            .map(([, seconds]) => seconds)
        f.tick(Math.max(...limits) + 1)
        kill(f, waves.at(-1).row.id)
        assert.equal(f.state().entrust.run.star_mask, 0)
        assert.equal(savedMode(f).star_count, 0)
        assert.equal(savedMode(f).star_progress.best_count, 0)
        assert.throws(
            () => f.call('RepeatEventEnterLevelReq', nextRequest),
            (error) => error.code === ErrorCode.RepeatEventLevelLocked,
        )
        const legacy = f.state()
        const legacyMode = legacy.repeatEvent.levels['10001:10101'].mode_save_data[0]
        delete legacyMode.star_progress
        legacyMode.star_count = 1
        assert.equal(
            repeatEntryPlan(
                { tables: f.tables, state: legacy, activityCatalog: f.game.activities, now: f.game.clock() },
                nextRequest,
            ).level,
            10102,
        )
        waves = begin(f, true)
        for (const wave of waves.slice(0, -1)) kill(f, wave.row.id)
        const before = f.state()
        const originalPacket = f.game.packet
        f.game.packet = function (name, ...args) {
            if (name === 'CSProtoWorldMapSync') throw Error('repeat-star-zero-upgrade-codec')
            return originalPacket.call(this, name, ...args)
        }
        try {
            assert.throws(() => kill(f, waves.at(-1).row.id), /repeat-star-zero-upgrade-codec/)
        } finally {
            f.game.packet = originalPacket
        }
        assert.deepEqual(f.state(), before)
        assert.equal(savedMode(f).star_progress.best_count, 0)
        assert.throws(
            () => f.call('RepeatEventEnterLevelReq', nextRequest),
            (error) => error.code === ErrorCode.RepeatEventLevelLocked,
        )
        kill(f, waves.at(-1).row.id)
        assert.equal(savedMode(f).star_count, 0)
        assert.equal(savedMode(f).star_progress.best_mask, 7)
        const trusted = structuredClone(savedMode(f).star_progress)
        f.store.transact(f.session.id, 0, (state) => {
            state.repeatEvent.levels['10001:10101'].mode_save_data[0].star_progress = { ...trusted, version: 2 }
        })
        assert.throws(
            () => f.call('RepeatEventEnterLevelReq', nextRequest),
            (error) => error.code === ErrorCode.RepeatEventLevelLocked,
        )
        f.store.transact(f.session.id, 0, (state) => {
            state.repeatEvent.levels['10001:10101'].mode_save_data[0].star_progress = trusted
        })
        f.call('MultiCampaignQuit')
        f.call('RepeatEventEnterLevelReq', nextRequest)
        assert.equal(f.state().entrust.run.repeat_event.level, 10102)
        assert.equal(f.state().repeatEvent.levels['10001:10101'].mode_save_data[0].star_count, 0)
    } finally {
        f.store.close()
    }
})

test('legacy positive entry survives an actual zero-star replay without granting trusted three-star qualification', () => {
    const f = repeatFixture('repeat-star-legacy-positive-zero')
    const nextRequest = { ...request, level: 10102 }
    try {
        // Valid old completion fixture; its positive scalar/mask meaning remains unknown.
        f.store.transact(f.session.id, 0, (state) => {
            ;(state.repeatEvent ??= {}).levels ??= {}
            state.repeatEvent.levels['10001:10101'] = {
                event_id: 10001,
                level_id: 10101,
                mode_save_data: [{ mode: 1, star_count: 1, win_count: 1, pass_time: 10 }],
                public_data: {},
            }
        })
        f.call('RepeatEventEnterLevelReq', nextRequest)
        assert.equal(f.state().entrust.run.repeat_event.level, 10102)
        f.call('MultiCampaignQuit')
        const waves = begin(f)
        for (const wave of waves.slice(0, -1)) kill(f, wave.row.id)
        loseOneHero(f)
        const limits = String(getEntrustCatalog(f.tables).get(32290, 'repeat').dungeon.challenge)
            .split('|')
            .map((part) => part.split('#').map(Number))
            .filter(([kind]) => kind === 3006)
            .map(([, seconds]) => seconds)
        f.tick(Math.max(...limits) + 1)
        kill(f, waves.at(-1).row.id)
        assert.equal(f.state().entrust.run.star, 0)
        assert.equal(savedMode(f).star_count, 1)
        assert.deepEqual(savedMode(f).star_progress, { version: 1, best_count: 0, best_mask: 0 })
        assert.equal(repeatStarTrustedCount(savedMode(f)), 0)
        // Source-only stage has no81002 reader; combined stage must report exactly zero.
        const value = f.game.activities.condition('81002|0|1', f.state(), 10001)
        const consumerEnabled = JSON.parse(
            fs.readFileSync(new URL('../configs/repeat-star-progress-policy.json', import.meta.url)),
        ).consumerEnabled
        assert.equal(value, consumerEnabled ? 0 : null)
        const model = f.state()
        for (const raw of [1, 2, 3, 7]) {
            model.repeatEvent.levels['10001:10101'].mode_save_data[0].star_count = raw
            assert.equal(
                repeatEntryPlan(
                    { tables: f.tables, state: model, activityCatalog: f.game.activities, now: f.game.clock() },
                    nextRequest,
                ).level,
                10102,
            )
        }
        model.repeatEvent.levels['10001:10101'].mode_save_data[0].star_progress = {
            version: 1,
            best_count: 0,
            best_mask: 7,
        }
        assert.throws(
            () =>
                repeatEntryPlan(
                    { tables: f.tables, state: model, activityCatalog: f.game.activities, now: f.game.clock() },
                    nextRequest,
                ),
            (error) => error.code === ErrorCode.GameConfig,
        )
        f.call('MultiCampaignQuit')
        f.call('RepeatEventEnterLevelReq', nextRequest)
        assert.equal(f.state().entrust.run.repeat_event.level, 10102)
        assert.equal(f.state().repeatEvent.levels['10001:10101'].mode_save_data[0].star_count, 1)
    } finally {
        f.store.close()
    }
})
