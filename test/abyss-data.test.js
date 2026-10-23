import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { configTime } from '../src/shops.js'
import { abyssDataSnapshot } from '../src/abyss-data.js'
import { ErrorCode } from '../src/error-codes.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
test('11449 answers unplayed levels and the explicitly extended existing offline rotation without granting progress or rewards', () => {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => 1800000000 }),
        session = {}
    let seq = 1
    const call = (n, r = {}) => {
        const e = protocol.byName.get('CSProto' + n)
        return game.dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, r) })
    }
    try {
        call('EnterGame', { open_id: 'abyss-query' })
        const before = store.load(session.id).state
        const response = call('AbyssData').find((p) => p.id === 11449),
            data = protocol.decode(protocol.byId.get(11449).rsp, response.payload)
        assert.equal(data.newer_mode_info.length, 7)
        assert.equal(data.persistent_mode_info.length, 7)
        assert.equal(data.rotation_mode_info.length, 7)
        assert.equal(data.rotation_id, tables.get('abbys_time')[0].id)
        assert(data.rotation_mode_info.every((r) => !r.passed && r.star_num === 0 && !r.pass_level_reward_flag))
        assert(data.newer_mode_info.every((r) => !r.passed && !r.pass_level_reward_flag && r.star_num === 0))
        assert(data.newer_star_reward_info.reward_list.every((r) => !r.reward_flag))
        const after = store.load(session.id).state
        assert.equal(after.abyss, undefined)
        assert.deepEqual(after.player, before.player)
        assert.deepEqual(after.taskRecords, before.taskRecords)
    } finally {
        store.close()
    }
})
test('abyss query preserves actual saved progress and isolates current rotation from old-season records', () => {
    const season = tables.get('abbys_time')[0],
        start = configTime(season.startTime),
        end = configTime(season.endTime)
    const state = {
        abyss: {
            modes: {
                1: {
                    levels: {
                        10001: {
                            passed: true,
                            star_num: 2,
                            pass_level_reward_flag: true,
                            challenge_list: [],
                            task_tags_list: [{ tag_type: 3006, tag_progress: '120', status: 2 }],
                        },
                    },
                    starClaims: [3],
                },
            },
            rotation: { id: season.id, levels: { 30001: { passed: true, star_num: 3 } }, starClaims: [3] },
        },
    }
    const before = structuredClone(state),
        current = abyssDataSnapshot(tables, state, start)
    assert.equal(current.rotation_id, season.id)
    assert.equal(current.rotation_mode_end_time, end)
    assert.equal(current.newer_mode_info[0].star_num, 2)
    assert.equal(current.newer_mode_info[0].pass_level_reward_flag, true)
    assert.equal(current.newer_star_reward_info.reward_list.find((r) => r.stage_num === 3).reward_flag, true)
    assert.equal(current.rotation_mode_info[0].passed, true)
    assert.deepEqual(state, before)
    const wrong = structuredClone(state)
    wrong.abyss.rotation.id++
    assert.equal(abyssDataSnapshot(tables, wrong, start).rotation_mode_info[0].passed, false)
    assert.deepEqual(abyssDataSnapshot(tables, state, end, { expiredRotation: 'closed' }).rotation_mode_info, [])
    assert.equal(abyssDataSnapshot(tables, state, start - 1).rotation_id, 0)
})
test('abyss query distinguishes unavailable configuration and malformed saved numeric progress', () => {
    const fake = Object.create(tables)
    fake.find = (n, id) => (n === 'abbys_level' ? undefined : tables.find(n, id))
    assert.throws(
        () => abyssDataSnapshot(fake, {}, 1800000000),
        (e) => e.code === ErrorCode.AbyssInvalidLevel,
    )
    assert.throws(
        () =>
            abyssDataSnapshot(tables, { abyss: { modes: { 1: { levels: { 10001: { star_num: 99 } } } } } }, 1800000000),
        (e) => e.code === ErrorCode.GameConfig,
    )
})
