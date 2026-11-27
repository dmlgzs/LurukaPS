import {
    fundCurrentCombatActors,
    qualifyCurrentCombatWorld,
    currentFixedGroup,
    currentCombatSeasonNow,
    qualifyCurrentEntrust,
} from './combat-normal-current-fixture.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Protocol } from '../src/protocol.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'
import { pairs } from '../src/battle.js'

const config = configuration(),
    tables = new Tables(config.tables),
    protocol = new Protocol(config.base)
function fixture(name) {
    const store = new Store(':memory:'),
        session = {},
        game = new Game(protocol, store, tables, { clock: () => 1800000000 })
    let seq = 1
    const call = (name, value = {}, uncheckedEnum = false) => {
        const entry = protocol.byName.get('CSProto' + name)
        const type = protocol.type(entry.req)
        return game.dispatch(session, {
            id: entry.id,
            seq: seq++,
            // Malformed enum values must reach the server decoder; the usual
            // public encoder rejects them before dispatch.
            payload: uncheckedEnum
                ? Buffer.from(type.encode(type.fromObject(value)).finish())
                : protocol.encode(entry.req, value),
        })
    }
    call('EnterGame', { open_id: name })
    store.transact(session.id, 0, (s) => {
        s.tasks = []
        fundCurrentCombatActors(tables, s)
    })
    const state = () => store.load(session.id).state,
        heroes = state().player.heros_info.heros
    assert(heroes.length >= 2)
    const element = tables.get('skillsub_ele_value').find((row) => row.elementId > 0)
    assert(element)
    const uniqueId = '9007199254740993',
        related = '9007199254740995',
        ids = [heroes[0].guid, heroes[1].guid, uniqueId, String(element.elementId), related]
    const report = (op, target = '1', extra = {}) =>
        call(
            'BattleInfoReduce',
            {
                base_time: '1800000000500',
                uint64_dic: ids,
                battle_info: [{ element_info: { op, tar_id: target, uniqueId: '3', ...extra } }],
            },
            op > 12,
        )
    const add = () =>
        report(1, '1', {
            verify_info: {
                battle_index: '9007199254740997',
                related_index: '5',
                source_type: 2,
                source_id: String(element.elementId),
                op_time: '15',
            },
            buff: { cfg_id: 4, attacker_id: '1', executor_id: '1', creator_id: '2', begin_time: '25', layer: 1 },
        })
    return { store, state, call, report, add, uniqueId, related, heroes, element }
}

test('current compressed element creation/update/delete preserves times, provenance and owner through replay', () => {
    const f = fixture('current-element-lifecycle')
    try {
        f.add()
        let saved = f.state().combat.elements[f.uniqueId]
        assert.equal(saved.buff.cfg_id, f.element.elementId)
        assert.equal(saved.buff.begin_time, '1800000000475')
        assert.equal(saved.verify_info.op_time, '1800000000485')
        assert.equal(saved.verify_info.related_index, f.related)
        assert.equal(
            saved.verify_info.source_id,
            String(f.element.elementId),
            'source_id is int64 provenance, not a dictionary index or actor GUID',
        )
        assert.equal(saved.buff.creator_id, f.heroes[1].guid)
        f.add()
        assert.equal(Object.keys(f.state().combat.elements).filter((id) => id === f.uniqueId).length, 1)
        f.report(3, '1', { buff: { layer: 2 } })
        assert.equal(f.state().combat.elements[f.uniqueId].buff.layer, 2)
        const before = structuredClone(f.state())
        for (const op of [1, 2, 3, 7, 10]) {
            assert.throws(
                () => f.report(op, '2', { buff: { cfg_id: 4, layer: 99 } }),
                (error) => error.code === ErrorCode.InvalidArgument,
            )
            assert.deepEqual(f.state(), before, 'another target cannot mutate or delete the existing element')
        }
        f.report(2)
        f.report(2)
        f.report(3, '1', { buff: { layer: 8 } })
        assert.equal(
            f.state().combat.elements[f.uniqueId],
            undefined,
            'change of a missing element never creates a fabricated buff',
        )
    } finally {
        f.store.close()
    }
})

test('enum-only BornElement11/RemoteDel12 remain strict for missing and existing elements instead of fabricating creation/deletion', () => {
    const f = fixture('current-element-enum-only')
    try {
        for (const exists of [false, true]) {
            if (exists) f.add()
            const before = structuredClone(f.state())
            for (const op of [11, 12, 13]) {
                for (const extra of [{}, { buff: { cfg_id: 4, layer: 1 } }]) {
                    assert.throws(
                        () => f.report(op, '1', extra),
                        (error) => error.code === (op <= 12 ? ErrorCode.FunctionClosed : ErrorCode.InvalidArgument),
                    )
                    assert.deepEqual(f.state(), before)
                }
            }
        }
    } finally {
        f.store.close()
    }
})

test('SWaitClient13 cannot authorize an unissued local item cast or treat its opaque source_id as another hero GUID', () => {
    const f = fixture('current-element-server-wait')
    try {
        const skill = tables.get('battlefield_item').flatMap((row) => [...pairs(row.skillList).values()])[0]
        assert(skill > 0)
        const request = {
            unit_id: '0',
            skill: { skill_id: skill, slot: 1 },
            op_time: '1800000000500',
            verify_info: { battle_index: '9007199254740997', source_type: 1, source_id: String(skill) },
        }
        f.call('SkillStart', request)
        const before = structuredClone(f.state())
        for (const source of ['-9007199254740993', f.heroes[1].guid]) {
            assert.throws(
                () =>
                    f.call('SkillStart', {
                        ...request,
                        verify_info: { ...request.verify_info, source_type: 13, source_id: source },
                    }),
                (error) => error.code === ErrorCode.FunctionClosed,
            )
            assert.deepEqual(f.state(), before)
        }
        assert.throws(
            () => f.call('SkillStart', { ...request, verify_info: { ...request.verify_info, source_type: 14 } }, true),
            (error) => error.code === ErrorCode.InvalidArgument,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})

test('a codec failure after a valid compressed element change rolls back both element and report-clock state', () => {
    const f = fixture('current-element-codec'),
        original = protocol.encode
    try {
        f.add()
        const before = structuredClone(f.state())
        protocol.encode = function (name, value) {
            if (name.endsWith('SCObjBattleInfoSync')) throw Error('injected-element-codec')
            return original.call(this, name, value)
        }
        assert.throws(
            () =>
                f.call('BattleInfoReduce', {
                    base_time: '1800000000900',
                    uint64_dic: [f.heroes[0].guid, f.uniqueId],
                    battle_info: [
                        { element_info: { op: 3, tar_id: '1', uniqueId: '2', buff: { layer: 9 } } },
                        { hurt_info: { from_id: '1', tar_id: '1', hp_change: -1 } },
                    ],
                }),
            /injected-element-codec/,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        protocol.encode = original
        f.store.close()
    }
})
