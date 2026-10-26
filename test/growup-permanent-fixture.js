import assert from 'node:assert/strict'
import { fixture } from './cult-archive-fixture.js'

export function permanentFixture(name, file = ':memory:', resume = false) {
    const f = fixture(name, file, resume),
        system = f.game.activities.growup
    const unlock = () =>
        f.store.transact(f.session.id, 0, (s) => {
            s.tasks = []
            s.taskRecords = f.tables.get('task').map((x) => ({ task_id: x.id, count: 1 }))
            Object.assign(s.world, f.tables.position(f.tables.find('world_borthpos', 20005)))
        })
    const atTrial = (phase, attrs = 1000) =>
        f.store.transact(f.session.id, 0, (s) => {
            const g = s.activities[60001].growup
            Object.assign(g, {
                cur_stage: phase,
                cur_growup_stage: phase === 1 ? 4 : phase === 2 ? 8 : 13,
                cur_growup_trail_stage: phase,
                select_trail_id: [101, 201, 301][phase - 1],
            })
            g.growup_train_attr.forEach((x) => {
                x.attr_value = attrs
            })
        })
    const kill = () => {
        const s = f.state(),
            run = s.cultTrial,
            active = new Set(
                run.scene_objects.filter((x) => x.active && run.object_ids.includes(x.obj_id)).map((x) => x.obj_id),
            ),
            targets = Object.values(s.combat.entities).filter((x) => active.has(x.object_id) && x.hp > 0)
        assert(targets.length)
        return f.call('BattleInfoReduce', {
            uint64_dic: [run.pets[0].guid, ...targets.map((x) => x.uuid)],
            battle_info: targets.map((x, i) => ({
                hurt_info: { from_id: '1', tar_id: String(i + 2), hp_change: -x.hp },
            })),
            base_time: '0',
        })
    }
    const examination = (phase, { attrs = 1000, submit = true } = {}) => {
        atTrial(phase, attrs)
        const request = { activity_id: 60001, trial_id: [101, 201, 301][phase - 1] }
        f.call('EnterCultTrial', request)
        f.call('MultiCampaignPlayerLoaded')
        while (!f.state().cultTrial.battle_complete) kill()
        assert(f.state().cultTrial.star >= 1)
        if (!submit) return
        const packets = f.call('CultTrialSwitchStep', request)
        f.call('WorldPoint', { point_id: 0 })
        return packets
    }
    const travelJoin = (exclude = []) => {
        const g = f.g(),
            tables = system.tables,
            effects = new Map(tables.get('game_events_cul_effect').map((x) => [x.Id, x])),
            options = new Map(tables.get('game_events_cul_eventoption').map((x) => [x.optionId, x])),
            ids = (v) =>
                String(v ?? '')
                    .split('|')
                    .filter(Boolean)
                    .map(Number)
        let found
        for (const event of tables.get('game_events_cul_event').filter((x) => x.systemId === 60001)) {
            if (!system.condition(event.unlockCondition, g)) continue
            const steps = tables.get('game_events_cul_eventstep').filter((x) => x.systemId === event.id),
                first = steps.find((x) => x.isFirstStep === 1),
                queue = first ? [{ step: first.step, path: [], cost: 0 }] : [],
                seen = new Set()
            while (queue.length && !found) {
                const p = queue.shift(),
                    key = p.step + ':' + p.cost
                if (seen.has(key)) continue
                seen.add(key)
                const step = steps.find((x) => x.step === p.step)
                if (!step) continue
                if (!step.option) {
                    if (step.nextStep > 0) queue.push({ ...p, step: step.nextStep, path: [...p.path, 0] })
                    continue
                }
                for (const optionId of ids(step.option)) {
                    const o = options.get(optionId)
                    if (!o || o.checkType || p.cost + o.costPoints > 2 || !system.condition(o.unlockCondition, g))
                        continue
                    const path = [...p.path, optionId]
                    const targets = ids(o.effect).flatMap((id) => {
                        const e = effects.get(id)
                        return e?.type === 13
                            ? String(e.param)
                                  .split('|')
                                  .map((x) => x.split('#').map(Number))
                                  .filter((x) => x[1] > 0)
                                  .map((x) => x[0])
                            : []
                    })
                    const aid = targets.find(
                        (x) => !g.assist_chars.some((a) => a.assist_char_id === x) && !exclude.includes(x),
                    )
                    if (aid) {
                        found = { event: event.id, path, aid }
                        break
                    }
                    if (o.nextStep > 0) queue.push({ step: o.nextStep, path, cost: p.cost + o.costPoints })
                }
            }
            if (found) break
        }
        assert(found, 'current table has a legal direct positive companion path')
        f.store.transact(f.session.id, 0, (s) => {
            const g = s.activities[60001].growup
            g.cur_cost_expedition_count = 2
            g.event_datas = [{ event_id: found.event, cur_step: 0, finish: false, event_option_ids: [] }]
        })
        for (const optional_id of found.path)
            f.call('ActivityGrowUpEventSelectReq', { activity_id: 60001, event_id: found.event, optional_id })
        assert(f.g().assist_chars.some((x) => x.assist_char_id === found.aid))
        if (f.g().cur_event_data?.event_id) f.call('ActivityGrowUpEventFinishReq', { activity_id: 60001 })
        return found.aid
    }
    const complete = (attrs = 1000) => {
        let packets
        for (let phase = 1; phase <= 3; phase++) packets = examination(phase, { attrs })
        return packets
    }
    return { ...f, system, unlock, atTrial, kill, examination, travelJoin, complete }
}
