import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'

function fixture() {
    let nowMs = 1800000000000
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base),
        store = new Store(':memory:'),
        session = {},
        game = new Game(protocol, store, tables, { clock: () => Math.floor(nowMs / 1000), rng: () => 0 })
    let seq = 1
    const call = (name, data = {}, who = session) => {
        const entry = protocol.byName.get('CSProto' + name)
        assert(entry, `Current request ${name}`)
        return game.dispatch(who, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, data) })
    }
    const state = () => store.load(session.id).state
    call('EnterGame', { open_id: 'cult-archive-current' })
    store.transact(session.id, 0, (s) => {
        s.taskRecords = tables.get('task').map((row) => ({ task_id: row.id, count: 1 }))
        s.tasks = []
    })
    call('ActivityGrowUpStartSelectReq', { activity_id: 60001, starting_id: 101, select_assist_char_ids: [] })
    // Trusted completed-cycle fixture. Use the existing completion producer,
    // then the real current9615 archive request; this is not proof that this
    // test played the complete training cycle or earned those three results.
    store.transact(session.id, 0, (s) => {
        const run = s.activities[60001].growup
        run.growup_train_attr.forEach((row) => {
            row.attr_value = 1000
        })
        Object.assign(run, { cur_stage: 3, cur_growup_stage: 13, cur_growup_trail_stage: 3, select_trail_id: 301 })
        run.trails = [101, 201, 301].map((trail_id) => ({ trail_id, star: 3, score: '6000', guid: run.guid }))
        game.activities.growup.finish(
            run,
            60001,
            tables.get('game_events_cul_trial').find((row) => row.trialId === 301),
        )
        s.acceptedCultTrials = Object.fromEntries(run.trails.map((result) => [run.guid + ':' + result.trail_id, true]))
    })
    call('ArchiveGrowupData', { activity_id: 60001, starting_id: 101, archive_id: 1 })
    return { cfg, tables, protocol, store, session, game, call, state, nextBattleTime: () => ++nowMs }
}

test('current9610/9596 and actual damage traverse every configured archive wave without a retired waves report', () => {
    const f = fixture()
    try {
        const trial = f.tables.get('game_events_cul_trial').find((row) => row.systemId === 60001 && row.phase === 4),
            waves = f.tables
                .get('game_events_cul_trial_wave')
                .filter((row) => row.trialId === trial.trialId)
                .sort((a, b) => a.waveId - b.waveId),
            before = structuredClone(f.state()),
            archive = before.activities[60001].growupArchive.archive[0],
            ordinary = before.activities[60001].growup,
            enter = { activity_id: 60001, trial_id: trial.trialId, archive_id: 1 }
        assert.equal(waves.length, 40)
        assert.equal(f.protocol.byName.has('CSProtoEndlessCultTrialWaves'), false)
        const packets = f.call('EnterCultTrial', enter)
        assert(packets.some((packet) => packet.id === 9610))
        assert.equal(f.state().cultTrial.dungeon_id, trial.dungeonId)
        assert.deepEqual(f.state().cultTrial.archive, archive)
        assert.equal(f.state().cultTrial.current_wave, undefined)
        f.call('MultiCampaignPlayerLoaded')
        const instance = f.state().cultTrial.instance_id
        let last
        const seen = new Map()
        for (const wave of waves) {
            const run = f.state().cultTrial,
                ids = String(wave.worldMapId).split('|').map(Number),
                targets = Object.values(f.state().combat.entities).filter(
                    (entity) => ids.includes(entity.object_id) && entity.hp > 0,
                )
            assert.equal(run.current_wave, wave.waveId)
            assert(targets.length > 0)
            for (const entity of targets) {
                assert(!seen.has(entity.uuid), 'A new wave cannot reuse an earlier object/slot identity')
                seen.set(entity.uuid, entity.config_id)
            }
            last = f.call('BattleInfoReduce', {
                uint64_dic: [run.pets[0].guid, ...targets.map((entity) => entity.uuid)],
                battle_info: targets.map((entity, index) => ({
                    hurt_info: { from_id: '1', tar_id: String(index + 2), hp_change: -entity.hp },
                })),
                base_time: String(f.nextBattleTime()),
            })
            assert.equal(f.state().cultTrial.completed_waves, wave.waveId)
            for (const id of ids) {
                const object = f.state().worldObjects[`${run.map_id}:${id}`]
                assert.equal(object.complete, true)
                assert.equal(object.active, false)
                assert.deepEqual(object.expand_data.battle_group.world_indexes, [])
                assert(object.expand_data.battle_group.monsters.every((monster) => monster.hp === 0))
            }
            const snapshots = last
                .filter((packet) => packet.id === f.protocol.byName.get('CSProtoWorldMapSync').id)
                .map((packet) => f.protocol.decode('cs.WorldMapNotify', packet.payload))
                .filter((packet) => packet.cmd === 47)
            assert(snapshots.length)
            for (const packet of last) {
                const type = f.protocol.byId.get(packet.id)?.rsp
                assert(type)
                f.protocol.decode(type, packet.payload)
            }
        }
        const result = f.state(),
            run = result.cultTrial,
            ledger = result.activities[60001].growupArchive
        assert.equal(run.instance_id, instance)
        assert.equal(run.battle_complete, true)
        assert.equal(run.status, 3)
        assert.equal(run.star, 0)
        assert.equal(ledger.endless_max_wave, waves.at(-1).waveId)
        assert.equal(ledger.endless_max_score, String(run.score))
        assert(run.score > 0)
        assert.deepEqual(ledger.archive[0], archive)
        assert.deepEqual(result.activities[60001].growup, ordinary)
        const stable = structuredClone(run)
        f.call('EnterCultTrial', enter)
        assert.deepEqual(f.state().cultTrial, stable, 'Reopening a completed run does not respawn a wave')
        f.call('WorldPoint', { point_id: 0 })
        assert.equal(f.state().cultTrial, undefined)
        assert.equal(f.state().world.map_id, before.world.map_id)
        assert.deepEqual(
            f.state().player.group_mgrs.filter((group) => group.type !== 8),
            before.player.group_mgrs.filter((group) => group.type !== 8),
        )
    } finally {
        f.store.close()
    }
})
