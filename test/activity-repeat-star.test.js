import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { ActivityCatalog } from '../src/activities.js'
import { battlePassTaskModel, battlePassTaskSnapshot } from '../src/battle-pass-tasks.js'
import { ErrorCode } from '../src/error-codes.js'
import { activityRepeatStarValue, activityRepeatNormalRoute } from '../src/activity-repeat-star.js'
import { repeatEventTables } from '../src/repeat-event.js'
import { getEntrustCatalog } from '../src/entrust.js'
import { repeatFixture } from './helpers/repeat-event-fixture.js'
import { activityCurrencyBalance } from '../src/activity-drop-currency.js'

const tables = new Tables(configuration().tables)
const catalog = new ActivityCatalog(tables)
const rewards = catalog.rewards
    .filter((row) => String(row.finishCondition).startsWith('81002|'))
    .sort((a, b) => a.para - b.para)
const parentId = rewards[0].groupId
const decode = (f, name, packets) => {
    const entry = f.protocol.byName.get('CSProto' + name)
    return f.protocol.decode(entry.rsp, packets.find((packet) => packet.id === entry.id).payload)
}
const claim = (f, rows) =>
    f.call('ActivityReward', { activity_id: parentId, reward_id_list: rows.map((row) => row.id) })
const status = (f) =>
    decode(f, 'ActivitySync', f.call('ActivityGet')).activitys.find((row) => row.id === parentId).rewards
function play(f, levelId, slow = false, restart = false) {
    if (f.state().entrust?.run && !restart) f.call('MultiCampaignQuit')
    const current = repeatEventTables(f.tables)
    const level = current.find('repeat_event_level', levelId)
    const chapter = current.get('repeat_event_chapter').find((row) => row.levelGroup === level.group)
    f.call(restart ? 'RepeatEventReEnterLevelReq' : 'RepeatEventEnterLevelReq', {
        activity: parentId,
        chapter: chapter.id,
        level: levelId,
        mode: 1,
    })
    f.call('MultiCampaignPlayerLoadFinish')
    const stages = getEntrustCatalog(f.tables).stages(level.normalDungeonId)
    f.interact(stages[0].row.id)
    if (slow) f.tick(300)
    for (const wave of stages.filter((row) => row.type === 50)) f.kill(wave.row.id)
}

test('complete six81002 rules use parent membership and distinct v1 three-star levels, never legacy/scalar/wins or star sums', () => {
    assert.equal(rewards.length, 6)
    assert.deepEqual(
        rewards.map((row) => row.finishCondition.split('|').map(Number)),
        [1, 2, 3, 4, 5, 6].map((target) => [81002, 0, target]),
    )
    assert(rewards.every((row) => row.groupId === parentId && row.para === Number(row.finishCondition.split('|')[2])))
    const normal = (levelId, source, raw = 3) => ({
        event_id: parentId,
        level_id: levelId,
        mode_save_data: [
            { mode: 1, star_count: raw, win_count: 999, ...(source === undefined ? {} : { star_progress: source }) },
        ],
    })
    const state = {
        player: { basic_info: { id: 93001 } },
        repeatEvent: {
            levels: {
                [`${parentId}:10101`]: normal(10101),
                [`${parentId}:10102`]: normal(10102, { version: 1, best_count: 2, best_mask: 3 }),
            },
        },
    }
    const rule = [81002, 0, 1]
    assert.equal(activityRepeatStarValue(tables, state, rule, parentId), 0)
    assert.equal(activityRepeatStarValue(tables, state, rule), null)
    assert.equal(activityRepeatStarValue(tables, state, rule, 70002), null)
    for (const invalid of [
        [81002, 1, 1],
        [81002, 0, 0],
        [81002, 0, 1, 2],
        [81001, 0, 1],
    ])
        assert.equal(activityRepeatStarValue(tables, state, invalid, parentId), null)
    state.repeatEvent.levels['99999:10101'] = normal(10101, { version: 1, best_count: 3, best_mask: 7 })
    assert.equal(activityRepeatStarValue(tables, state, rule, parentId), 0)
    state.repeatEvent.levels[`${parentId}:10101`] = normal(10101, { version: 1, best_count: 3, best_mask: 7 })
    state.repeatEvent.levels[`${parentId}:010101`] = normal(10101, { version: 1, best_count: 3, best_mask: 7 })
    assert.equal(activityRepeatStarValue(tables, state, rule, parentId), 1)
    const before = structuredClone(state)
    assert.equal(catalog.condition('81002|0|1', state, parentId), 1)
    assert.deepEqual(state, before)
    const bad = structuredClone(state)
    bad.repeatEvent.levels[`${parentId}:10101`].mode_save_data[0].star_progress.best_mask = 3
    assert.throws(
        () => activityRepeatStarValue(tables, bad, rule, parentId),
        (error) => error.code === ErrorCode.GameConfig,
    )
    const duplicate = structuredClone(state)
    duplicate.repeatEvent.levels[`${parentId}:10101`].mode_save_data.push({ mode: 1, win_count: 1 })
    assert.throws(
        () => activityRepeatStarValue(tables, duplicate, rule, parentId),
        (error) => error.code === ErrorCode.GameConfig,
    )
    const wrongIdentity = structuredClone(state)
    wrongIdentity.repeatEvent.levels[`${parentId}:10101`].level_id++
    assert.throws(
        () => activityRepeatStarValue(tables, wrongIdentity, rule, parentId),
        (error) => error.code === ErrorCode.GameConfig,
    )
    state.repeatEvent.levels[`${parentId}:10101`] = normal(10101, { version: 2, best_count: 3, best_mask: 7 })
    assert.equal(activityRepeatStarValue(tables, state, rule, parentId), 0)
    const current = repeatEventTables(tables).get('repeat_event_level')[0]
    assert.equal(activityRepeatNormalRoute(current), true)
    assert.equal(activityRepeatNormalRoute({ ...current, isHardOpen: 1, hardDungeonId: 32291 }), false) // Synthetic future boundary only.
})

test('actual first six configured levels reach every reward tier once, while two-star wins and incomplete mixed batches do not grant', () => {
    const f = repeatFixture('activity-repeat-star-six')
    try {
        f.store.transact(f.session.id, 0, (state) => {
            state.player.attr_infos.attrs.push({ attr_id: 10011, attr_val: '777' })
        })
        const levels = repeatEventTables(f.tables).get('repeat_event_level').slice(0, 6)
        play(f, levels[0].id, true)
        assert.equal(status(f).find((row) => row.id === rewards[0].id).val, 0)
        assert.throws(
            () => claim(f, [rewards[0]]),
            (error) => error.code === ErrorCode.InvalidArgument,
        )
        play(f, levels[0].id, false, true)
        const beforeMixed = f.state()
        assert.throws(
            () => claim(f, rewards.slice(0, 2)),
            (error) => error.code === ErrorCode.InvalidArgument,
        )
        assert.deepEqual(f.state(), beforeMixed)
        for (let index = 0; index < levels.length; index++) {
            if (index > 0) play(f, levels[index].id)
            const entry = status(f).find((row) => row.id === rewards[index].id)
            assert.equal(entry.val, index + 1)
            assert.equal(entry.state, 1)
            const packets = claim(f, [rewards[index]])
            const reply = decode(f, 'ActivityReward', packets)
            assert(reply.rewards.length > 0)
            assert.equal(activityCurrencyBalance(f.state(), parentId, 10011), String((index + 1) * 200))
            assert.equal(f.state().player.attr_infos.attrs.find((row) => row.attr_id === 10011).attr_val, '777')
            const playerDelta = decode(f, 'SyncPlayerData', packets)
            assert.equal(
                playerDelta.attr_infos.act_attrs.find((row) => row.event_id === parentId).attr.attr_val,
                String((index + 1) * 200),
            )
            assert.equal(f.state().activities[parentId].claims.filter((id) => id === rewards[index].id).length, 1)
        }
        assert.equal(f.game.activities.condition('81002|0|6', f.state(), parentId), 6)
        const before = f.state()
        assert.deepEqual(decode(f, 'ActivityReward', claim(f, [...rewards, rewards[0]])).rewards, [])
        assert.deepEqual(f.state().player, before.player)
        assert.deepEqual(f.state().items, before.items)
        assert.equal(f.state().activities[parentId].claims.length, 6)
        const bpModel = battlePassTaskModel(f.tables)
        assert.equal(bpModel.rows.length, 24)
        assert.equal(bpModel.rows.filter((row) => row.supported).length, bpModel.rows.length)
        assert.equal(bpModel.rows.find((row) => row.kind === 81000).supported, true)
        assert.equal(
            battlePassTaskSnapshot(f.tables, f.state(), f.game.clock()).forever_task.find(
                (row) => row.task_id === 1001309,
            ).curr_count,
            1,
        )
        play(f, levels[0].id)
        assert.equal(f.game.activities.condition('81002|0|6', f.state(), parentId), 6)
    } finally {
        f.store.close()
    }
})

test('actual10405 parent ownership, reward/sync codec and SQL failures roll back; reopen/other-account/legacy claimed terminal stay isolated', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-repeat-star-'))
    const filename = path.join(directory, 'probe.sqlite')
    let f = repeatFixture('activity-repeat-star-atomic', filename)
    try {
        play(f, 10101)
        status(f)
        const before = f.state()
        assert.throws(
            () => f.call('ActivityReward', { activity_id: 60001, reward_id_list: [rewards[0].id] }),
            (error) => error.code === ErrorCode.InvalidArgument,
        )
        assert.deepEqual(f.state(), before)
        const originalEncode = f.protocol.encode
        for (const name of ['CSProtoActivityReward', 'CSProtoActivitySync']) {
            const type = f.protocol.byName.get(name).rsp
            f.protocol.encode = function (encoding, payload) {
                if (encoding === type) throw Error('activity-repeat-star-codec')
                return originalEncode.call(this, encoding, payload)
            }
            try {
                assert.throws(() => claim(f, [rewards[0]]), /activity-repeat-star-codec/)
            } finally {
                f.protocol.encode = originalEncode
            }
            assert.deepEqual(f.state(), before)
        }
        assert(Number.isSafeInteger(f.session.id) && f.session.id > 0)
        f.store.db.exec(
            `CREATE TEMP TRIGGER activity_repeat_star_abort BEFORE UPDATE ON players WHEN OLD.account_id=${f.session.id} BEGIN SELECT RAISE(ABORT,'activity-repeat-star-SQL'); END`,
        )
        try {
            assert.throws(() => claim(f, [rewards[0]]), /activity-repeat-star-SQL/)
        } finally {
            f.store.db.exec('DROP TRIGGER activity_repeat_star_abort')
        }
        assert.deepEqual(f.state(), before)
        assert(decode(f, 'ActivityReward', claim(f, [rewards[0]])).rewards.length > 0)
        assert.equal(activityCurrencyBalance(f.state(), parentId, 10011), '200')
        f.store.close()
        f = repeatFixture('activity-repeat-star-atomic', filename)
        assert.equal(status(f).find((row) => row.id === rewards[0].id).state, 2)
        assert.equal(activityCurrencyBalance(f.state(), parentId, 10011), '200')
        f.store.transact(f.session.id, 0, (state) => {
            delete state.repeatEvent.levels[`${parentId}:10101`].mode_save_data[0].star_progress
        })
        assert.equal(f.game.activities.condition('81002|0|1', f.state(), parentId), 0)
        const originalPlayer = f.state().player
        assert.deepEqual(decode(f, 'ActivityReward', claim(f, [rewards[0]])).rewards, [])
        assert.deepEqual(f.state().player, originalPlayer)
        const other = repeatFixture('activity-repeat-star-other', filename)
        try {
            assert.equal(other.game.activities.condition('81002|0|1', other.state(), parentId), 0)
            assert.throws(
                () => claim(other, [rewards[0]]),
                (error) => error.code === ErrorCode.InvalidArgument,
            )
        } finally {
            other.store.close()
        }
    } finally {
        f.store.close()
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()))
        assert(path.basename(directory).startsWith('activity-repeat-star-'))
        fs.rmSync(directory, { recursive: true, force: true })
    }
})
