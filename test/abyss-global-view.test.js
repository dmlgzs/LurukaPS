import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { abyssFixture } from './abyss-fixture.js'
import { abyssTables } from '../src/abyss-catalog.js'
import { abyssGlobalView } from '../src/abyss-global-view.js'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { configTime } from '../src/shops.js'
import { ErrorCode } from '../src/error-codes.js'

const tables = abyssTables(new Tables(configuration().tables)),
    season = tables.get('abbys_time')[0],
    start = configTime(season.startTime) + 1,
    end = configTime(season.endTime)
const levelIds = (mode) =>
    String(mode === 3 ? season.level : tables.find('abbys_mode', mode).level)
        .split('|')
        .map(Number)
const completed = (mode, count = levelIds(mode).length) => ({
    levels: Object.fromEntries(
        levelIds(mode)
            .slice(0, count)
            .map((id) => [id, { passed: true, star_num: 3 }]),
    ),
    starClaims: [],
})
const unlocked = () => ({
    abyss: { modes: { 1: completed(1), 2: completed(2) }, rotation: { id: season.id, levels: {} } },
})

test('11454 ignores legacy/fake completion, does not create a ledger, and derives locked entry from the actual mode conditions', () => {
    const empty = {},
        before = structuredClone(empty),
        first = abyssGlobalView(tables, empty, start)
    assert.deepEqual(first, {
        rotation_id: season.id,
        rotation_mode_end_time: end,
        cur_level: 0,
        total_star: 0,
        inherit_notify_flag: false,
        mode: 1,
    })
    assert.deepEqual(empty, before)
    const old = {
        abyss: {
            cleared_levels: Object.fromEntries(
                [...levelIds(1), ...levelIds(2)].map((id) => [id, { completed: true, stars: 3 }]),
            ),
            rotations: { 1: { levels: { 30001: { completed: true, stars: 3 } } } },
            inherit_notify_flag: true,
        },
    }
    assert.deepEqual(abyssGlobalView(tables, old, start), first)
    const state = { abyss: { modes: { 1: completed(1, 6) } } }
    assert.equal(abyssGlobalView(tables, state, start).mode, 1)
    state.abyss.modes[1] = completed(1)
    assert.equal(abyssGlobalView(tables, state, start).mode, 2)
    state.abyss.modes[2] = completed(2, 6)
    assert.equal(abyssGlobalView(tables, state, start).mode, 2)
    state.abyss.modes[2] = completed(2)
    assert.equal(abyssGlobalView(tables, state, start).mode, 3)
})

test('11454 cur_level is completed rotation floor count; partial rooms and another rotation cannot supply stars or progress', () => {
    const state = unlocked()
    state.abyss.rotation = { id: season.id, ...completed(3, 2) }
    state.abyss.rotation.levels[30003] = { passed: false, star_num: 2, challenge_list: [{ win: true }, { win: false }] }
    const current = abyssGlobalView(tables, state, start)
    assert.equal(current.cur_level, 2)
    assert.equal(current.total_star, 6)
    assert.equal(current.rotation_mode_end_time, end)
    state.abyss.rotation.id = 99
    assert.equal(abyssGlobalView(tables, state, start).cur_level, 0)
    assert.equal(abyssGlobalView(tables, state, start).total_star, 0)
    state.abyss.rotation = { id: season.id, ...completed(3) }
    const all = abyssGlobalView(tables, state, start)
    assert.equal(all.cur_level, 7)
    assert.equal(all.total_star, 21)
})

test('11454 strict season closure and configured offline extension agree with 11450/11451 and do not reuse unrelated seasons', () => {
    const state = unlocked()
    state.abyss.rotation = { id: season.id, ...completed(3, 1) }
    assert.equal(abyssGlobalView(tables, state, start - 2).rotation_id, 0)
    const strict = abyssGlobalView(tables, state, end, { expiredRotation: 'closed' })
    assert.equal(strict.mode, 2)
    assert.equal(strict.rotation_id, 0)
    assert.equal(strict.cur_level, 0)
    assert.equal(strict.total_star, 0)
    const extended = abyssGlobalView(tables, state, end)
    assert.equal(extended.rotation_id, season.id)
    assert.equal(extended.cur_level, 1)
    assert.ok(extended.rotation_mode_end_time > end)
})

test('11454 switches to an actually configured future season without importing the former season floor or star totals', () => {
    const state = unlocked(),
        future = { ...season, id: season.id + 1, startTime: '20261015-040000', endTime: '20261115-040000' }
    state.abyss.rotation = { id: season.id, ...completed(3) }
    const fake = Object.create(tables)
    fake.get = (name) => (name === 'abbys_time' ? [season, future] : tables.get(name))
    const before = structuredClone(state),
        view = abyssGlobalView(fake, state, configTime(future.startTime) + 1)
    assert.equal(view.rotation_id, future.id)
    assert.equal(view.rotation_mode_end_time, configTime(future.endTime))
    assert.equal(view.cur_level, 0)
    assert.equal(view.total_star, 0)
    assert.deepEqual(state, before)
})

test('11454 rejects malformed star values, skipped completion holes and unsupported table conditions instead of clamping or guessing', () => {
    const bad = unlocked()
    bad.abyss.rotation.levels[30001] = { passed: true, star_num: 99 }
    assert.throws(
        () => abyssGlobalView(tables, bad, start),
        (e) => e.code === ErrorCode.GameConfig,
    )
    bad.abyss.rotation.levels = { 30002: { passed: true, star_num: 3 } }
    assert.throws(
        () => abyssGlobalView(tables, bad, start),
        (e) => e.code === ErrorCode.GameConfig,
    )
    const fake = Object.create(tables)
    fake.find = (name, id) =>
        name === 'abbys_mode' && id === 2
            ? { ...tables.find(name, id), condition: '99999#10007' }
            : tables.find(name, id)
    assert.throws(
        () => abyssGlobalView(fake, unlocked(), start),
        (e) => e.code === ErrorCode.FunctionClosed,
    )
})

test('11454 sends the real ledger and clears only the current notification flag with full codec rollback', () => {
    const f = abyssFixture('abyss-global-view-wire')
    try {
        f.time.now = start
        f.store.transact(f.session.id, 0, (s) => {
            s.abyss = unlocked().abyss
            s.abyss.rotation = { id: season.id, ...completed(3, 2) }
            s.abyss.inheritNotify = true
            s.abyss.inherit_notify_flag = true
        })
        const reply = () => f.decode(f.call('AbyssGlobalView'), 'CSProtoAbyssGlobalView')
        assert.equal(reply().cur_level, 2)
        assert.equal(reply().inherit_notify_flag, true)
        const initial = f.call('AbyssGlobalView'),
            dataIndex = initial.findIndex((p) => p.id === 11450),
            ackIndex = initial.findIndex((p) => p.id === 11454)
        assert.ok(dataIndex >= 0 && dataIndex < ackIndex)
        const full = f.decode(initial, 'SCProtoAbyssData')
        assert.equal(full.newer_mode_info.length, 7)
        assert.equal(full.persistent_mode_info.length, 7)
        assert.equal(full.rotation_mode_info.filter((row) => row.passed).length, 2)
        const before = f.state(),
            encode = f.p.encode.bind(f.p)
        for (const id of [11450, 11454]) {
            const schema = f.p.byId.get(id).rsp
            f.p.encode = (type, data) => {
                if (type === schema) throw Error('global view codec')
                return encode(type, data)
            }
            assert.throws(() => f.call('AbyssGlobalView', { clear_inherit_flag: true }), /global view codec/)
            assert.deepEqual(f.state(), before)
        }
        f.p.encode = encode
        const clear = f.decode(f.call('AbyssGlobalView', { clear_inherit_flag: true }), 'CSProtoAbyssGlobalView')
        assert.equal(clear.inherit_notify_flag, false)
        assert.equal(f.state().abyss.inheritNotify, false)
        assert.equal(f.state().abyss.inherit_notify_flag, true)
        assert.deepEqual(f.state().abyss.rotation, before.abyss.rotation)
    } finally {
        f.store.close()
    }
})

test('11454 survives SQLite close/reopen using the same actual current rotation record', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-abyss-view-')),
        file = path.join(folder, 'save.sqlite')
    let f = abyssFixture('abyss-view-sqlite', file)
    try {
        f.time.now = start
        f.store.transact(f.session.id, 0, (s) => {
            s.abyss = unlocked().abyss
            s.abyss.rotation = { id: season.id, ...completed(3, 3) }
        })
        f.store.close()
        f = abyssFixture('abyss-view-sqlite', file, true)
        f.time.now = start
        const view = f.decode(f.call('AbyssGlobalView'), 'CSProtoAbyssGlobalView')
        assert.equal(view.cur_level, 3)
        assert.equal(view.total_star, 9)
    } finally {
        f.store.close()
        assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir()))
        assert.ok(path.basename(folder).startsWith('lurukaps-abyss-view-'))
        fs.rmSync(folder, { recursive: true, force: true })
    }
})

test('11454 does not count a won half-room until the actual final half clears through combat reports', () => {
    const f = abyssFixture('abyss-view-real-battle')
    const clearRoom = () => {
        while (f.state().abyssRun.phase === 'running') {
            const s = f.state(),
                run = s.abyssRun,
                targets = Object.values(s.combat.entities).filter(
                    (e) => run.wave_objects.includes(e.object_id) && e.hp > 0,
                )
            assert.ok(targets.length)
            for (const target of targets)
                f.call('BattleInfoReduce', {
                    uint64_dic: [run.challenges[run.part_index].control, target.uuid],
                    battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -target.hp } }],
                })
        }
    }
    try {
        f.time.now = start
        f.store.transact(f.session.id, 0, (s) => {
            s.abyss = unlocked().abyss
        })
        const request = f.request(3, 30001),
            groups = String(tables.find('abbys_level', 30001).buffGroupid).split('|').map(Number)
        request.challenge_list.forEach((room, index) => {
            const choices = String(tables.find('abbys_buff_group', groups[index]).buffList).split('|').map(Number)
            room.buff_id = choices[index % choices.length]
        })
        f.call('AbyssChallenge', request)
        assert.equal(f.state().abyssRun.rooms.length, 2)
        f.call('AbyssChallengeRealStart')
        clearRoom()
        assert.equal(f.state().abyss.rotation.levels[30001].passed, false)
        let view = f.decode(f.call('AbyssGlobalView'), 'CSProtoAbyssGlobalView')
        assert.equal(view.cur_level, 0)
        assert.equal(view.total_star, 0)
        f.call('AbyssChallengeNext')
        f.call('AbyssChallengeRealStart')
        clearRoom()
        assert.equal(f.state().abyss.rotation.levels[30001].passed, true)
        view = f.decode(f.call('AbyssGlobalView'), 'CSProtoAbyssGlobalView')
        assert.equal(view.cur_level, 1)
        assert.equal(view.total_star, f.state().abyss.rotation.levels[30001].star_num)
        assert.equal(view.total_star, 3)
    } finally {
        f.store.close()
    }
})
