import { archiveGrowupData } from '../growup-archive.js'
import { ensure } from './common.js'
import { preparePermanent } from '../growup-permanent.js'
import { upgradePermanent } from '../growup-permanent-upgrade.js'
export function registerGrowup(on, catalog) {
    on('ActivityGrowUpExcultivationReq', (c, r) => upgradePermanent(c, r, catalog))
    on('ArchiveGrowupData', (c, r) => archiveGrowupData(c, r, catalog))
    const system = catalog.growup
    const context = (c, r) => {
        const { row, entry } = catalog.require(c.state, c.now, r.activity_id, [60])
        ensure(!row.guideTaskId || catalog.taskDone(c.state, row.guideTaskId), 'Complete cultivation guide task first')
        return { row, entry, g: system.ensure(entry, row.systemId) }
    }
    const publish = (c, id, g, result) => {
        c.pushBefore('CSProtoSyncGrowupTrainAssistCharData', {
            activity_id: id,
            starting_id: g.cur_starting_id,
            train_datas: g.assist_chars,
        })
        catalog.notify(c, true)
        if (result?.dayChanged)
            c.pushBefore('CSProtoActivityGrowUpDayChangeSync', {
                activity_id: id,
                snapshot: result.daySnapshot ?? g.day_start_snapshot,
            })
    }
    on('ActivityGrowUpStartSelectReq', (c, r) => {
        const { entry, row } = context(c, r)
        preparePermanent(system, entry, row.systemId, c.id, c.now)
        const g = system.start(entry, row.systemId, r, c.id, c.randomInt)
        publish(c, row.id, g)
        return {}
    })
    on('ActivityGrowUpTrainReq', (c, r) => {
        const { entry, row } = context(c, r),
            before = structuredClone(entry.growup.day_start_snapshot)
        const result = system.train(entry, row.systemId, r.train_option_id, c.randomInt)
        result.daySnapshot = before
        c.pushBefore('CSProtoActivityGrowUpAttrChangeSync', {
            activity_id: row.id,
            change_type: 1,
            growup_attr_change: result.changes,
        })
        publish(c, row.id, entry.growup, result)
        return { activity_id: row.id, train_option_id: r.train_option_id, train_prob_result: result.result }
    })
    on('ActivityGrowUpRestReq', (c, r) => {
        const { entry, row, g } = context(c, r)
        if (g.rest_interact_pending_id) return { activity_id: row.id, rest_id: g.rest_interact_pending_id }
        const before = structuredClone(g.day_start_snapshot)
        const result = system.rest(entry, row.systemId, c.randomInt)
        result.daySnapshot = before
        publish(c, row.id, g, result)
        return { activity_id: row.id, rest_id: result.row.rest }
    })
    on('ActivityGrowUpRestInteractSubmitReq', (c, r) => {
        const { entry, row, g } = context(c, r)
        ensure(
            g.rest_interact_pending_id > 0 && r.rest_id === g.rest_interact_pending_id,
            'Cultivation rest interaction is not pending',
        )
        const moods = system.tables
            .get('game_events_cul_mood')
            .filter((x) => x.systemId === row.systemId)
            .map((x) => x.moodLevel)
        ensure(
            Number.isInteger(r.add_mood_val) &&
                r.add_mood_val >= 0 &&
                r.add_mood_val <= Math.max(...moods) - Math.min(...moods),
            'Invalid cultivation rest mood result',
        )
        // TODO: validate the client's touch minigame score, rather than only its bounds.
        const before = structuredClone(g.day_start_snapshot)
        g.growup_mood.mood_level = Math.min(Math.max(...moods), g.growup_mood.mood_level + r.add_mood_val)
        g.rest_interact_pending_id = 0
        const dayChanged = system.advance(g, row.systemId)
        system.afterAction(entry, row.systemId, dayChanged, c.randomInt)
        publish(c, row.id, g, { dayChanged, daySnapshot: before })
        return { activity_id: row.id, rest_id: r.rest_id }
    })
    on('ActivityGrowUpResetReq', (c, r) => {
        const { entry, row, g } = context(c, r),
            fresh = system.fresh(row.systemId)
        for (const key of ['final_wins', 'end_data', 'outside_datas', 'outside_score']) fresh[key] = g[key]
        entry.growup = fresh
        entry.growupRuntime = {}
        publish(c, row.id, fresh)
        return {}
    })
    on('ActivityGrowUpEventSelectReq', (c, r) => {
        const { entry, row } = context(c, r)
        const before = new Map(entry.growup.growup_train_attr.map((x) => [x.attr_id, x.attr_value]))
        const reply = system.selectEvent(entry, row.systemId, r, c.randomInt)
        const changes = entry.growup.growup_train_attr
            .map((x) => ({ attr_id: x.attr_id, attr_value: x.attr_value - before.get(x.attr_id) }))
            .filter((x) => x.attr_value !== 0)
        if (changes.length)
            c.pushBefore('CSProtoActivityGrowUpAttrChangeSync', {
                activity_id: row.id,
                change_type: 2,
                growup_attr_change: changes,
            })
        publish(c, row.id, entry.growup)
        return reply
    })
    on('ActivityGrowUpEventInfoReq', (c, r) => {
        const { row, g } = context(c, r)
        return system.eventInfo(g, row.id)
    })
    on('ActivityGrowUpEventFinishReq', (c, r) => {
        const { row, g } = context(c, r)
        // StateTravelReady.OnTravelEnd sends this even when no event is active.
        // Leaving the travel page abandons today's remaining visits, not a day
        // of training; never grant an unfinished event's effects here.
        if (g.cur_event_data?.event_id) {
            const event = g.event_datas.find((x) => x.event_id === g.cur_event_data.event_id)
            ensure(event, 'No active cultivation event')
            event.cur_step = 0
            event.event_option_ids = []
            delete g.cur_event_data
        }
        g.cur_cost_expedition_count = 0
        publish(c, row.id, g)
        return {}
    })
    on('ActivityGrowUpEndQueryReq', (c, r) => {
        const { row, g } = context(c, r)
        return system.endQuery(g, row.id)
    })
}
