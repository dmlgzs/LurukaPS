import { repeatFixture as fixture } from './helpers/repeat-event-fixture.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getEntrustCatalog } from '../src/entrust.js'
import { repeatEventTables } from '../src/repeat-event.js'
import { ErrorCode } from '../src/error-codes.js'

const request = { activity: 10001, chapter: 101, level: 10101, mode: 1 }

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

test('two complete real waves create only repeat progress and allow the real free chest', () => {
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
        f.call('StaminaBoxGet', { box_id: 3001001, times: 1 })
        assert.equal(f.state().entrust.run.chest_claimed, true)
        assert.equal(f.state().repeatEvent.levels['10001:10101'].mode_save_data[0].free_stamina_used, true)
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
