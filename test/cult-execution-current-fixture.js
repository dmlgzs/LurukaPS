import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { commitPermanentEnding } from '../src/growup-permanent.js'

const cfg = configuration()
export const cultExecutionTables = new Tables(cfg.tables)
export const cultExecutionProtocol = new Protocol(cfg.base)
export const cultOwnedAssets = (s) =>
    structuredClone({
        heroes: s.player.heros_info.heros,
        pets: s.pets,
        bag: s.player.sbag_infos,
        souls: s.player.soulessence_infos,
        ornaments: s.ornaments,
    })

export function cultExecutionFixture(name) {
    const tables = cultExecutionTables,
        protocol = cultExecutionProtocol,
        store = new Store(':memory:')
    let nowMs = 1800000000000,
        seq = 1,
        session = {}
    const game = new Game(protocol, store, tables, {
        clock: () => Math.floor(nowMs / 1000),
        arenaClockMs: () => nowMs,
        rng: () => 0,
    })
    const request = (name, data = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        assert(e, 'Unknown current Cult request ' + name)
        return { id: e.id, seq: seq++, payload: e.req ? protocol.encode(e.req, data) : Buffer.alloc(0) }
    }
    const dispatch = (frame) => {
        const packets = game.dispatch(session, frame)
        for (const packet of packets) {
            const type = protocol.byId.get(packet.id)?.rsp
            assert(type)
            protocol.decode(type, packet.payload)
        }
        return packets
    }
    const call = (name, data) => dispatch(request(name, data))
    const state = () => store.load(session.id).state
    const edit = (fn) => store.transact(session.id, 0, fn)
    call('EnterGame', { open_id: name })
    edit((s) => {
        s.tasks = []
        s.taskRecords = tables.get('task').map((row) => ({ task_id: row.id, count: 1 }))
    })
    assert.equal(protocol.byName.get('CSProtoBattleInfoReduce').id, 10705)
    assert.equal(protocol.byName.get('CSProtoMultiCampaignPlayerLoaded').id, 9596)
    assert.equal(protocol.byName.get('CSProtoCultTrialSwitchStep').id, 9617)
    const catalog = game.activities,
        system = catalog.growup,
        row = catalog.rows.find((row) => row.id === 60001)
    const start = () =>
        call('ActivityGrowUpStartSelectReq', { activity_id: 60001, starting_id: 101, select_assist_char_ids: [] })
    const config = system.config(60001)
    const lastDay = [1, 2, 3].reduce((sum, phase) => sum + config['trainingDayNum' + phase], 0) + 1
    // Trusted persisted qualification only: four previous cycles use the real
    // finish/permanent producers, but their training/battles are not played here.
    // No305 result, score, accepted receipt or ending is part of this setup.
    for (const finalId of [301, 302, 303, 304]) {
        start()
        edit((s) => {
            const entry = s.activities[60001],
                g = system.ensure(entry, 60001)
            g.growup_train_attr.forEach((attr) => {
                attr.attr_value = 1000
            })
            Object.assign(g, {
                cur_stage: 3,
                cur_growup_stage: lastDay,
                cur_growup_trail_stage: 3,
                select_trail_id: finalId,
            })
            g.trails = [101, 201, finalId].map((trail_id) => ({ trail_id, star: 3, score: '6000', guid: g.guid }))
            s.acceptedCultTrials = {
                ...s.acceptedCultTrials,
                ...Object.fromEntries(g.trails.map((r) => [g.guid + ':' + r.trail_id, true])),
            }
            const trial = tables
                .get('game_events_cul_trial')
                .find((trial) => trial.systemId === 60001 && trial.trialId === finalId)
            const snapshot = system.finish(g, 60001, trial)
            commitPermanentEnding(
                { id: session.id, now: Math.floor(nowMs / 1000), state: s, tables, pushBefore: () => {} },
                catalog,
                row,
                entry,
                snapshot,
                'trial-completion',
            )
        })
        call('ActivityGrowUpResetReq', { activity_id: 60001 })
    }
    start()
    edit((s) => {
        const g = s.activities[60001].growup
        g.growup_train_attr.forEach((attr) => {
            attr.attr_value = 1000
        })
        Object.assign(g, { cur_stage: 3, cur_growup_stage: lastDay, cur_growup_trail_stage: 3, select_trail_id: 0 })
        g.trails = [101, 201].map((trail_id) => ({ trail_id, star: 3, score: '6000', guid: g.guid }))
        s.acceptedCultTrials = {
            ...s.acceptedCultTrials,
            ...Object.fromEntries(g.trails.map((r) => [g.guid + ':' + r.trail_id, true])),
        }
    })
    const baseline = state(),
        guid = baseline.activities[60001].growup.guid
    assert.deepEqual(
        baseline.activities[60001].growup.end_data.complete_end.map((e) => e.id).sort((a, b) => a - b),
        [101, 102, 103, 104],
    )
    assert.equal(Object.keys(baseline.activities[60001].growupPermanent.endings).length, 4)
    assert(!baseline.activities[60001].growup.trails.some((t) => t.trail_id === 305))
    assert.equal(baseline.acceptedCultTrials[guid + ':305'], undefined)
    const enter = () => {
        call('SelectCultTrial', { activity_id: 60001, trial_id: 305 })
        return call('EnterCultTrial', { activity_id: 60001, trial_id: 305 })
    }
    const targets = () => {
        const s = state(),
            run = s.cultTrial
        const ids = run.current_wave === 1 ? [5] : run.current_wave === 2 ? [6] : []
        return Object.values(s.combat.entities).filter((e) => ids.includes(e.object_id) && e.hp > 0)
    }
    const damageFrame = (enemies, partial = false) => {
        const s = state(),
            source = s.cultTrial.pets[0].guid
        nowMs++
        return request('BattleInfoReduce', {
            base_time: String(nowMs),
            uint64_dic: [source, ...enemies.map((e) => e.uuid)],
            battle_info: enemies.map((e, index) => ({
                hurt_info: { from_id: '1', tar_id: String(index + 2), hp_change: partial ? -1 : -e.hp },
            })),
        })
    }
    const hit = (partial = false) => {
        const enemies = targets()
        assert(enemies.length > 0)
        const frame = damageFrame(enemies, partial),
            packets = dispatch(frame),
            s = state()
        for (const e of enemies)
            assert.equal(
                s.combat.entities[e.uuid].hp,
                partial ? e.hp - 1 : 0,
                '10705 must actually change authoritative HP',
            )
        return { frame, packets, enemies }
    }
    return {
        tables,
        protocol,
        store,
        game,
        state,
        edit,
        call,
        request,
        dispatch,
        enter,
        targets,
        damageFrame,
        hit,
        baseline,
        guid,
        session: () => session,
        nowMs: () => nowMs,
        reconnect: () => {
            session = {}
            return call('EnterGame', { open_id: name, reconnect: true })
        },
        close: () => {
            if (store.db.open) store.close()
        },
    }
}
