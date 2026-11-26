import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { conditionValue } from '../src/tasks.js'
import { guideGroupComplete, recordGuideStep } from '../src/guide-progress.js'
import { ErrorCode } from '../src/error-codes.js'

const config = configuration(),
    tables = new Tables(config.tables),
    protocol = new Protocol(config.base),
    group = tables
        .get('guide_group')
        .find(
            (row) =>
                row.isWorking === 1 &&
                row.triggerSource === 0 &&
                tables.get('guide').filter((step) => step.groupId === row.id).length >= 2,
        ),
    steps = tables
        .get('guide')
        .filter((row) => row.groupId === group.id)
        .map((row) => row.id),
    condition = { conditionId: 2504, __type_TaskConditionBaseData: { __type_TaskCondGuideData: { guideId: group.id } } }

function fixture(name) {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => 1800000000 }),
        session = {}
    let seq = 1
    const call = (name, value = {}, peer = session) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(peer, {
            id: e.id,
            seq: seq++,
            payload: e.req ? protocol.encode(e.req, value) : Buffer.alloc(0),
        })
    }
    const initial = call('EnterGame', { open_id: 'guide-candidate-' + name })
    return {
        store,
        game,
        session,
        call,
        initial,
        state: () => store.load(session.id).state,
        saved: () => store.load(session.id),
        login: () => call('EnterGame', { open_id: 'guide-candidate-' + name, reconnect: true }, {}),
    }
}
function coldStore(infos) {
    const values = new Map()
    for (const row of infos) {
        if (!values.has(row.id)) values.set(row.id, new Set())
        values.get(row.id).add(row.sub_id ?? 0)
    }
    return values
}
const reply = (id, packets) => protocol.decode(protocol.byId.get(id).rsp, packets.find((p) => p.id === id).payload)

test('new-profile guide switch matches current Native cold-login activation and actual5006 retains explicit preference without erasing history', () => {
    const f = fixture('skip')
    try {
        const player = reply(5001, f.initial).data
        assert.equal(player.basic_info.skip_guide, 0)
        assert.deepEqual(player.guide_infos.infos, [])
        assert.equal(player.basic_info.skip_guide == null || Number(player.basic_info.skip_guide) === 0, true)
        f.call('GuideUpdate', { id: group.id, sub_id: steps[0] })
        const before = structuredClone(f.state().player.guide_infos)
        f.call('SkipGuide', { u32: 1 })
        assert.equal(f.state().player.basic_info.skip_guide, 1)
        assert.deepEqual(f.state().guideSkipChoice, { version: 1, source: 'explicit-5006', value: 1, time: 1800000000 })
        assert.deepEqual(f.state().player.guide_infos, before)
        assert.equal(reply(5001, f.login()).data.basic_info.skip_guide, 1)
        f.call('SkipGuide', {})
        assert.equal(f.state().player.basic_info.skip_guide, 0, 'omitted uint32 uses the real protobuf getter default0')
        assert.deepEqual(f.state().player.guide_infos, before)
        const saved = f.saved()
        assert.throws(() => f.call('SkipGuide', { u32: 2 }), { code: ErrorCode.GuideSkipParamError })
        assert.deepEqual(f.saved(), saved)
    } finally {
        f.store.close()
    }
})

test('actual6701 preserves every current step, only step0 satisfies2504, and positive retries cannot erase complete history', () => {
    const f = fixture('steps')
    try {
        for (const step of steps.slice(0, 2)) {
            const frames = f.call('GuideUpdate', { id: group.id, sub_id: step })
            assert.deepEqual(reply(6701, frames), { id: group.id, sub_id: step, complete: true })
            assert.equal(conditionValue(condition, f.state()), 0)
        }
        const saved = f.state().player.guide_infos.infos.filter((row) => row.id === group.id)
        assert.equal(saved.length, 2)
        const cold = coldStore(reply(5001, f.login()).data.guide_infos.infos)
        assert(steps.slice(0, 2).every((id) => cold.get(group.id).has(id)))
        assert(!cold.get(group.id).has(0))
        f.call('GuideUpdate', { id: group.id, sub_id: 0 })
        assert.equal(conditionValue(condition, f.state()), 1)
        f.call('GuideUpdate', { id: group.id, sub_id: steps[0] })
        f.call('GuideUpdate', { id: group.id, sub_id: steps[1] })
        assert.equal(f.state().player.guide_infos.infos.filter((row) => row.id === group.id).length, 3)
        assert(guideGroupComplete(f.state(), group.id))
        assert(coldStore(reply(5001, f.login()).data.guide_infos.infos).get(group.id).has(0))
    } finally {
        f.store.close()
    }
})

test('current group/step validation uses dedicated codes and preserves historical records outside the present catalog', () => {
    const f = fixture('validation')
    try {
        const unknown = 0xffffffff,
            other = tables.get('guide').find((row) => row.groupId !== group.id)
        for (const [data, code] of [
            [{ id: 0, sub_id: 0 }, ErrorCode.GuideGroupConfFail],
            [{ id: unknown, sub_id: 0 }, ErrorCode.GuideGroupConfFail],
            [{ id: group.id, sub_id: unknown }, ErrorCode.GuideConfFail],
            [{ id: group.id, sub_id: other.id }, ErrorCode.GuideConfFail],
        ]) {
            const before = f.saved()
            assert.throws(() => f.call('GuideUpdate', data), { code })
            assert.deepEqual(f.saved(), before)
        }
        const state = f.state(),
            history = { id: unknown, sub_id: 123, complete: true }
        state.player.guide_infos.infos.push(history)
        recordGuideStep(tables, state, { id: group.id, sub_id: steps[0] })
        assert.deepEqual(
            state.player.guide_infos.infos.find((row) => row.id === unknown),
            history,
        )
        const before = structuredClone(state)
        assert.throws(() => recordGuideStep(tables, state, { id: group.id, sub_id: -1 }), {
            code: ErrorCode.GuideConfFail,
        })
        assert.deepEqual(state, before)
    } finally {
        f.store.close()
    }
})

test('6701 response codec and real SQLite failures roll back every step and preference, with legal retry preserved', () => {
    const f = fixture('rollback'),
        encode = protocol.encode
    try {
        const before = f.saved()
        protocol.encode = function (name, value) {
            if (name === protocol.byId.get(6701).rsp) throw Error('guide-codec-failure')
            return encode.call(this, name, value)
        }
        assert.throws(() => f.call('GuideUpdate', { id: group.id, sub_id: steps[0] }), /guide-codec-failure/)
        assert.deepEqual(f.saved(), before)
        protocol.encode = encode
        f.store.db.exec(
            "CREATE TEMP TRIGGER fail_guide BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'guide-SQL-failure'); END",
        )
        assert.throws(() => f.call('GuideUpdate', { id: group.id, sub_id: steps[0] }), /guide-SQL-failure/)
        assert.deepEqual(f.saved(), before)
        assert.throws(() => f.call('SkipGuide', { u32: 1 }), /guide-SQL-failure/)
        assert.deepEqual(f.saved(), before)
        f.store.db.exec('DROP TRIGGER fail_guide')
        f.call('GuideUpdate', { id: group.id, sub_id: steps[0] })
        assert(coldStore(f.state().player.guide_infos.infos).get(group.id).has(steps[0]))
    } finally {
        protocol.encode = encode
        f.store.close()
    }
})
