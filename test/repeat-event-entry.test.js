import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { getEntrustCatalog } from '../src/entrust.js'
import { repeatEventTables } from '../src/repeat-event.js'
import { ErrorCode } from '../src/error-codes.js'

const request = { activity: 10001, chapter: 101, level: 10101, mode: 1 }
function fixture(name, filename = ':memory:') {
    const config = configuration(),
        tables = new Tables(config.tables),
        protocol = new Protocol(config.base)
    const store = new Store(filename),
        session = {},
        game = new Game(protocol, store, tables, { clock: () => 1800000000 })
    let seq = 1
    const call = (name, data = {}, who = session) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(who, {
            id: e.id,
            seq: seq++,
            payload: e.req ? protocol.encode(e.req, data) : Buffer.alloc(0),
        })
    }
    call('EnterGame', { open_id: name })
    const state = () => store.load(session.id).state
    if (!(state().taskRecords ?? []).some((x) => x.task_id === 106015))
        store.transact(session.id, 0, (s) => {
            ;(s.taskRecords ??= []).push({ task_id: 106015, count: 1 })
            s.player.basic_info.lv = 45
        })
    const interact = (id) =>
        call('WorldObjInteract', {
            objs: [
                {
                    obj: {
                        obj_id: id,
                        complete: true,
                        state_data: {
                            step: state().worldObjects[state().world.map_id + ':' + id]?.state_data?.step ?? 0,
                        },
                    },
                    interact_type: 2,
                },
            ],
        })
    const kill = (id) => {
        const s = state(),
            enemies = Object.values(s.combat.entities).filter((x) => x.object_id === id)
        return call('BattleInfoReduce', {
            uint64_dic: [s.player.heros_info.heros[0].guid, ...enemies.map((x) => x.uuid)],
            battle_info: enemies.map((x, i) => ({
                hurt_info: { from_id: '1', tar_id: String(i + 2), hp_change: -x.hp },
            })),
            base_time: '0',
        })
    }
    return { config, tables, protocol, store, session, game, state, call, interact, kill }
}

test('all 12 real repeat levels map by their chest table and retain the marker, wave roster and final box', () => {
    const f = fixture('repeat-catalog')
    try {
        const current = repeatEventTables(f.tables),
            catalog = getEntrustCatalog(f.tables)
        assert.equal(current.get('repeat_event_level').length, 12)
        for (const level of current.get('repeat_event_level')) {
            const route = catalog.get(level.normalDungeonId),
                stages = catalog.stages(level.normalDungeonId)
            assert.equal(route.repeat.level.id, level.id)
            assert.equal(route.chest.worldFilter, '1|' + level.normalDungeonId)
            assert.equal(route.city.type, 2)
            assert.equal(stages[0].type, 13)
            assert.equal(stages.at(-1).type, 30)
            assert(stages.slice(1, -1).every((x) => x.type === 50))
            assert.equal(catalog.victoryObjects(level.normalDungeonId).length, stages.length - 2)
        }
    } finally {
        f.store.close()
    }
})

test('10502 exact logged request enters 6558 with real level and no fabricated pass or commission record', () => {
    const f = fixture('repeat-entry')
    try {
        const packets = f.call('RepeatEventEnterLevelReq', request),
            state = f.state()
        assert.equal(state.world.map_id, 6558)
        assert.equal(state.entrust.run.dungeon_id, 32290)
        assert.equal(state.entrust.run.kind, 'repeat')
        assert.equal(state.entrust.run.stage_index, 1)
        assert(!state.entrust.run.battle_complete)
        assert.deepEqual(state.entrust.records, {})
        assert.equal(state.repeatEvent, undefined)
        const ack = packets.find((x) => x.id === 10502)
        assert.equal(ack.payload.length, 0)
        const p = packets.find((x) => x.id === 9513)
        assert.equal(f.protocol.decode(f.protocol.byId.get(9513).rsp, p.payload).dungeon_id, 32290)
    } finally {
        f.store.close()
    }
})

test('two complete real waves create only repeat progress and leave paid chest explicitly pending', () => {
    const f = fixture('repeat-victory')
    try {
        f.call('RepeatEventEnterLevelReq', request)
        const stages = getEntrustCatalog(f.tables).stages(32290)
        f.call('MultiCampaignPlayerLoadFinish')
        f.interact(stages[0].row.id)
        assert.equal(f.state().entrust.run.stage_index, 2)
        for (const wave of stages.slice(1, -1)) {
            assert(Object.values(f.state().combat.entities).some((x) => x.object_id === wave.row.id && x.hp > 0))
            f.kill(wave.row.id)
        }
        assert.equal(f.state().entrust.run.battle_complete, true)
        assert.equal(f.state().repeatEvent.levels['10001:10101'].mode_save_data[0].win_count, 1)
        assert.equal(f.state().repeatEvent.levels['10001:10101'].mode_save_data[0].star_count, 3)
        assert.deepEqual(f.state().entrust.records, {})
        const before = structuredClone(f.state())
        assert.throws(
            () => f.call('StaminaBoxGet', { box_id: 3001001, times: 1 }),
            (e) => e.code === ErrorCode.FunctionClosed,
        )
        assert.deepEqual(f.state(), before)
        // A repeated client result cannot manufacture a second victory.
        f.call('EndDungeonScene', { result: 3 })
        assert.equal(f.state().repeatEvent.levels['10001:10101'].mode_save_data[0].win_count, 1)
    } finally {
        f.store.close()
    }
})

test('activity, chapter, mode and previous-level validation reject atomically with dedicated client error codes', () => {
    const f = fixture('repeat-reject')
    try {
        for (const [r, code] of [
            [{ ...request, activity: 999 }, ErrorCode.RepeatEventLevelInvalidActivityConf],
            [{ ...request, chapter: 999 }, ErrorCode.RepeatEventLevelInvalidChapterConf],
            [{ ...request, level: 999 }, ErrorCode.RepeatEventLevelInvalidLevelConf],
            [{ ...request, mode: 0 }, ErrorCode.RepeatEventLevelInvalidMode],
            [{ ...request, mode: 2 }, ErrorCode.RepeatEventLevelDisabled],
            [{ ...request, level: 10102 }, ErrorCode.RepeatEventLevelLocked],
        ]) {
            const before = structuredClone(f.state())
            assert.throws(
                () => f.call('RepeatEventEnterLevelReq', r),
                (e) => e.code === code,
            )
            assert.deepEqual(f.state(), before)
        }
        f.store.transact(f.session.id, 0, (s) => {
            s.taskRecords = []
        })
        assert.throws(
            () => f.call('RepeatEventEnterLevelReq', request),
            (e) => e.code === ErrorCode.RepeatEventLevelLocked,
        )
    } finally {
        f.store.close()
    }
})

test('entry packet encoder failure rolls back destination, instance sequence and pending run', () => {
    const f = fixture('repeat-rollback')
    try {
        const before = structuredClone(f.state()),
            encode = f.protocol.encode.bind(f.protocol)
        f.protocol.encode = (type, value) => {
            if (type === f.protocol.byId.get(9103).rsp) throw Error('wire failure')
            return encode(type, value)
        }
        assert.throws(() => f.call('RepeatEventEnterLevelReq', request), /wire failure/)
        assert.deepEqual(f.state(), before)
        f.protocol.encode = encode
        f.call('RepeatEventEnterLevelReq', request)
        assert.equal(f.state().entrust.run.instance_id, 1)
    } finally {
        f.store.close()
    }
})

test('SQLite close/reopen resumes the same entered wave without granting historical completion', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luruka-repeat-')),
        file = path.join(dir, 'state.sqlite')
    let f = fixture('repeat-sqlite', file)
    try {
        f.call('RepeatEventEnterLevelReq', request)
        const instance = f.state().entrust.run.instance_id
        f.store.close()
        f = fixture('repeat-sqlite', file)
        assert.equal(f.state().world.map_id, 6558)
        assert.equal(f.state().entrust.run.instance_id, instance)
        assert.equal(f.state().entrust.run.stage_index, 1)
        assert.equal(f.state().repeatEvent, undefined)
    } finally {
        f.store.close()
        fs.rmSync(file)
        fs.rmdirSync(dir)
    }
})
