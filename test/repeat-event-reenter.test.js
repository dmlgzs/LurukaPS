import test from 'node:test'
import assert from 'node:assert/strict'
import { ornamentFixture } from './helpers/ornament-fixture.js'
import { getEntrustCatalog } from '../src/entrust.js'
import { ErrorCode } from '../src/error-codes.js'

const request = { activity: 10001, chapter: 101, level: 10101, mode: 1 }
function fixture(name) {
    const f = ornamentFixture(name)
    f.store.transact(f.session.id, 0, (s) => {
        ;(s.taskRecords ??= []).push({ task_id: 106015, count: 1 })
        s.player.basic_info.lv = 45
    })
    return f
}
test('10503 starts a new instance and resets active enemies while preserving real world return and prior earned history', () => {
    const f = fixture('repeat-reenter')
    try {
        const destination = structuredClone(f.state().world)
        f.call('RepeatEventEnterLevelReq', request)
        const first = structuredClone(f.state().entrust.run)
        f.store.transact(f.session.id, 0, (s) => {
            s.repeatEvent = {
                levels: {
                    '10001:10101': {
                        event_id: 10001,
                        level_id: 10101,
                        mode_save_data: [{ mode: 1, star_count: 1, win_count: 1 }],
                    },
                },
            }
            s.entrust.run.stage_index = 3
            s.entrust.run.status = 4
            for (const enemy of Object.values(s.combat.entities)) {
                enemy.hp = 0
                enemy.alive_state = 1
            }
        })
        const records = structuredClone(f.state().repeatEvent)
        const packets = f.call('RepeatEventReEnterLevelReq', request)
        const run = f.state().entrust.run
        assert.equal(run.instance_id, first.instance_id + 1)
        assert.equal(run.stage_index, 1)
        assert.equal(run.status, 2)
        assert.equal(run.battle_complete, undefined)
        assert.deepEqual(run.return_world, first.return_world)
        assert(Object.values(f.state().combat.entities).every((x) => x.hp > 0 && x.alive_state === 0))
        assert.deepEqual(f.state().repeatEvent, records)
        assert.equal(packets.find((x) => x.id === 10503).payload.length, 0)
        f.call('CampaignQuit')
        assert.deepEqual(f.state().world.pos, destination.pos)
        assert.equal(f.state().world.map_id, destination.map_id)
        assert.equal(f.state().entrust.run, undefined)
    } finally {
        f.store.close()
    }
})
test('10503 rejects absent, foreign or completed out-of-map run without creating a challenge', () => {
    const f = fixture('repeat-reenter-reject')
    try {
        let before = structuredClone(f.state())
        assert.throws(
            () => f.call('RepeatEventReEnterLevelReq', request),
            (e) => e.code === ErrorCode.RepeatEventLevelMapInvalid,
        )
        assert.deepEqual(f.state(), before)
        f.call('RepeatEventEnterLevelReq', request)
        f.store.transact(f.session.id, 0, (s) => {
            s.world.map_id = 100
        })
        before = structuredClone(f.state())
        assert.throws(
            () => f.call('RepeatEventReEnterLevelReq', request),
            (e) => e.code === ErrorCode.RepeatEventLevelMapInvalid,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})
test('10503 response encoding failure rolls back new instance, reset enemies and all history', () => {
    const f = fixture('repeat-reenter-rollback')
    try {
        f.call('RepeatEventEnterLevelReq', request)
        const before = structuredClone(f.state()),
            encode = f.protocol.encode.bind(f.protocol)
        f.protocol.encode = (type, data) => {
            if (type === f.protocol.byId.get(9103).rsp) throw Error('wire fail')
            return encode(type, data)
        }
        assert.throws(() => f.call('RepeatEventReEnterLevelReq', request), /wire fail/)
        assert.deepEqual(f.state(), before)
        f.protocol.encode = encode
        f.call('RepeatEventReEnterLevelReq', request)
        assert.equal(f.state().entrust.run.instance_id, before.entrust.run.instance_id + 1)
        assert.equal(getEntrustCatalog(f.tables).stages(32290)[0].row.id, 1000100)
    } finally {
        f.store.close()
    }
})
