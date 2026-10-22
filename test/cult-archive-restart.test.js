import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from './cult-archive-fixture.js'
import { ErrorCode } from '../src/error-codes.js'
const request = { activity_id: 60001, trial_id: 306, archive_id: 1 }
function ready(f) {
    f.start()
    f.complete()
    f.call('ArchiveGrowupData', { activity_id: 60001, starting_id: 101, archive_id: 1 })
    f.store.transact(f.session.id, 0, (s) => {
        s.tasks = []
        s.taskRecords = f.tables.get('task').map((x) => ({ task_id: x.id, count: 1 }))
        Object.assign(s.world, f.tables.position(f.tables.find('world_borthpos', 20005)))
    })
}
function kill(f) {
    const s = f.state(),
        targets = Object.values(s.combat.entities).filter((x) => x.object_id === s.cultTrial.current_wave + 4)
    f.call('BattleInfoReduce', {
        uint64_dic: [s.cultTrial.heroes[0].guid, ...targets.map((x) => x.uuid)],
        battle_info: targets.map((x, i) => ({ hurt_info: { from_id: '1', tar_id: String(i + 2), hp_change: -x.hp } })),
        base_time: '0',
    })
}
test('9611 restarts the same independent archive with a new instance and fresh enemies, preserving its original return and party', () => {
    const f = fixture('archive-restart')
    try {
        ready(f)
        const original = f.state(),
            ordinary = f.g()
        f.call('EnterCultTrial', request)
        f.call('MultiCampaignPlayerLoaded')
        kill(f)
        const previous = f.state().cultTrial
        f.store.transact(f.session.id, 0, (s) => {
            s.activities[60001].growupArchive.archive[0].growup_train_attr[0].attr_value = 0
        })
        const packets = f.call('ReEnterCultTrial', request),
            run = f.state().cultTrial
        assert.equal(run.instance_id, previous.instance_id + 1)
        assert.deepEqual(run.return_world, previous.return_world)
        assert.deepEqual(
            run.archive,
            previous.archive,
            'Restart retains this fight source, not an archive slot overwritten during the fight',
        )
        assert.equal(run.status, 2)
        assert.equal(run.current_wave, undefined)
        assert.equal(run.completed_waves, undefined)
        assert(Object.values(f.state().combat.entities).every((x) => x.hp === x.max_hp && x.hp > 0))
        assert.equal(f.decode(packets, 'CSProtoCampaignInfoSync').score, 0)
        f.call('MultiCampaignPlayerLoaded')
        assert.equal(f.state().cultTrial.current_wave, 1)
        assert.equal(f.state().worldObjects['6557:5'].active, true)
        assert.equal(f.state().worldObjects['6557:5'].complete, false)
        assert.deepEqual(f.g(), ordinary)
        f.call('WorldPoint', { point_id: 0 })
        assert.equal(f.state().world.map_id, 200)
        assert.deepEqual(
            f.state().player.group_mgrs.filter((x) => x.type !== 8),
            original.player.group_mgrs.filter((x) => x.type !== 8),
        )
    } finally {
        f.store.close()
    }
})
test('9611 validates the active archive and keeps both source and instance intact on encoding failure', () => {
    const f = fixture('archive-restart-gates')
    try {
        ready(f)
        assert.throws(
            () => f.call('ReEnterCultTrial', request),
            (e) => e.code === ErrorCode.NotInCultTrial,
        )
        f.call('EnterCultTrial', request)
        f.call('MultiCampaignPlayerLoaded')
        const before = f.state()
        assert.throws(
            () => f.call('ReEnterCultTrial', { ...request, archive_id: 2 }),
            (e) => e.code === ErrorCode.ActivityGrowUpInvalidParam,
        )
        assert.deepEqual(f.state(), before)
        const encode = f.protocol.encode.bind(f.protocol)
        f.protocol.encode = (type, value) => {
            if (type === 'cs.CampaignInfo' && value.dungeon_instance_id !== before.cultTrial.instance_id)
                throw Error('restart codec')
            return encode(type, value)
        }
        assert.throws(() => f.call('ReEnterCultTrial', request), /restart codec/)
        f.protocol.encode = encode
        assert.deepEqual(f.state(), before)
        f.call('ReEnterCultTrial', {})
        assert.equal(f.state().cultTrial.archive_id, 1)
        assert.equal(f.state().cultTrial.instance_id, before.cultTrial.instance_id + 1)
    } finally {
        f.store.close()
    }
})
