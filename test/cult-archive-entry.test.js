import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fixture } from './cult-archive-fixture.js'
import { ErrorCode } from '../src/error-codes.js'
import { enemyDefinition } from '../src/enemy-state.js'
const request = { activity_id: 60001, trial_id: 306, archive_id: 1 }
function saved(f, values) {
    f.start()
    f.complete(values)
    f.call('ArchiveGrowupData', { activity_id: 60001, starting_id: 101, archive_id: 1 })
    f.store.transact(f.session.id, 0, (s) => {
        s.tasks = []
        s.taskRecords = f.tables.get('task').map((x) => ({ task_id: x.id, count: 1 }))
        Object.assign(s.world, f.tables.position(f.tables.find('world_borthpos', 20005)))
    })
}
function killWave(f) {
    const s = f.state(),
        run = s.cultTrial,
        targets = Object.values(s.combat.entities).filter((x) => x.object_id === run.current_wave + 4 && x.hp > 0)
    assert(targets.length)
    return f.call('BattleInfoReduce', {
        uint64_dic: [run.pets[0].guid, ...targets.map((x) => x.uuid)],
        battle_info: targets.map((x, i) => ({ hurt_info: { from_id: '1', tar_id: String(i + 2), hp_change: -x.hp } })),
        base_time: '0',
    })
}

test('9610 enters the real 306/32280/6557 route with archived templates and an isolated immutable raising snapshot', () => {
    const f = fixture('archive-entry')
    try {
        saved(f)
        f.call('ActivityGrowUpResetReq', { activity_id: 60001 })
        const ordinary = f.g(),
            before = f.state(),
            archive = before.activities[60001].growupArchive.archive[0]
        const packets = f.call('EnterCultTrial', request),
            s = f.state(),
            run = s.cultTrial
        assert.equal(s.world.map_id, 6557)
        assert.equal(run.dungeon_id, 32280)
        assert.equal(run.object_ids.length, 40)
        assert.deepEqual(run.archive, archive)
        assert.equal(run.heroes[0].hero_lv, 80)
        assert.equal(run.pets[0].lv, 80)
        assert.deepEqual(s.player.heros_info.heros, before.player.heros_info.heros)
        assert.deepEqual(s.player.soulessence_infos, before.player.soulessence_infos)
        assert.deepEqual(s.player.ornament_infos, before.player.ornament_infos)
        assert.deepEqual(f.g(), ordinary)
        assert.equal(f.decode(packets, 'CSProtoCampaignInfoSync').star, 0)
        assert.equal(s.worldObjects['6557:5'].active, false, 'Loading completion, not entry, starts wave 1')
        for (const monster of Object.values(s.combat.entities)) {
            assert(monster.level > 0 && monster.hp > 0)
            const base = enemyDefinition(f.tables, s, monster.uuid),
                scale =
                    monster.object_id <= 12
                        ? 2
                        : monster.object_id <= 18
                          ? 2.5
                          : monster.object_id <= 24
                            ? 3
                            : monster.object_id <= 28
                              ? 4
                              : monster.object_id <= 32
                                ? 5
                                : monster.object_id <= 36
                                  ? 6
                                  : monster.object_id <= 40
                                    ? 7
                                    : 8
            assert.equal(monster.max_hp, Math.floor(base.max_hp * scale))
        }
        f.call('MultiCampaignPlayerLoaded')
        assert.equal(f.state().cultTrial.current_wave, 1)
        assert.equal(f.state().cultTrial.score_rate, 15000, 'Uses archived total 4000, strict > threshold')
        assert.equal(f.state().worldObjects['6557:5'].active, true)
        assert.equal(f.state().worldObjects['6557:6'].active, false)
        f.store.transact(f.session.id, 0, (s) => {
            s.activities[60001].growupArchive.archive[0].growup_train_attr[0].attr_value = 0
        })
        assert.deepEqual(f.state().cultTrial.archive, archive, 'Future archive replacement cannot rewrite the battle')
    } finally {
        f.store.close()
    }
})

test('9610 all forty actual kill batches settle endless score and wave history without advancing normal growth or inventing stars', () => {
    const f = fixture('archive-forty')
    try {
        saved(f)
        const before = f.g(),
            archive = f.state().activities[60001].growupArchive.archive[0],
            formations = f.state().player.group_mgrs
        f.call('EnterCultTrial', request)
        f.call('MultiCampaignPlayerLoaded')
        let packets
        for (let i = 1; i <= 40; i++) {
            assert.equal(f.state().cultTrial.current_wave, i)
            packets = killWave(f)
            assert.equal(f.state().cultTrial.completed_waves, i)
            assert.equal(f.state().worldObjects['6557:' + (i + 4)].active, false)
            const syncs = packets
                    .filter((p) => p.id === f.protocol.byName.get('CSProtoWorldMapSync').id)
                .map((p) => f.protocol.decode('cs.WorldMapNotify', p.payload)),
                snapshot = syncs.find((x) => x.cmd === 47).map_info.objs,
                dead = snapshot.find((x) => x.obj_id === i + 4)
            assert.equal(dead.active, false)
            assert.equal(dead.complete, true)
            assert.deepEqual(dead.expand_data.battle_group.world_indexes, [])
            assert(dead.expand_data.battle_group.monsters.every((x) => x.hp === 0 && x.level > 0))
            if (i < 40) {
                const active = snapshot.find((x) => x.obj_id === i + 5)
                assert.equal(active.active, true)
                assert.equal(active.complete, false)
                assert.equal(
                    active.expand_data.battle_group.world_indexes.length,
                    active.expand_data.battle_group.monsters.length,
                )
                assert(
                    active.expand_data.battle_group.monsters.every(
                        (x) => x.hp > 0 && x.level > 0 && x.obj_key.group_id > 0,
                    ),
                )
            }
            const appear = f.protocol.byName.get('SCProtoObjAppearNtf').id,
                control = f.protocol.byName.get('SCProtoObjControlNtf')?.id
            assert(
                !packets.some((x) => x.id === appear || x.id === control),
                'Local single-player groups are never recreated through multiplayer AOI',
            )
        }
        const s = f.state(),
            run = s.cultTrial,
            ledger = s.activities[60001].growupArchive
        assert.equal(run.battle_complete, true)
        assert.equal(run.status, 3)
        assert.equal(run.star, 0)
        assert.equal(run.star_mask, 0)
        assert(run.score > 0)
        assert.equal(ledger.endless_max_wave, 40)
        assert.equal(ledger.endless_max_score, String(run.score))
        assert.equal(f.decode(packets, 'CSProtoSyncArchiveGrowupData').data[0].endless_max_wave, 40)
        assert.deepEqual(ledger.archive[0], archive)
        assert.deepEqual(f.g(), before)
        assert.throws(
            () => f.call('CultTrialSwitchStep', { activity_id: 60001, trial_id: 306 }),
            (e) => e.code === ErrorCode.ActivityGrowUpInvalidStage,
        )
        f.call('EnterCultTrial', request)
        assert.equal(f.state().cultTrial.status, 3, 'Repeated enter is read-only for a completed run')
        f.call('WorldPoint', { point_id: 0 })
        assert.equal(f.state().cultTrial, undefined)
        assert.equal(f.state().world.map_id, 200)
        assert.deepEqual(
            f.state().player.group_mgrs.filter((x) => x.type !== 8),
            formations.filter((x) => x.type !== 8),
        )
    } finally {
        f.store.close()
    }
})

test('9610 configured 300 second deadline settles only actual killed waves and score', () => {
    const f = fixture('archive-time-limit')
    try {
        saved(f)
        f.call('EnterCultTrial', request)
        f.call('MultiCampaignPlayerLoaded')
        killWave(f)
        const ordinary = f.g(),
            actual = f.state().cultTrial.score
        f.game.clock = () => 1800000301
        f.call('MultiCampaignPlayerLoaded')
        const s = f.state(),
            run = s.cultTrial
        assert.equal(run.status, 4)
        assert.equal(run.completed_waves, 1)
        assert.equal(run.score, actual)
        assert.equal(s.activities[60001].growupArchive.endless_max_wave, 1)
        assert.equal(s.activities[60001].growupArchive.endless_max_score, String(actual))
        assert.equal(s.worldObjects['6557:6'].active, false)
        assert.deepEqual(f.g(), ordinary)
    } finally {
        f.store.close()
    }
})

test('9610 rejects missing, foreign or normal-trial archives without changing a live run', () => {
    const f = fixture('archive-gates')
    try {
        saved(f)
        const before = f.state()
        for (const r of [
            { ...request, archive_id: 2 },
            { ...request, archive_id: 5 },
            { ...request, archive_id: 0 },
            { ...request, trial_id: 101 },
        ])
            assert.throws(() => f.call('EnterCultTrial', r))
        assert.deepEqual(f.state(), before)
        f.store.transact(f.session.id, 0, (s) => {
            s.activities[60001].growupArchive.archive[0].guid = String((9999n << 32n) | 1n)
        })
        assert.throws(
            () => f.call('EnterCultTrial', request),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.equal(f.state().cultTrial, undefined)
    } finally {
        f.store.close()
    }
})

test('9610 SQL reconnect preserves independent wave state, and entry codec errors roll back the formation and map', () => {
    const parent = path.resolve(os.tmpdir()),
        temp = fs.mkdtempSync(path.join(parent, 'cult-archive-entry-')),
        file = path.join(temp, 'state.sqlite')
    let f = fixture('archive-reconnect', file)
    try {
        saved(f)
        const before = f.state(),
            encode = f.protocol.encode.bind(f.protocol)
        f.protocol.encode = (type, value) => {
            if (type === 'cs.CampaignInfo' && value.dungeon_id === 32280) throw Error('entry codec')
            return encode(type, value)
        }
        assert.throws(() => f.call('EnterCultTrial', request), /entry codec/)
        f.protocol.encode = encode
        assert.deepEqual(f.state(), before)
        f.call('EnterCultTrial', request)
        f.call('MultiCampaignPlayerLoaded')
        killWave(f)
        const run = f.state().cultTrial,
            ordinary = f.g()
        f.store.close()
        f = fixture('archive-reconnect', file, true)
        assert.equal(f.state().world.map_id, 6557)
        assert.equal(f.state().cultTrial.current_wave, 2)
        assert.equal(f.state().cultTrial.completed_waves, 1)
        assert.deepEqual(f.state().cultTrial.archive, run.archive)
        assert.deepEqual(f.g(), ordinary)
        f.call('WorldPoint', { point_id: 0 })
        assert.equal(f.state().world.map_id, 200)
    } finally {
        f.store.close()
        if (path.dirname(path.resolve(temp)) !== parent || !path.basename(temp).startsWith('cult-archive-entry-'))
            throw Error('Unexpected cleanup path')
        fs.rmSync(temp, { recursive: true, force: true })
    }
})
