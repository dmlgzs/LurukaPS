import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { abyssFixture } from './abyss-fixture.js'
import { battlePassAbyssRule, battlePassAbyssValue } from '../src/battle-pass-abyss.js'
import { battlePassTaskModel, battlePassTaskSnapshot, notifyBattlePassTasks } from '../src/battle-pass-tasks.js'
import { prepareBattlePass } from '../src/battle-pass.js'
import { abyssTables } from '../src/abyss-catalog.js'
import { activeAbyssRotation } from '../src/abyss-rotation.js'

import { taskId, levelId, current, enterTarget, clearRoom } from './battle-pass-abyss-fixture.js'

test('full current13111 fixed-task family reads passed status and rejects rolling or unknown selectors', () => {
    const f = abyssFixture('pass-abyss-shape')
    try {
        const model = battlePassTaskModel(f.tables)
        assert.equal(model.rows.filter((row) => row.supported).length, 20)
        assert.deepEqual(
            model.rows.filter((row) => row.kind === 13111).map((row) => [row.id, row.supported]),
            [[taskId, true]],
        )
        assert.equal(current(f).curr_count, 0)
        for (const [row, tokens] of [
            [{ type: 1, param: 1 }, [13111, levelId]],
            [{ type: 2, param: 1 }, [13111, levelId]],
            [{ type: 3, param: 2 }, [13111, levelId]],
            [{ type: 3, param: 1 }, [13111, 999999]],
            [{ type: 3, param: 1 }, [13111, levelId, 1]],
        ])
            assert.equal(battlePassAbyssRule(f.tables, row, tokens), false)
        const state = structuredClone(f.state())
        state.abyss = {
            modes: {
                2: {
                    levels: { [levelId]: { passed: false, win_count: 999, star_num: 3, pass_level_reward_flag: true } },
                },
            },
        }
        assert.equal(battlePassAbyssValue(f.tables, state, levelId, f.time.now), 0)
        state.abyss.modes[2].levels[levelId].passed = true
        assert.equal(battlePassAbyssValue(f.tables, state, levelId, f.time.now), 1)
        const rotation = activeAbyssRotation(abyssTables(f.tables), f.time.now)
        const rotatingLevel = Number(String(rotation.level).split('|')[0])
        state.abyss.rotation = { id: rotation.id - 1, levels: { [rotatingLevel]: { passed: true } } }
        assert.equal(battlePassAbyssValue(f.tables, state, rotatingLevel, f.time.now), 0)
        state.abyss.rotation.id = rotation.id
        assert.equal(battlePassAbyssValue(f.tables, state, rotatingLevel, f.time.now), 1)
    } finally {
        f.store.close()
    }
})

test('actual two-room20005 clears unlock fixed battle-pass task; rewards roll back and persist without weekly XP or duplicate awards', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pass-abyss-'))
    const file = path.join(dir, 'state.sqlite')
    let f = abyssFixture('pass-abyss-producer', file)
    try {
        enterTarget(f)
        assert.equal(current(f).state, 0)
        clearRoom(f)
        assert.equal(f.state().abyss.modes[2].levels[levelId].passed, false)
        assert.equal(current(f).curr_count, 0)
        f.call('AbyssChallengeNext')
        f.call('AbyssChallengeRealStart')
        const encodeEnd = f.p.encode
        let beforeLastHit
        f.p.encode = function (name, ...args) {
            if (name.replace(/^cs\./, '') === 'SCAbyssDungeonEndSync') throw Error('abyss pass completion codec')
            return encodeEnd.call(this, name, ...args)
        }
        try {
            assert.throws(
                () =>
                    clearRoom(f, () => {
                        beforeLastHit = structuredClone(f.state())
                    }),
                /abyss pass completion codec/,
            )
            assert.deepEqual(f.state(), beforeLastHit)
            assert.equal(current(f).curr_count, 0)
        } finally {
            f.p.encode = encodeEnd
        }
        clearRoom(f)
        assert.equal(f.state().abyss.modes[2].levels[levelId].passed, true)
        assert.equal(current(f).state, 1)
        // Completion occurs in the battle fast path; ordinary quit publishes
        // the newly changed property without requiring a claimant self-report.
        const quit = f.call('AbyssChallengeQuit')
        const update = quit.find((packet) => packet.id === 18006)
        assert(update)
        assert.equal(
            f.p.decode('SCBattlePassBatchTaskSync', update.payload).one_task.find((row) => row.task_id === taskId)
                .state,
            1,
        )
        const before = structuredClone(f.state())
        const encode = f.p.encode
        for (const type of ['Rewards', 'SCBattlePassBatchTaskSync']) {
            f.p.encode = function (name, ...args) {
                if (name.replace(/^cs\./, '') === type) throw Error('abyss pass claim codec')
                return encode.call(this, name, ...args)
            }
            assert.throws(() => f.call('BattlePassGetTaskReward', { task_id: taskId }), /abyss pass claim codec/)
            assert.deepEqual(f.state(), before)
            f.p.encode = encode
        }
        const weekly = prepareBattlePass(f.tables, f.state(), f.time.now).ledger.curr_week_exp
        const reply = f.call('BattlePassGetTaskReward', { task_id: taskId }).find((packet) => packet.id === 18002)
        assert.deepEqual(
            f.p.decode('Rewards', reply.payload).rewards.map(({ itemid, itemnum }) => ({ itemid, itemnum })),
            [{ itemid: 50, itemnum: 2000 }],
        )
        assert.equal(prepareBattlePass(f.tables, f.state(), f.time.now).ledger.curr_week_exp, weekly)
        const earned = structuredClone(f.state().battlePass)
        assert.deepEqual(
            f.p.decode(
                'Rewards',
                f.call('BattlePassGetTaskReward', { task_id: taskId }).find((packet) => packet.id === 18002).payload,
            ).rewards,
            [],
        )
        f.store.close()
        f = abyssFixture('pass-abyss-producer', file, true)
        assert.equal(current(f).state, 2)
        assert.deepEqual(f.state().battlePass.seasons, earned.seasons)
        const other = abyssFixture('pass-abyss-other', file)
        try {
            assert.equal(current(other).state, 0)
        } finally {
            other.store.close()
        }
    } finally {
        f.store.close()
        assert.equal(path.dirname(dir), os.tmpdir())
        assert(path.basename(dir).startsWith('pass-abyss-'))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('same-length abyss property change invalidates task source; stable callbacks do not scan all24 task rows', () => {
    const f = abyssFixture('pass-abyss-source')
    try {
        const state = structuredClone(f.state())
        state.abyss = { modes: { 2: { levels: { [levelId]: { passed: false } } } } }
        const sent = []
        const c = { tables: f.tables, state, now: f.time.now, pushBefore: (name, data) => sent.push({ name, data }) }
        notifyBattlePassTasks(c)
        sent.length = 0
        const model = battlePassTaskModel(f.tables),
            rows = model.rows
        let reads = 0
        model.rows = new Proxy(rows, {
            get(target, key) {
                if (/^\d+$/.test(String(key))) reads++
                return Reflect.get(target, key)
            },
        })
        try {
            for (let i = 0; i < 200; i++) notifyBattlePassTasks(c)
            assert.equal(reads, 0)
            assert.equal(sent.length, 0)
            state.abyss.modes[2].levels[levelId].passed = true
            notifyBattlePassTasks(c)
            assert.equal(sent.length, 1)
            assert.equal(sent[0].data.one_task.find((row) => row.task_id === taskId).state, 1)
            notifyBattlePassTasks(c)
            assert.equal(sent.length, 1)
        } finally {
            model.rows = rows
        }
    } finally {
        f.store.close()
    }
})
