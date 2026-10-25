import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { ActivityCatalog } from '../src/activities.js'
import { abyssTables } from '../src/abyss-catalog.js'
import { activityAbyssStarValue } from '../src/activity-abyss-star.js'
import { ErrorCode } from '../src/error-codes.js'
import { abyssFixture } from './abyss-fixture.js'
import { clearRoom } from './battle-pass-abyss-fixture.js'

const tables = new Tables(configuration().tables),
    catalog = new ActivityCatalog(tables),
    rows = catalog.rewards.filter((r) => String(r.finishCondition).startsWith('13123|')),
    row = rows[0],
    tokens = row.finishCondition.split('|').map(Number),
    target = tokens[1],
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-abyss-star-')),
    file = path.join(directory, 'state.sqlite'),
    name = 'activity-abyss-star-real-source',
    reward = (f) => f.call('ActivityReward', { activity_id: row.groupId, reward_id_list: [row.id] }),
    reply = (f, packets) => f.decode(packets, 'CSProtoActivityReward'),
    status = (f) =>
        f
            .decode(f.call('ActivityGet'), 'CSProtoActivitySync')
            .activitys.find((r) => r.id === row.groupId)
            .rewards.find((r) => r.id === row.id)

test('complete current13123 activity family uses configured permanent level, passed and maximum stars without counting receipts', () => {
    assert.equal(rows.length, 1)
    assert.deepEqual(tokens, [13123, 10007, 3])
    assert.equal(row.para, 1)
    assert(catalog.rows.some((r) => r.id === row.groupId && r.type === 131))
    const state = { abyss: { modes: { 1: { levels: { [target]: { passed: true, star_num: 3 } } } } } },
        before = structuredClone(state)
    assert.equal(activityAbyssStarValue(tables, state, tokens), 1)
    assert.deepEqual(state, before)
    for (const saved of [
        {},
        { passed: false, star_num: 3 },
        { passed: true, star_num: 2 },
        { star_num: 3 },
        { passed: true, win_count: 99, pass_level_reward_flag: true },
    ]) {
        const copy = structuredClone(state)
        copy.abyss.modes[1].levels[target] = saved
        assert.equal(activityAbyssStarValue(tables, copy, tokens), 0)
    }
    assert.equal(activityAbyssStarValue(tables, { activities: { [row.groupId]: { claims: [row.id] } } }, tokens), 0)
    assert.equal(
        activityAbyssStarValue(
            tables,
            { abyss: { modes: { 2: { levels: { [target]: { passed: true, star_num: 3 } } } } } },
            tokens,
        ),
        0,
    )
    for (const condition of [
        [13123, 0, 3],
        [13123, target, 0],
        [13123, target, 4],
        [13123, 0xffffffff, 3],
        [13123, target, 3, 1],
    ])
        assert.equal(activityAbyssStarValue(tables, state, condition), null)
    const scoped = abyssTables(tables),
        rotation = {
            ...scoped,
            abyss_scope: true,
            find: (name, id) =>
                name === 'abbys_level' && id === target ? { ...scoped.find(name, id), mode: 3 } : scoped.find(name, id),
        }
    assert.equal(activityAbyssStarValue(rotation, state, tokens), null)
    for (const saved of [
        null,
        [],
        { passed: null, star_num: 3 },
        { passed: true, star_num: null },
        { passed: true, star_num: 4 },
        { passed: true, star_num: '3' },
        { passed: true, star_num: NaN },
    ]) {
        const copy = structuredClone(state)
        copy.abyss.modes[1].levels[target] = saved
        assert.throws(
            () => activityAbyssStarValue(tables, copy, tokens),
            (e) => e.code === ErrorCode.GameConfig,
        )
    }
})

test('actual room battles produce the full family at three stars; activity ownership, codec and SQL failures roll back before one reward', () => {
    const f = abyssFixture(name, file)
    try {
        const current = abyssTables(f.tables),
            level = current.find('abbys_level', target),
            ids = String(current.find('abbys_mode', level.mode).level).split('|').map(Number),
            end = ids.indexOf(target)
        assert(end >= 0)
        const clear = (id, delay = 0) => {
            f.call('AbyssChallenge', f.request(level.mode, id))
            f.call('AbyssChallengeRealStart')
            f.time.now += delay
            clearRoom(f)
            f.call('AbyssChallengeQuit')
        }
        assert.equal(activityAbyssStarValue(f.tables, f.state(), tokens), 0)
        for (const id of ids.slice(0, end)) {
            clear(id)
            assert.equal(activityAbyssStarValue(f.tables, f.state(), tokens), 0)
        }
        clear(target, 121)
        assert.equal(f.state().abyss.modes[level.mode].levels[target].passed, true)
        assert.equal(f.state().abyss.modes[level.mode].levels[target].star_num, 2)
        assert.equal(status(f).state, 0)
        const below = f.store.load(f.session.id)
        assert.throws(() => reward(f), /conditions not complete/)
        assert.deepEqual(f.store.load(f.session.id), below)
        clear(target)
        assert.equal(f.state().abyss.modes[level.mode].levels[target].star_num, 3)
        assert.equal(status(f).val, 1)
        assert.equal(status(f).state, 1)
        const parent = catalog.rows.find((r) => r.id === row.groupId),
            prerequisite = Number(parent.condition.split('#')[1]),
            taskRecord = f.state().taskRecords.find((r) => r.task_id === prerequisite)
        assert(taskRecord)
        f.store.transact(f.session.id, 0, (s) => {
            s.taskRecords = s.taskRecords.filter((r) => r.task_id !== prerequisite)
        })
        const locked = f.store.load(f.session.id)
        assert.throws(() => reward(f), /locked/)
        assert.deepEqual(f.store.load(f.session.id), locked)
        f.store.transact(f.session.id, 0, (s) => s.taskRecords.push(taskRecord))
        const wrong = f.store.load(f.session.id)
        assert.throws(
            () => f.call('ActivityReward', { activity_id: row.groupId, reward_id_list: [100010101] }),
            /does not belong/,
        )
        assert.deepEqual(f.store.load(f.session.id), wrong)
        const before = f.store.load(f.session.id),
            originalEncode = f.p.encode.bind(f.p),
            sql = f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id)
        for (const type of [f.p.byName.get('CSProtoActivityReward').rsp, f.p.byName.get('CSProtoActivitySync').rsp]) {
            f.p.encode = (name, data) => {
                if (name === type) throw Error('abyss activity codec')
                return originalEncode(name, data)
            }
            assert.throws(() => reward(f), /abyss activity codec/)
            f.p.encode = originalEncode
            assert.deepEqual(f.store.load(f.session.id), before)
            assert.deepEqual(
                f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
                sql,
            )
        }
        f.store.db.exec(
            "CREATE TEMP TRIGGER abyss_activity_abort BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'abyss activity SQL'); END",
        )
        assert.throws(() => reward(f), /abyss activity SQL/)
        f.store.db.exec('DROP TRIGGER abyss_activity_abort')
        assert.deepEqual(f.store.load(f.session.id), before)
        const granted = reply(f, reward(f))
        assert(granted.rewards.length > 0)
        assert.equal(f.state().activities[row.groupId].claims.filter((id) => id === row.id).length, 1)
        assert.equal(status(f).state, 2)
        const claimed = f.state()
        assert.deepEqual(reply(f, reward(f)).rewards, [])
        assert.deepEqual(f.state(), claimed)
        clear(target, 121)
        assert.equal(
            f.state().abyss.modes[level.mode].levels[target].star_num,
            3,
            'the real later two-star run retains the actual earlier maximum',
        )
        assert.equal(activityAbyssStarValue(f.tables, f.state(), tokens), 1)
        assert.deepEqual(reply(f, reward(f)).rewards, [])
    } finally {
        f.store.close()
    }
})

test('real star source and activity reward remain idempotent after SQLite reopen and are isolated from another account', () => {
    const f = abyssFixture(name, file, true)
    try {
        assert.equal(activityAbyssStarValue(f.tables, f.state(), tokens), 1)
        assert.equal(status(f).state, 2)
        const before = f.state()
        assert.deepEqual(reply(f, reward(f)).rewards, [])
        assert.deepEqual(f.state(), before)
        const other = abyssFixture(name + '-other', file, true)
        try {
            assert.equal(activityAbyssStarValue(other.tables, other.state(), tokens), 0)
            const empty = other.store.load(other.session.id)
            assert.throws(() => reward(other))
            assert.deepEqual(other.store.load(other.session.id), empty)
            assert.deepEqual(f.state(), before)
        } finally {
            other.store.close()
        }
    } finally {
        f.store.close()
    }
})

test.after(() => {
    const resolved = fs.realpathSync(directory),
        parent = fs.realpathSync(os.tmpdir())
    assert.equal(path.dirname(resolved), parent)
    assert(path.basename(resolved).startsWith('activity-abyss-star-'))
    fs.rmSync(resolved, { recursive: true })
})
