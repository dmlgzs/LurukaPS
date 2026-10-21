import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'

test('10763 requires claimed children, grants once, unlocks the next table group and survives relogin', () => {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base),
        store = new Store(':memory:')
    const game = new Game(protocol, store, tables),
        session = {}
    let seq = 1
    const call = (name, data = {}, who = session) => {
        const e = protocol.byName.get('CSProto' + name)
        const packets = game.dispatch(who, { id: e.id, seq: seq++, payload: protocol.encode(e.req, data) })
        return { packets, result: protocol.decode(e.rsp, packets.find((p) => p.id === e.id).payload) }
    }
    const state = () => store.load(session.id).state
    try {
        call('EnterGame', { open_id: 'novice-groups' })
        assert.throws(
            () => call('NoviceTaskFinishGroup', { u32: 999 }),
            (e) => e.code === ErrorCode.NoviceTaskGroupConfNone,
        )
        assert.throws(
            () => call('NoviceTaskFinishGroup', { u32: 2 }),
            (e) => e.code === ErrorCode.NoviceTaskLock,
        )
        store.transact(session.id, 0, (s) => {
            s.player.basic_info.lv = 30
            s.player.heros_info.heros.forEach((h) => (h.hero_lv = 80))
            s.player.soulessence_infos.soulessences.forEach((e) => (e.lv = 80))
            s.pets.forEach((p) => (p.lv = 80))
            s.noviceCounters = { captures: 20, staminaSpent: 500 }
        })
        assert.throws(
            () => call('NoviceTaskFinishGroup', { u32: 1 }),
            (e) => e.code === ErrorCode.NoviceTaskGroupNotFinished,
        )
        for (const group of tables.get('novice_task_group').filter((g) => g.type === 1)) {
            for (const row of tables.get('novice_task').filter((t) => t.groupId === group.id)) {
                const r = call('NoviceTaskFinish', { u32: row.id }).result
                assert(r.rewards.length > 0)
            }
            const original = group.reward,
                before = structuredClone(state())
            try {
                group.reward = '3#4294967295#1'
                assert.throws(
                    () => call('NoviceTaskFinishGroup', { u32: group.id }),
                    (e) => e.code === ErrorCode.GameConfig,
                )
                assert.deepEqual(state(), before)
            } finally {
                group.reward = original
            }
            const { packets, result } = call('NoviceTaskFinishGroup', { u32: group.id })
            assert(result.rewards.length > 0)
            assert.equal(result.src, 93)
            const snapshot = protocol.decode(protocol.byId.get(10761).rsp, packets.find((p) => p.id === 10761).payload)
            assert(snapshot.groups.find((g) => g.group_id === group.id).finished)
            assert.deepEqual(call('NoviceTaskFinishGroup', { u32: group.id }).result.rewards, [])
        }
        call('EnterGame', { open_id: 'novice-groups' }, {})
        assert.deepEqual(call('NoviceTaskFinishGroup', { u32: 5 }).result.rewards, [])
        assert.equal(Object.keys(state().noviceTasks.claimedGroups).length, 5)
        assert.equal(Object.keys(state().noviceTasks.claimedTasks).length, 30)
    } finally {
        store.close()
    }
})
