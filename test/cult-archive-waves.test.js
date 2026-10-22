import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from './cult-archive-fixture.js'
import { ErrorCode } from '../src/error-codes.js'
const report = { dungeon_id: 32280, waves: 1, obj_id: 5 }
function ready(f) {
    f.start()
    f.complete()
    f.call('ArchiveGrowupData', { activity_id: 60001, starting_id: 101, archive_id: 1 })
    f.store.transact(f.session.id, 0, (s) => {
        s.tasks = []
        s.taskRecords = f.tables.get('task').map((x) => ({ task_id: x.id, count: 1 }))
        Object.assign(s.world, f.tables.position(f.tables.find('world_borthpos', 20005)))
    })
    f.call('EnterCultTrial', { activity_id: 60001, trial_id: 306, archive_id: 1 })
}
test('9614 only resynchronizes actual current wave; preloading, duplicates and prior completed reports cannot skip or resurrect monsters', () => {
    const f = fixture('archive-wave')
    try {
        ready(f)
        f.call('EndlessCultTrialWaves', report)
        assert.equal(f.state().cultTrial.current_wave, undefined)
        assert.equal(f.state().worldObjects['6557:5'].active, false)
        f.call('MultiCampaignPlayerLoaded')
        const before = f.state()
        const packets = f.call('EndlessCultTrialWaves', report)
        assert.equal(f.decode(packets, 'CSProtoCampaignInfoSync').waves, 1)
        assert.equal(f.decode(packets, 'CSProtoCampaignInfoSync').score, 0)
        for (let n = 0; n < 3; n++) f.call('EndlessCultTrialWaves', report)
        assert.deepEqual(f.state(), before)
        const run = f.state().cultTrial,
            targets = Object.values(f.state().combat.entities).filter((x) => x.object_id === 5)
        f.call('BattleInfoReduce', {
            uint64_dic: [run.pets[0].guid, ...targets.map((x) => x.uuid)],
            battle_info: targets.map((x, i) => ({
                hurt_info: { from_id: '1', tar_id: String(i + 2), hp_change: -x.hp },
            })),
            base_time: '0',
        })
        const second = JSON.parse(JSON.stringify(f.state()))
        const retry = f.call('EndlessCultTrialWaves', report)
        assert.equal(retry.length, 1)
        assert.deepEqual(JSON.parse(JSON.stringify(f.state())), second)
        f.call('EndlessCultTrialWaves', { dungeon_id: 32280, waves: 2, obj_id: 6 })
        assert.equal(f.state().cultTrial.current_wave, 2)
        assert.equal(f.state().cultTrial.completed_waves, 1)
        assert.equal(f.state().worldObjects['6557:5'].active, false)
        assert.deepEqual(f.state().worldObjects['6557:5'].expand_data.battle_group.world_indexes, [])
    } finally {
        f.store.close()
    }
})
test('9614 rejects wrong dungeon, future wave and unrelated object; codec failure leaves all combat and ledger state untouched', () => {
    const f = fixture('archive-wave-gates')
    try {
        assert.throws(
            () => f.call('EndlessCultTrialWaves', report),
            (e) => e.code === ErrorCode.NotInCultTrial,
        )
        ready(f)
        f.call('MultiCampaignPlayerLoaded')
        const before = f.state()
        for (const r of [
            { ...report, dungeon_id: 32210 },
            { ...report, obj_id: 44 },
            { ...report, waves: 0 },
            { ...report, waves: 41, obj_id: 45 },
        ])
            assert.throws(
                () => f.call('EndlessCultTrialWaves', r),
                (e) => e.code === ErrorCode.ActivityGrowUpInvalidParam,
            )
        assert.throws(
            () => f.call('EndlessCultTrialWaves', { dungeon_id: 32280, waves: 40, obj_id: 44 }),
            (e) => e.code === ErrorCode.ActivityGrowUpInvalidStage,
        )
        assert.deepEqual(f.state(), before)
        const encode = f.protocol.encode.bind(f.protocol)
        f.protocol.encode = (type, value) => {
            if (type === 'cs.WorldMapNotify' && value.cmd === 47) throw Error('wave codec')
            return encode(type, value)
        }
        assert.throws(() => f.call('EndlessCultTrialWaves', report), /wave codec/)
        f.protocol.encode = encode
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})
