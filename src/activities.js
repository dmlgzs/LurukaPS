import { KiboTourSystem } from './kibo-tours.js'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { configTime } from './shops.js'
import { taskNodeCompleted, TaskGraphs, nodeConditions, asList, acceptTask, taskUnlocked } from './tasks.js'
import { ensure } from './handlers/common.js'
import { activityTables } from './activity-tables.js'
import { productionTables } from './production-tables.js'
import { GrowupSystem } from './growup.js'

const policy = JSON.parse(fs.readFileSync(new URL('../configs/activity-policy.json', import.meta.url)))
export class ActivityCatalog {
    constructor(tables, { tourPolicy } = {}) {
        this.commonTimeSources = []
        this.external = tables
        this.graphs = new TaskGraphs(tables)
        tables = activityTables(productionTables(tables))
        this.tables = tables
        this.growup = new GrowupSystem(tables)
        this.rows = tables.get('game_events')
        this.tours = new KiboTourSystem(tables, this.rows, tourPolicy)
        this.rewards = tables.get('game_events_reward')
        this.resetHour = Number(tables.get('game').find((r) => r.title === 'DAILY_REFRESH_TIME')?.value ?? 4)
        this.productionTargets = new Map()
    }
    day(now) {
        return Math.floor((now + (8 - this.resetHour) * 3600) / 86400)
    }
    window(row, now) {
        const limit = this.tables.find('common_timelimit', row.timelimit)
        const start = limit ? configTime(limit.startTime) : 0
        let end = limit ? configTime(limit.endTime) : configTime(policy.missingTimeEndTime)
        // Offline policy, not official scheduling. Several current event rows reference
        // timelimit IDs absent from the exported table; don't invent their duration.
        if (end && end < now) end = configTime(policy.expiredEndTime)
        return { activity_id: row.id, start_time: start, end_time: end }
    }
    unlocked(row, state) {
        return String(row.condition || '')
            .split('|')
            .filter(Boolean)
            .every((text) => {
                const [kind, a, b] = text.split('#').map(Number)
                if (kind === 2004) return state.player.basic_info.lv >= a
                if (kind === 2007) return this.taskDone(state, a)
                if (kind === 12045) return taskNodeCompleted(state, a, b)
                return false // TODO: additional common_condition evaluators, never auto-complete unknown rules.
            })
    }
    taskDone(state, id) {
        return (state.taskRecords ?? []).some((r) => r.task_id === id && r.count > 0)
    }
    ensureGuideTasks(state, now) {
        const added = []
        for (const row of this.rows) {
            if (
                !row.guideTaskId ||
                !this.active(row, state, now) ||
                this.taskDone(state, row.guideTaskId) ||
                (state.tasks ?? []).some((t) => t.task_id === row.guideTaskId)
            )
                continue
            const graph = this.graphs.get(row.guideTaskId)
            if (!taskUnlocked(graph, state)) continue
            acceptTask(graph, state, now)
            added.push(row.guideTaskId)
        }
        return added
    }
    guideReturnPoint(state, now, dungeonId) {
        for (const row of this.rows) {
            if (!row.guideTaskId || !this.active(row, state, now)) continue
            const task = state.tasks?.find((x) => x.task_id === row.guideTaskId)
            if (!task || this.taskDone(state, row.guideTaskId)) continue
            const graph = this.graphs.get(row.guideTaskId)
            for (const current of task.nodes) {
                const node = graph.nodes.get(current.node_id)
                const cleared = asList(node.prevNodeIdList).some(
                    (id) =>
                        task.finish_nodes.includes(id) &&
                        nodeConditions(graph.nodes.get(id)).some((condition) => {
                            const required = condition.__type_TaskConditionBaseData?.__type_TaskCondDungeonData
                            const receipt = state.storyCampaignClears?.[required?.dungeonId]
                            return (
                                required?.isOver === 1 &&
                                (!dungeonId || required.dungeonId === dungeonId) &&
                                receipt?.count >= Math.max(1, required.count ?? 1) &&
                                receipt.task_proof
                            )
                        }),
                )
                if (!cleared) continue
                for (const condition of nodeConditions(node)) {
                    const base = condition.__type_TaskConditionBaseData
                    const target = base?.__type_TaskCondInSceneData?.sceneId
                    const point = this.external.find('world_borthpos', base?.mapData?.birthId)
                    if (
                        condition.conditionId === 2519 &&
                        point?.cityId === target &&
                        target === base.mapData.sceneId &&
                        target !== state.world.map_id
                    )
                        return point
                }
            }
        }
        return null
    }
    active(row, state, now) {
        const w = this.window(row, now)
        return now >= w.start_time && now <= w.end_time && this.unlocked(row, state)
    }
    entry(state, id) {
        return ((state.activities ??= {})[id] ??= {
            opened: 0,
            claims: [],
            sign: { count: 0, time: 0, reward_count: 0 },
        })
    }
    condition(text, state) {
        const [kind, a, b] = String(text).split('|').map(Number)
        if ([80003, 80004, 80006, 80008].includes(kind)) {
            const row = this.rows.find((x) => x.type === 60 && x.systemId === a)
            const g = row && state.activities?.[row.id]?.growup
            const ends = g?.end_data?.complete_end ?? []
            if (kind === 80003) return new Set(ends.map((x) => x.id)).size
            if (kind === 80004) return Number(ends.some((x) => x.id === b))
            if (kind === 80006) return Math.max(0, ...ends.map((x) => Number(x.top_rating ?? 0)))
            // 80008 is the endless archive score, not normal cultivation score.
            // Endless archives are not implemented; never unlock from final_wins.
            return 0
        }
        if (kind === 2004) return state.player.basic_info.lv
        if (kind === 2007) return Number(this.taskDone(state, a))
        if (kind === 12045) return Number(taskNodeCompleted(state, a, b))
        if (kind === 61014) return Number((state.activityTeachingCompleted ?? []).includes(b))
        if (kind === 13044) return (state.entrust?.records?.[a]?.entrust_star ?? 0) >= b ? b : 0
        if (kind === 12046)
            return new Set(
                Object.values(state.petCaptureResults ?? {})
                    .map((x) => x.pet_id)
                    .filter((id) => this.tables.find('pet', id)),
            ).size
        if (kind === 13025) {
            const key = `${a}:${b}`
            if (!this.productionTargets.has(key)) {
                const buildings = this.tables.get('home_building').filter((x) => x.groupId === a)
                const groups = new Set(
                    buildings.map((x) => this.tables.find('home_building_production', x.id)?.groupId).filter(Boolean),
                )
                this.productionTargets.set(
                    key,
                    this.tables
                        .get('products')
                        .filter((x) =>
                            String(x.group)
                                .split('|')
                                .some((g) => groups.has(Number(g))),
                        )
                        .map((x) => ({
                            id: x.id,
                            count: String(x.rewardId)
                                .split('|')
                                .reduce((sum, token) => {
                                    const [type, id, count] = token.split('#').map(Number)
                                    return sum + (type === 3 && id === b ? count : 0)
                                }, 0),
                        }))
                        .filter((x) => x.count > 0),
                )
            }
            return this.productionTargets
                .get(key)
                .reduce((n, x) => n + (state.home?.craftCounts?.[x.id] ?? 0) * x.count, 0)
        }
        // TODO: cumulative activity gameplay conditions require authoritative event counters.
        return null
    }
    commonTimes(now, state = undefined) {
        const times = new Map(
            this.tables.get('common_timelimit').map((r) => [
                r.id,
                {
                    time_id: r.id,
                    start_time: String(configTime(r.startTime)),
                    end_time: String(configTime(r.endTime)),
                },
            ]),
        )
        for (const row of this.rows) {
            if (!row.timelimit) continue
            const w = this.tours.presentationWindow(this.window(row, now), state, row)
            times.set(row.timelimit, {
                time_id: row.timelimit,
                start_time: String(w.start_time),
                end_time: String(w.end_time),
            })
        }
        for (const source of this.commonTimeSources)
            for (const row of source(now).data_list) times.set(row.time_id, row)
        return { data_list: [...times.values()] }
    }
    snapshot(state, now) {
        state.activityDay = this.day(now)
        const confs = this.rows.map((row) => this.tours.presentationWindow(this.window(row, now), state, row)),
            activitys = []
        for (const row of this.rows) {
            if (!this.active(row, state, now) && !(row.type === 80 && this.tours.hasRuns(state.activities?.[row.id]))) continue
            const entry = this.entry(state, row.id)
            entry.opened ||= now
            const data = {}
            if ([1, 3].includes(row.type)) {
                const days = this.tables.get('game_events_day_attendance').filter((x) => x.eventId === row.systemId)
                if (
                    (!entry.sign.time || this.day(entry.sign.time) !== this.day(now)) &&
                    entry.sign.count < days.length
                ) {
                    entry.sign.count++
                    entry.sign.time = now
                    entry.sign.hidden = false
                }
                if (row.type === 3)
                    data.daily_sign = {
                        count: entry.sign.count,
                        time: entry.sign.time,
                        reward_count: entry.sign.reward_count,
                    }
                else data.sign = { count: entry.sign.count, time: entry.sign.time, show: !entry.sign.hidden }
            } else if (row.type === 30) {
                data.submit_item_task = {
                    cur_order: 1,
                    finish: false,
                    data_list: (entry.submissions ?? []).map((id) => ({ id, state: 2 })),
                }
            } else if (row.type === 40) data.double_drop = { data: [], reset_time: String(now) }
            else if (row.type === 60) data.grow_up = this.growup.ensure(entry, row.systemId)
            else if (row.type === 80) data.tour_group = this.tours.snapshot(entry, row, now)
            // Complex activities don't receive made-up grow-up/party/tour state.
            // Their configuration is visible; gameplay awaits its own implementation.
            const rewards = this.rewards
                .filter((x) => x.groupId === row.id)
                .map((x) => {
                    const value = this.condition(x.finishCondition, state),
                        val = value ?? 0
                    return {
                        id: x.id,
                        val,
                        state: entry.claims.includes(x.id) ? 2 : value !== null && val >= x.para ? 1 : 0,
                        flag: 0,
                    }
                })
            // Do not dereference null subtype data in the client's specialized stores.
            if (![8, 20, 40, 50, 130].includes(row.type))
                activitys.push({ id: row.id, time: entry.opened, data, rewards })
        }
        return { confs, activitys }
    }
    due(state, now) {
        return (!!state.activities && state.activityDay !== this.day(now)) || this.tours.due(state, now)
    }
    notify(c, force = false) {
        this.syncGrowupHistory(c)
        const activity = this.snapshot(c.state, c.now),
            nday = this.nday(c.state, c.now)
        const signature = createHash('sha256')
            .update(JSON.stringify([activity, nday]))
            .digest('hex')
        if (force || signature !== c.state.activitySyncSignature) {
            c.state.activitySyncSignature = signature
            const tourTimes = JSON.stringify(activity.confs.filter(conf => this.rows.some(row => row.id === conf.activity_id && row.type === 80)))
            if (tourTimes !== c.state.kiboTourPresentationSignature) {
                c.state.kiboTourPresentationSignature = tourTimes
                c.pushBefore('CSProtoSyncCommonTimeConf', this.commonTimes(c.now, c.state))
            }
            c.pushBefore('CSProtoActivitySync', activity)
            if (nday) c.pushBefore('SCProtoNDayInfoSync', nday)
        }
    }
    growupHistorySnapshots(state, now) {
        return this.rows
            .filter((x) => x.type === 60 && this.active(x, state, now))
            .map((row) => this.growup.endQuery(this.growup.ensure(this.entry(state, row.id), row.systemId), row.id))
    }
    syncGrowupHistory(c, force = false) {
        for (const payload of this.growupHistorySnapshots(c.state, c.now)) {
            const entry = this.entry(c.state, payload.activity_id)
            const signature = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
            if (force || entry.growupHistorySyncSignature !== signature) {
                entry.growupHistorySyncSignature = signature
                c.pushBefore('CSProtoActivityGrowUpEndQuerySync', payload)
            }
        }
    }
    nday(state, now) {
        const row = this.rows.find((x) => x.type === 70)
        if (!row || !this.active(row, state, now)) return null
        const entry = this.entry(state, row.id)
        entry.opened ||= now
        entry.nday_claims ??= []
        entry.nday_totals ??= []
        entry.nday_finished ??= []
        entry.nday_progress ??= {}
        const groups = this.tables.get('seven_day_target_group').filter((x) => x.event_id === row.id)
        const unlock_day = Math.min(Math.max(...groups.map((x) => x.day)), this.day(now) - this.day(entry.opened) + 1)
        const targets = this.tables.get('seven_day_target').filter((x) => groups.some((g) => g.group === x.group))
        const target_infos = targets.map((x) => {
            const unlocked = groups.find((g) => g.group === x.group).day <= unlock_day
            const value = this.condition(x.condition, state)
            const progress = unlocked ? Math.max(entry.nday_progress[x.id] ?? 0, value ?? 0) : 0
            if (progress > 0) entry.nday_progress[x.id] = progress
            if (unlocked && value !== null && progress >= x.param && !x.isTop && !entry.nday_finished.includes(x.id))
                entry.nday_finished.push(x.id)
            return {
                id: x.id,
                progress,
                state: entry.nday_claims.includes(x.id) ? 2 : entry.nday_finished.includes(x.id) ? 1 : 0,
            }
        })
        for (const x of targets.filter((x) => x.isTop)) {
            const siblings = targets.filter((s) => s.group === x.group && !s.isTop)
            const complete = siblings.length > 0 && siblings.every((s) => entry.nday_finished.includes(s.id))
            if (complete && !entry.nday_finished.includes(x.id)) entry.nday_finished.push(x.id)
            const wire = target_infos.find((t) => t.id === x.id)
            wire.progress = complete ? x.param : 0
            wire.state = entry.nday_claims.includes(x.id) ? 2 : complete ? 1 : 0
        }
        const total_count = targets.filter((x) => !x.isTop && entry.nday_finished.includes(x.id)).length
        const total_infos = this.tables
            .get('seven_day_target_reward')
            .map((x) => ({ id: x.id, state: entry.nday_totals.includes(x.id) ? 2 : total_count >= x.count ? 1 : 0 }))
        return { unlock_day, total_count, target_infos, total_infos }
    }
    require(state, now, id, types) {
        const row = this.rows.find((x) => x.id === id)
        ensure(row, 'Unknown activity')
        ensure(this.active(row, state, now), 'Activity is locked or outside its time window')
        if (types) ensure(types.includes(row.type), 'Wrong activity type')
        this.snapshot(state, now)
        return { row, entry: this.entry(state, id) }
    }
}
