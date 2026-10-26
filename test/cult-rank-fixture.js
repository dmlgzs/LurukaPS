import assert from 'node:assert/strict'
import { fixture } from './cult-archive-fixture.js'

export function rankFixture(name, file = ':memory:', resume = false) {
    const f = fixture(name, file, resume)
    const prepare = (actor) => {
        actor.start()
        actor.complete()
        actor.call('ArchiveGrowupData', { activity_id: 60001, starting_id: 101, archive_id: 1 })
        f.store.transact(actor.session.id, 0, (s) => {
            s.tasks = []
            s.taskRecords = f.tables.get('task').map((x) => ({ task_id: x.id, count: 1 }))
            Object.assign(s.world, f.tables.position(f.tables.find('world_borthpos', 20005)))
        })
        return actor
    }
    const add = (name) => {
        const session = {},
            call = (name, r = {}) => {
                const p = f.protocol.byName.get('CSProto' + name)
                return f.game.dispatch(session, {
                    id: p.id,
                    seq: 1,
                    payload: p.req ? f.protocol.encode(p.req, r) : Buffer.alloc(0),
                })
            }
        call('EnterGame', { open_id: name })
        f.store.transact(session.id, 0, (s) => {
            s.taskRecords = [106010, 106013, 404002].map((task_id) => ({ task_id, count: 1 }))
            s.tasks = s.tasks.filter((t) => t.task_id !== 404002)
        })
        call('ActivityGet')
        const state = () => f.store.load(session.id).state
        return {
            ...f,
            session,
            call,
            state,
            start: () =>
                call('ActivityGrowUpStartSelectReq', {
                    activity_id: 60001,
                    starting_id: 101,
                    select_assist_char_ids: [],
                }),
            complete: () =>
                f.store.transact(session.id, 0, (s) => {
                    const g = s.activities[60001].growup,
                        system = f.game.activities.growup
                    g.growup_train_attr.forEach((x) => {
                        x.attr_value = 1000
                    })
                    Object.assign(g, {
                        cur_stage: 3,
                        cur_growup_stage: 13,
                        cur_growup_trail_stage: 3,
                        select_trail_id: 301,
                    })
                    g.trails = [101, 201, 301].map((trail_id) => ({ trail_id, star: 3, score: '6000', guid: g.guid }))
                    system.finish(
                        g,
                        60001,
                        system.tables
                            .get('game_events_cul_trial')
                            .find((x) => x.trialId === 301 && x.systemId === 60001),
                    )
                    s.acceptedCultTrials = {
                        ...s.acceptedCultTrials,
                        ...Object.fromEntries(g.trails.map((x) => [g.guid + ':' + x.trail_id, true])),
                    }
                }),
        }
    }
    const enter = (actor = f) => {
        actor.call('EnterCultTrial', { activity_id: 60001, trial_id: 306, archive_id: 1 })
        actor.call('MultiCampaignPlayerLoaded')
    }
    const kill = (actor = f) => {
        const s = actor.state(),
            run = s.cultTrial,
            targets = Object.values(s.combat.entities).filter(
                (x) => run.object_ids.includes(x.object_id) && x.hp > 0 && x.object_id === run.current_wave + 4,
            )
        assert(targets.length)
        return actor.call('BattleInfoReduce', {
            uint64_dic: [run.pets[0].guid, ...targets.map((x) => x.uuid)],
            battle_info: targets.map((x, i) => ({
                hurt_info: { from_id: '1', tar_id: String(i + 2), hp_change: -x.hp },
            })),
            base_time: '0',
        })
    }
    const finish = (actor = f, waves = 1) => {
        enter(actor)
        for (let i = 0; i < waves; i++) kill(actor)
        actor.call('EndDungeonScene', { result: 4 })
        return actor.state().cultRankProgress
    }
    return { ...f, prepare: (actor = f) => prepare(actor), add, enter, kill, finish }
}
