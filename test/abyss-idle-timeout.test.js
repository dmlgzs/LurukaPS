import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { abyssFixture } from './abyss-fixture.js'
import { abyssBattlePlan } from '../src/abyss-battle-config.js'
import { abyssTimeoutDue, expireAbyssTimeout } from '../src/abyss-battle.js'
import { ErrorCode } from '../src/error-codes.js'

function limit(f) {
    return abyssBattlePlan(f.tables, f.state().abyssRun.dungeon_id).limit
}
function tick(f, session = f.session) {
    return f.game.tick(f.session.id, session)
}
function db(f) {
    return f.store.db.prepare('select state,revision from players where account_id=?').get(f.session.id)
}
function endCount(packets) {
    return packets.filter((x) => x.id === 11461).length
}
function start(f) {
    f.call('AbyssChallenge', f.request())
    f.call('AbyssChallengeRealStart')
    tick(f)
}
function clearRoom(f) {
    while (f.state().abyssRun.phase === 'running') {
        const state = f.state(),
            run = state.abyssRun
        for (const target of Object.values(state.combat.entities).filter(
            (x) => run.wave_objects.includes(x.object_id) && x.hp > 0,
        ))
            f.call('BattleInfoReduce', {
                uint64_dic: [run.challenges[run.part_index].control, target.uuid],
                battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -target.hp } }],
            })
    }
    assert.equal(f.state().abyssRun.phase, 'won')
}

test('idle tick reaches the actual 2901 deadline without another combat request, persists one defeat and never fabricates dead enemies or rewards', () => {
    const f = abyssFixture('abyss-idle-deadline')
    try {
        start(f)
        const run = f.state().abyssRun,
            max = limit(f)
        f.time.now = run.real_start_time + max - 1
        assert.equal(endCount(tick(f)), 0)
        assert.equal(f.state().abyssRun.phase, 'running')
        const before = db(f),
            logs = f.store.db.prepare('select count(*) n from request_log').get().n
        f.time.now++
        const packets = tick(f),
            end = f.decode(packets, 'CSProtoAbyssDungeonEndSync'),
            state = f.state()
        assert.equal(endCount(packets), 1)
        assert.equal(end.state, 4)
        assert.equal(end.star, 0)
        assert.equal(end.cost_time, max)
        assert.equal(end.total_cost_time, max)
        assert.equal(state.abyssRun.phase, 'lost')
        assert.equal(state.abyss.modes[1].levels[10001].passed, false)
        assert.equal(state.abyss.modes[1].levels[10001].pass_level_reward_flag, false)
        assert(Object.values(state.combat.entities).every((x) => x.hp > 0))
        assert.equal(db(f).revision, before.revision + 1)
        assert.equal(f.store.db.prepare('select count(*) n from request_log').get().n, logs + 1)
        const settled = db(f)
        for (let n = 0; n < 8; n++) assert.equal(endCount(tick(f)), 0)
        assert.deepEqual(db(f), settled)
    } finally {
        f.store.close()
    }
})

test('boss intro excludes paused wall time and resumes the actual remaining countdown before an idle defeat', () => {
    const f = abyssFixture('abyss-idle-intro')
    try {
        f.store.transact(f.session.id, 0, (state) => {
            state.abyss = {
                modes: {
                    1: { levels: { 10007: { passed: true, star_num: 3 } } },
                    2: { levels: { 20006: { passed: true, star_num: 3 } } },
                },
            }
        })
        f.call('AbyssChallenge', f.request(2, 20007))
        f.call('AbyssChallengeRealStart')
        assert.equal(f.state().abyssRun.phase, 'intro')
        f.time.now += limit(f) * 3
        assert.equal(endCount(tick(f)), 0)
        assert.equal(f.state().abyssRun.phase, 'intro')
        const intro = f.state().abyssRun.intro
        f.call('AbyssBossIntroDone', { stage_id: intro.stage_id })
        const run = f.state().abyssRun,
            max = limit(f)
        f.time.now = run.real_start_time + max - 1
        assert.equal(endCount(tick(f)), 0)
        f.time.now++
        assert.equal(f.decode(tick(f), 'CSProtoAbyssDungeonEndSync').total_cost_time, max)
    } finally {
        f.store.close()
    }
})

test('later half idle timeout consumes the table total minus already won time and preserves the genuine first-half checkpoint', () => {
    const f = abyssFixture('abyss-idle-half')
    try {
        f.store.transact(f.session.id, 0, (state) => {
            state.abyss = { modes: { 1: { levels: { 10007: { passed: true, star_num: 3 } } } } }
        })
        f.call('AbyssChallenge', f.request(2, 20001))
        f.call('AbyssChallengeRealStart')
        f.time.now += 80
        clearRoom(f)
        f.call('AbyssChallengeNext')
        f.call('AbyssChallengeRealStart')
        const run = f.state().abyssRun,
            remaining = limit(f) - 80
        f.time.now = run.real_start_time + remaining
        const end = f.decode(tick(f), 'CSProtoAbyssDungeonEndSync')
        assert.equal(end.state, 4)
        assert.equal(end.cost_time, remaining)
        assert.equal(end.total_cost_time, limit(f))
        assert.equal(f.state().abyssRun.challenges[0].win, true)
        assert.equal(f.state().abyssRun.challenges[1].win, false)
        assert.equal(f.state().abyss.modes[2].levels[20001].passed, false)
    } finally {
        f.store.close()
    }
})

test('idle settlement codec failure rolls back run, world objects, progress and database; a subsequent tick settles once', () => {
    const f = abyssFixture('abyss-idle-codec')
    try {
        start(f)
        f.time.now += limit(f)
        const before = f.state(),
            saved = db(f),
            encode = f.p.encode.bind(f.p),
            type = f.p.byName.get('CSProtoAbyssDungeonEndSync').rsp
        f.p.encode = (t, value) => {
            if (t === type) throw Error('idle end codec')
            return encode(t, value)
        }
        assert.throws(() => tick(f), /idle end codec/)
        f.p.encode = encode
        assert.deepEqual(f.state(), before)
        assert.deepEqual(db(f), saved)
        assert.equal(endCount(tick(f)), 1)
        assert.equal(endCount(tick(f)), 0)
    } finally {
        f.store.close()
    }
})

test('only the latest successfully entered session may trigger idle settlement; absent, foreign and replaced sessions cannot send it', () => {
    const f = abyssFixture('abyss-idle-owner')
    try {
        start(f)
        f.time.now += limit(f)
        for (const session of [
            undefined,
            {},
            { ...f.session, entered: false },
            { ...f.session, id: f.session.id + 1 },
        ]) {
            assert.equal(endCount(f.game.tick(f.session.id, session)), 0)
            assert.equal(f.state().abyssRun.phase, 'running')
        }
        const replacement = {},
            entry = f.p.byName.get('CSProtoEnterGame')
        f.game.dispatch(replacement, {
            id: entry.id,
            seq: 1,
            payload: f.p.encode(entry.req, { open_id: f.session.openId }),
        })
        assert.equal(endCount(tick(f, f.session)), 0)
        assert.equal(f.state().abyssRun.phase, 'running')
        assert.equal(endCount(tick(f, replacement)), 1)
    } finally {
        f.store.close()
    }
})

test('ready, retired and replaced run stamps never settle, including an old deadline after retry or a different map', () => {
    const f = abyssFixture('abyss-idle-stale')
    try {
        f.call('AbyssChallenge', f.request())
        f.time.now += limit(f) * 2
        assert.equal(endCount(tick(f)), 0)
        f.call('AbyssChallengeRealStart')
        f.time.now += limit(f)
        const old = abyssTimeoutDue(f.tables, f.state(), f.time.now)
        f.call('AbyssChallengeRetry')
        f.call('AbyssChallengeRealStart')
        f.time.now += limit(f)
        const state = f.state(),
            before = structuredClone(state)
        assert.equal(
            expireAbyssTimeout(
                { tables: f.tables, state, now: f.time.now, push: () => assert.fail('stale push') },
                old,
            ),
            false,
        )
        assert.deepEqual(state, before)
        const differentMap = { ...state, world: { ...state.world, map_id: 100 } }
        assert.equal(abyssTimeoutDue(f.tables, differentMap, f.time.now), false)
        f.call('AbyssChallengeQuit')
        assert.equal(endCount(tick(f)), 0)
        assert.equal(f.state().abyssRun, undefined)
    } finally {
        f.store.close()
    }
})

test('periodic non-due checks and high-frequency hero/pet reports leave SQLite untouched until a real deadline', () => {
    const f = abyssFixture('abyss-idle-no-sql')
    try {
        start(f)
        const before = db(f),
            logs = f.store.db.prepare('select count(*) n from request_log').get().n
        const s = f.state(),
            run = s.abyssRun,
            enemy = Object.values(s.combat.entities).find((x) => run.wave_objects.includes(x.object_id))
        for (let i = 0; i < 20; i++) {
            const source = (i % 2 ? run.pets : run.heroes)[0].guid
            f.call('BattleInfoReduce', {
                uint64_dic: [source, enemy.uuid],
                battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -1 } }],
            })
            assert.equal(endCount(tick(f)), 0)
        }
        assert.deepEqual(db(f), before)
        assert.equal(f.store.db.prepare('select count(*) n from request_log').get().n, logs)
        assert.equal(f.state().combat.entities[enemy.uuid].hp, enemy.max_hp - 20)
    } finally {
        f.store.close()
    }
})

test('SQLite reconnect binds a fresh session and persists an idle defeat which never repeats after another reconnect', () => {
    const parent = path.resolve(os.tmpdir()),
        dir = fs.mkdtempSync(path.join(parent, 'abyss-idle-')),
        file = path.join(dir, 'state.sqlite')
    let f = abyssFixture('abyss-idle-sql', file)
    try {
        start(f)
        const run = f.state().abyssRun,
            deadline = run.real_start_time + limit(f)
        f.store.close()
        f = abyssFixture('abyss-idle-sql', file, true)
        f.time.now = deadline
        assert.equal(endCount(tick(f)), 1)
        f.store.close()
        f = abyssFixture('abyss-idle-sql', file, true)
        f.time.now = deadline + 20
        assert.equal(f.state().abyssRun.phase, 'lost')
        assert.equal(endCount(tick(f)), 0)
        assert.equal(f.state().abyss.modes[1].levels[10001].passed, false)
    } finally {
        f.store.close()
        if (path.dirname(path.resolve(dir)) !== parent || !path.basename(dir).startsWith('abyss-idle-'))
            throw Error('Unexpected cleanup target')
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('malformed saved timer fields cannot silently settle or produce NaN elapsed results', () => {
    const f = abyssFixture('abyss-idle-corrupt')
    try {
        start(f)
        for (const [key, value] of [
            ['real_start_time', undefined],
            ['real_start_time', -1],
            ['total_battle_time', NaN],
        ]) {
            const state = f.state()
            state.abyssRun[key] = value
            assert.throws(
                () => abyssTimeoutDue(f.tables, state, f.time.now),
                (e) => e.code === ErrorCode.GameConfig,
            )
        }
        assert.equal(f.state().abyssRun.phase, 'running')
    } finally {
        f.store.close()
    }
})
