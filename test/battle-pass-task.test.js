import { Tables } from '../src/player.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { achievementFixture } from './achievement-fixture.js'
import { prepareBattlePass } from '../src/battle-pass.js'
import {
    battlePassTaskSnapshot,
    battlePassTaskModel,
    notifyBattlePassTasks,
    recordBattlePassProgress,
    recordBattlePassAcquisition,
} from '../src/battle-pass-tasks.js'
import { recordActiveProgress } from '../src/daily-active.js'
import { grantRewards } from '../src/rewards.js'
import { ErrorCode } from '../src/error-codes.js'
test('battle pass login task awards season experience once without crediting a global currency50 balance', () => {
    const f = achievementFixture('pass-task-login')
    try {
        const login = f.protocol.decode('SCBattlePassSync', f.entryPackets.find((p) => p.id === 18000).payload)
        assert.equal(login.info.day_task.find((x) => x.task_id === 1001101).state, 1)
        const balance = f.state().player.attr_infos.attrs.find((x) => x.attr_id === 50)?.attr_val
        const packets = f.call('BattlePassGetTaskReward', { task_id: 1001101 }),
            reward = f.reply(packets, 18002)
        assert.equal(reward.rewards[0].itemid, 50)
        assert.equal(reward.rewards[0].itemnum, 300)
        const p = prepareBattlePass(f.tables, f.state(), 1800000000)
        assert.equal(p.ledger.level, 1)
        assert.equal(p.ledger.exp, 300)
        assert.equal(p.ledger.curr_week_exp, 300)
        assert.equal(f.state().player.attr_infos.attrs.find((x) => x.attr_id === 50)?.attr_val, balance)
        assert.deepEqual(f.reply(f.call('BattlePassGetTaskReward', { task_id: 1001101 }), 18002).rewards, [])
        assert.equal(packets.filter((p) => p.id === 18006).length, 1)
    } finally {
        f.store.close()
    }
})
test('battle pass manufacturing weekly count is independent of the capped daily-active count and periods reset at server calendar', () => {
    const f = achievementFixture('pass-task-week')
    try {
        f.store.transact(f.session.id, 0, (s) => {
            for (let i = 0; i < 12; i++) recordActiveProgress(f.tables, s, 15011, 1, 1800000000)
        })
        const data = battlePassTaskSnapshot(f.tables, f.state(), 1800000000)
        assert.equal(data.week_task.find((x) => x.task_id === 1001208).curr_count, 10)
        assert.equal(f.state().dailyActive.day.counts[15011], 1)
        assert.equal(f.reply(f.call('BattlePassGetTaskReward', { task_id: 1001208 }), 18002).rewards[0].itemnum, 600)
        let now = 1800000000 + 8 * 86400
        f.game.clock = () => now
        f.call('BattlePassGetTaskReward', { task_id: 1001101 })
        const p = prepareBattlePass(f.tables, f.state(), now)
        assert.equal(p.ledger.curr_week_exp, 300)
        assert.equal(
            battlePassTaskSnapshot(f.tables, f.state(), now).week_task.find((x) => x.task_id === 1001208).curr_count,
            0,
        )
    } finally {
        f.store.close()
    }
})
test('battle pass weekly cap clamps day/week XP but fixed story tasks are separate; unfinished and unsupported rules never auto-complete', () => {
    const f = achievementFixture('pass-task-cap')
    try {
        f.store.transact(f.session.id, 0, (s) => {
            prepareBattlePass(f.tables, s, 1800000000).ledger.curr_week_exp = 9950
        })
        assert.equal(f.reply(f.call('BattlePassGetTaskReward', { task_id: 1001101 }), 18002).rewards[0].itemnum, 50)
        f.completedTask(106015)
        assert.equal(f.reply(f.call('BattlePassGetTaskReward', { task_id: 1001301 }), 18002).rewards[0].itemnum, 2000)
        assert.equal(prepareBattlePass(f.tables, f.state(), 1800000000).ledger.curr_week_exp, 10000)
        assert.throws(
            () => f.call('BattlePassGetTaskReward', { task_id: 1001104 }),
            (e) => e.code === ErrorCode.BattlePassTaskNotFinished,
        )
        assert.throws(
            () => f.call('BattlePassGetTaskReward', { task_id: 1001203 }),
            (e) => e.code === ErrorCode.FunctionClosed,
        )
        assert.throws(
            () => f.call('BattlePassGetTaskReward', { task_id: 123 }),
            (e) => e.code === ErrorCode.BattlePassTaskNotFound,
        )
    } finally {
        f.store.close()
    }
})
test('battle pass real currency acquisition counts increments rather than owned stock and earned XP rolls back on codec failure', () => {
    const f = achievementFixture('pass-task-resource')
    try {
        f.store.transact(f.session.id, 0, (s) => {
            grantRewards(f.tables, s, [{ itemtype: 10, itemid: 10011, itemnum: 15000 }])
        })
        assert.equal(
            battlePassTaskSnapshot(f.tables, f.state(), 1800000000).forever_task.find((x) => x.task_id === 1001308)
                .state,
            1,
        )
        const before = f.state(),
            encode = f.protocol.encode.bind(f.protocol)
        f.protocol.encode = (type, value) => {
            if (type === 'cs.Rewards' && value?.rewards?.length) throw Error('task codec')
            return encode(type, value)
        }
        assert.throws(() => f.call('BattlePassGetTaskReward', { task_id: 1001308 }), /task codec/)
        f.protocol.encode = encode
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})
test('battle pass stable requests and irrelevant combat rewards do not rescan task rows, and event drafts preserve previous state', () => {
    const f = achievementFixture('pass-task-performance')
    try {
        const state = structuredClone(f.state()),
            c = { tables: f.tables, state, now: 1800000000, pushBefore: () => {} }
        notifyBattlePassTasks(c)
        const model = battlePassTaskModel(f.tables),
            rows = model.rows
        let reads = 0
        model.rows = new Proxy(rows, {
            get(target, key) {
                if (/^\d+$/.test(String(key))) reads++
                return Reflect.get(target, key)
            },
        })
        for (let i = 0; i < 300; i++) {
            notifyBattlePassTasks(c)
            recordBattlePassProgress(f.tables, state, 12002, 1, c.now)
            recordBattlePassAcquisition(f.tables, state, 10, 2, 1)
        }
        assert.equal(reads, 0)
        model.rows = rows
        const before = structuredClone(state),
            draft = { ...state }
        recordActiveProgress(f.tables, draft, 15014, 1, c.now)
        assert.deepEqual(state, before)
        assert.notDeepEqual(draft.battlePass, before.battlePass)
    } finally {
        f.store.close()
    }
})

test('battle pass duel task respects SystemUnlock visibility from its actual task-node table gate', () => {
    const f = achievementFixture('pass-task-duel-show')
    try {
        assert(!battlePassTaskSnapshot(f.tables, f.state(), 1800000000).week_task.some((x) => x.task_id === 1001207))
        f.completedTask(106010)
        f.store.transact(f.session.id, 0, (s) => recordActiveProgress(f.tables, s, 15071, 3, 1800000000))
        assert.equal(
            battlePassTaskSnapshot(f.tables, f.state(), 1800000000).week_task.find((x) => x.task_id === 1001207).state,
            1,
        )
        assert.equal(f.reply(f.call('BattlePassGetTaskReward', { task_id: 1001207 }), 18002).rewards[0].itemnum, 800)
    } finally {
        f.store.close()
    }
})

test('battle pass rollover resets weekly XP before constructing a purchase reply', () => {
    const f = achievementFixture('pass-task-buy-rollover')
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.player.basic_info.diamond = 1000
            prepareBattlePass(f.tables, s, 1800000000).ledger.curr_week_exp = 9950
        })
        f.game.clock = () => 1800000000 + 8 * 86400
        const packets = f.call('BattlePassBuyLevel', { u32: 1 }),
            info = f.protocol.decode('SCBattlePassLevelExpPaySync', packets.find((p) => p.id === 18010).payload)
        assert.equal(info.curr_week_exp, 0)
        assert.equal(info.level, 2)
    } finally {
        f.store.close()
    }
})

test('weekly-cap confirmation consumes a completed task without XP, while the maximum level is explicitly rejected', () => {
    const f = achievementFixture('pass-task-zero-xp')
    try {
        f.store.transact(f.session.id, 0, (s) => {
            prepareBattlePass(f.tables, s, 1800000000).ledger.curr_week_exp = 10000
        })
        assert.deepEqual(f.reply(f.call('BattlePassGetTaskReward', { task_id: 1001101 }), 18002).rewards, [])
        assert.equal(
            battlePassTaskSnapshot(f.tables, f.state(), 1800000000).day_task.find((x) => x.task_id === 1001101).state,
            2,
        )
        f.completedTask(106015)
        f.store.transact(f.session.id, 0, (s) => {
            prepareBattlePass(f.tables, s, 1800000000).ledger.level = 70
        })
        const before = f.state()
        assert.throws(
            () => f.call('BattlePassGetTaskReward', { task_id: 1001301 }),
            (e) => e.code === ErrorCode.BattlePassLevelExceeded,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})
test('one event increments duplicate future targets of the same period and kind only once', () => {
    const f = achievementFixture('pass-task-same-kind')
    try {
        const tables = new Tables(f.cfg.tables),
            rows = tables.get('battle_pass_task'),
            one = rows.find((r) => r.id === 1001104)
        tables.cache.set('battle_pass_task', [...rows, { ...one, id: 1999999, param: 2, condition: '13109|0|0|2' }])
        const state = structuredClone(f.state())
        recordBattlePassProgress(tables, state, 13109, 1, 1800000000)
        const data = battlePassTaskSnapshot(tables, state, 1800000000)
        assert.equal(data.day_task.find((x) => x.task_id === 1001104).state, 1)
        assert.equal(data.day_task.find((x) => x.task_id === 1999999).curr_count, 1)
        assert.equal(data.day_task.find((x) => x.task_id === 1999999).state, 0)
    } finally {
        f.store.close()
    }
})
