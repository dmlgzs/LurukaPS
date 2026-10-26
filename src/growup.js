import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { randomInt as secureRandomInt } from 'node:crypto'
import { assistantLevel, prepareGrowupCycle, populateGrowupEvents, growupCommonTriggers } from './growup-cycle.js'
import { cultivationScore, growupScoreVersion } from './growup-score.js'
import { permanentState } from './growup-permanent.js'
import { permanentRunGuid, sealPermanentInitial, applyPermanentJoin } from './growup-initial-perks.js'
const ids = (value) =>
    String(value ?? '')
        .split('|')
        .filter(Boolean)
        .map(Number)
const pairs = (value) =>
    String(value ?? '')
        .split('|')
        .filter(Boolean)
        .map((x) => x.split('#').map(Number))
export function trainingFailureRate(afterStamina) {
    // CBT3 TrainingData.GetFailureResult, IL 06005032; use float32 intermediates.
    if (afterStamina <= 0) return 10000
    const root = Math.fround(Math.sqrt(Math.fround(afterStamina / 50)))
    const factor = Math.fround(Math.pow(Math.min(Math.fround(afterStamina / 20), 1), 2))
    return 10000 - Math.min(10000, Math.trunc(Math.fround(10500 * Math.fround(root * factor))))
}
export class GrowupSystem {
    constructor(tables) {
        this.tables = tables
        this.permanentEntries = new WeakMap()
    }
    config(id) {
        const row = this.tables.get('game_events_cul').find((x) => x.Id === id)
        ensure(row, 'Missing cultivation configuration', ErrorCode.GrowUpConfNoExist)
        return row
    }
    fresh(id) {
        const config = this.config(id)
        return {
            cur_stage: 0,
            cur_growup_stage: 0,
            cur_growup_trail_stage: 0,
            cur_starting_id: 0,
            cur_cost_expedition_count: 0,
            action_count: 0,
            growup_stamina: { stamina: config.defaultStamina },
            growup_mood: { mood_level: config.defaultMood },
            growup_train_attr: this.tables
                .get('game_events_cul_attr')
                .filter((x) => x.systemId === id)
                .map((x) => ({ attr_id: x.AttrId, attr_value: 0, cur_node: 0 })),
            growup_status: [],
            growup_trait: [],
            event_datas: [],
            trails: [],
            train_options: [],
            assist_chars: [],
            growup_train_exp: 0,
            select_effects: [],
            final_wins: [],
            select_trail_id: 0,
            skill_tree_data: { chains: [], unlocked_nodes: [] },
            outside_datas: [],
            outside_score: 0,
            end_data: { complete_end: [] },
            unlock_events: [],
            final_score: '0',
            evt_records: [],
            rest_interact_pending_id: 0,
            guid: '0',
            archive_guid: '0',
        }
    }
    ensure(entry, id) {
        const g = (entry.growup ??= this.fresh(id))
        this.permanentEntries.set(g, entry)
        if (entry.growupHistoryScoreVersion !== growupScoreVersion) {
            for (const record of g.end_data.complete_end) {
                try {
                    const score = cultivationScore(this, id, record)
                    record.top_rating = String(Math.max(Number(record.top_rating ?? 0), score.total))
                    // A merged ending snapshot cannot reconstruct each opening's
                    // independent best run. Only update unambiguous old saves.
                    if (record.starting_ids?.length === 1) {
                        const win = g.final_wins.find((x) => x.starting_id === record.starting_ids[0])
                        if (win) win.score = String(Math.max(Number(win.score ?? 0), score.total))
                    }
                } catch (error) {
                    console.warn(`Cultivation history score migration (${id}/${record.id}): ${error.message}`)
                }
            }
            if (g.cur_stage === 4 && g.cur_growup_trail_stage === 4) {
                try {
                    g.final_score = String(
                        cultivationScore(this, id, {
                            attrs: g.growup_train_attr,
                            chrs: g.assist_chars,
                            trails: g.trails,
                        }).total,
                    )
                } catch (error) {
                    console.warn(`Cultivation completed score migration (${id}): ${error.message}`)
                }
            }
            entry.growupHistoryScoreVersion = growupScoreVersion
        }
        this.normalizeTrialSelection(g, id)
        if (g.cur_starting_id && entry.growupRuntime?.expeditionRemainingVersion !== 1) {
            const runtime = (entry.growupRuntime ??= {})
            const maximum = this.config(id).expeditionCount
            // Legacy server stored spent points. CBT3 TravalCount reads this
            // field directly as remaining points and uses >0 to enter travel.
            g.cur_cost_expedition_count =
                g.cur_stage > 3 || g.cur_growup_trail_stage === g.cur_stage
                    ? 0
                    : Math.max(0, maximum - Math.max(0, Math.min(maximum, g.cur_cost_expedition_count ?? 0)))
            runtime.expeditionRemainingVersion = 1
        }
        return g
    }
    normalizeTrialSelection(g, id) {
        if (!g.cur_starting_id || g.cur_stage < 1 || g.cur_stage > 3) return
        const candidates = ids(this.config(id)[`trial${g.cur_stage}`])
        // CBT3 GetCurTrialID reads selectTrailId directly on the final day.
        // A previous phase's ID must not survive into the ending-selection page.
        // Zero means pending selection; preserve any valid explicit selection.
        if (!candidates.includes(g.select_trail_id)) g.select_trail_id = candidates.length === 1 ? candidates[0] : 0
    }
    condition(rule, g) {
        if (!rule) return true
        return String(rule)
            .split('|')
            .every((text) => {
                const [kind, activity, a, b] = text.split('#').map(Number)
                if (kind === 80001) return (g.growup_train_attr.find((x) => x.attr_id === a)?.attr_value ?? 0) >= b
                if (kind === 80003) return new Set(g.end_data.complete_end.map((x) => x.id)).size >= a
                if (kind === 80004) return g.end_data.complete_end.some((x) => x.id === a)
                if (kind === 80006) return g.end_data.complete_end.some((x) => BigInt(x.top_rating ?? 0) >= BigInt(a))
                if (kind === 80009) {
                    const rank = this.tables
                        .get('game_events_cul_attrRate')
                        .find((x) => x.eventid === activity && x.rating === b)
                    const attr = g.growup_train_attr.find((x) => x.attr_id === a)
                    return !!rank && !!attr && attr.attr_value >= rank.needAttr
                }
                return false
            })
    }
    weighted(rows, key, randomInt) {
        const choices = rows.filter((x) => Number.isSafeInteger(x[key]) && x[key] > 0)
        const total = choices.reduce((n, x) => n + x[key], 0)
        ensure(total > 0 && Number.isSafeInteger(total), 'Empty cultivation probability table', ErrorCode.GameConfig)
        let draw = randomInt(total)
        for (const row of choices) {
            draw -= row[key]
            if (draw < 0) return row
        }
        ensure(false, 'Invalid cultivation random draw')
    }
    effects(g, id, value) {
        const config = this.config(id)
        for (const effectId of ids(value)) {
            const row = this.tables.get('game_events_cul_effect').find((x) => x.Id === effectId)
            ensure(row, `Unknown cultivation effect ${effectId}`, ErrorCode.GameConfig)
            if (row.type === 1 || row.type === 2) {
                const n = Number(row.param)
                ensure(Number.isFinite(n), 'Invalid cultivation stamina effect', ErrorCode.GameConfig)
                g.growup_stamina.stamina = Math.max(
                    0,
                    Math.min(config.maxStamina, g.growup_stamina.stamina + (row.type === 1 ? n : -n)),
                )
            } else if (row.type === 3) {
                for (const [attr, value, mode = 0] of pairs(row.param)) {
                    ensure(
                        [0, 1, 2, 3].includes(mode),
                        'Unknown cultivation attribute change source',
                        ErrorCode.GameConfig,
                    )
                    const target = g.growup_train_attr.find((x) => x.attr_id === attr)
                    ensure(target, 'Unknown cultivation attribute', ErrorCode.GameConfig)
                    target.attr_value = Math.max(0, Math.min(config.maxAttr, target.attr_value + value))
                }
            } else if (row.type === 13) {
                for (const [assistantId, points] of pairs(row.param)) {
                    ensure(
                        this.tables
                            .get('game_events_cul_assist')
                            .some((x) => x.assistId === assistantId && x.systemId === id),
                        'Unknown cultivation assistant',
                        ErrorCode.GameConfig,
                    )
                    let assistant = g.assist_chars.find((x) => x.assist_char_id === assistantId)
                    if (!assistant)
                        g.assist_chars.push(
                            (assistant = { assist_char_id: assistantId, bond: 0, is_bond_train: false }),
                        )
                    assistant.bond = Math.max(0, assistant.bond + points)
                    applyPermanentJoin(this, this.permanentEntries.get(g), g, id, assistant)
                }
            } else if (row.type === 0) {
                continue
            } else if (row.type === 5 || row.type === 6) {
                ensure(!row.param, 'Parameterized cultivation mood effect is not implemented', ErrorCode.FunctionClosed)
                // Empty-param MoodLevel/MoodDown are one-step effects. This is a
                // compatibility inference recorded in growup-cbt3.md.
                const levels = this.tables
                    .get('game_events_cul_mood')
                    .filter((x) => x.systemId === id)
                    .map((x) => x.moodLevel)
                g.growup_mood.mood_level = Math.max(
                    Math.min(...levels),
                    Math.min(Math.max(...levels), g.growup_mood.mood_level + (row.type === 5 ? 1 : -1)),
                )
            } else if (row.type === 29) {
                for (const eventId of ids(row.param))
                    if (!g.unlock_events.includes(eventId)) g.unlock_events.push(eventId)
            } else if (row.type === 10) {
                for (const statusId of ids(row.param)) {
                    const status = this.tables
                        .get('game_events_cul_status')
                        .find((x) => x.statusID === statusId && x.activityid === id)
                    ensure(status, 'Unknown cultivation status', ErrorCode.GameConfig)
                    const old = g.growup_status.find((x) => x.status_id === statusId)
                    if (old) old.cur_duration_time = status.duration
                    else
                        g.growup_status.push({
                            status_id: statusId,
                            cur_duration_time: status.duration,
                            cur_enable_time: g.cur_growup_stage,
                        })
                }
            } else
                ensure(
                    false,
                    `Cultivation effect ${effectId} type ${row.type} is not implemented`,
                    ErrorCode.FunctionClosed,
                )
        }
    }
    populateEvents(g, id, randomInt = secureRandomInt) {
        populateGrowupEvents(this, g, id, randomInt)
    }
    prepare(entry, id, randomInt) {
        const g = this.ensure(entry, id)
        if (!g.cur_starting_id || g.cur_stage > 3) return
        const runtime = (entry.growupRuntime ??= {})
        if (runtime.eventsDay === undefined) {
            // Recover guaranteed day unlocks only; never reroll historical rare events.
            for (let day = 1; day <= g.cur_growup_stage; day++)
                growupCommonTriggers(this, g, id, { kind: 2, variant: 2, result: 1, detail: day }, (max) => max - 1)
            runtime.eventsDay = g.cur_growup_stage
        }
        prepareGrowupCycle(this, entry, id, randomInt)
        if (runtime.eventsCycle !== runtime.cycle) {
            this.populateEvents(g, id, randomInt)
            runtime.eventsCycle = runtime.cycle
        }
    }
    afterAction(entry, id, dayChanged, randomInt) {
        const g = entry.growup,
            runtime = (entry.growupRuntime ??= {})
        if (dayChanged) {
            for (const event of g.event_datas) event.duration = Math.max(0, event.duration - 1)
            for (const status of g.growup_status)
                if (status.cur_duration_time < 999) status.cur_duration_time = Math.max(0, status.cur_duration_time - 1)
            g.growup_status = g.growup_status.filter((x) => x.cur_duration_time > 0)
            growupCommonTriggers(this, g, id, { kind: 2, variant: 2, result: 1, detail: g.cur_growup_stage }, randomInt)
            runtime.eventsDay = g.cur_growup_stage
        }
        prepareGrowupCycle(this, entry, id, randomInt)
        this.populateEvents(g, id, randomInt)
        runtime.eventsCycle = runtime.cycle
    }
    start(entry, id, request, accountId, randomInt = secureRandomInt) {
        const old = this.ensure(entry, id)
        const starting = this.tables
            .get('game_events_cul_starting')
            .find((x) => x.startingId === request.starting_id && x.systemId === id)
        ensure(starting && this.condition(starting.condition, old), 'Cultivation starting scenario is locked')
        const requested = request.select_assist_char_ids ?? []
        const initial = ids(starting.initialCharacter)
        const chosen = requested.filter((x) => !initial.includes(x))
        ensure(
            new Set(requested).size === requested.length && chosen.length <= starting.exCharAmonut,
            'Invalid cultivation assist selection',
        )
        ensure(
            chosen.every(
                (x) =>
                    this.tables.get('game_events_cul_assist').some((a) => a.assistId === x && a.systemId === id) &&
                    !ids(starting.lockCharacter).includes(x) &&
                    !ids(starting.initialCharacter).includes(x),
            ),
            'Cultivation assist is unavailable',
        )
        if (old.cur_starting_id) {
            ensure(old.cur_starting_id === starting.startingId, 'Cultivation run already started')
            return old
        }
        const ledger = permanentState(this, entry, id, accountId)
        ensure(
            chosen.every((x) => ledger?.unlocked.includes(x)),
            'Cultivation assistant is not permanently unlocked',
            ErrorCode.ActivityGrowUpExcultivationCondLimit,
        )
        const g = this.fresh(id)
        g.final_wins = old.final_wins
        g.end_data = old.end_data
        g.outside_datas = old.outside_datas
        g.outside_score = old.outside_score
        g.cur_starting_id = starting.startingId
        g.cur_stage = 1
        g.cur_growup_stage = 1
        g.guid = permanentRunGuid(entry, accountId)
        g.assist_chars = [...ids(starting.initialCharacter), ...chosen].map((assist_char_id) => ({
            assist_char_id,
            bond: 0,
            is_bond_train: false,
        }))
        g.train_options = [
            ...new Set(
                this.tables
                    .get('game_events_cul_train')
                    .filter((x) => x.systemId === id)
                    .map((x) => x.trainOption),
            ),
        ].map((train_option_id) => ({ train_option_id, train_lv: 1, train_exp: 0, assist_char_ids: [] }))
        entry.growup = g
        entry.growupRuntime = { expeditionRemainingVersion: 1 }
        this.permanentEntries.set(g, entry)
        this.effects(g, id, starting.effect)
        sealPermanentInitial(this, entry, id, accountId)
        g.day_start_snapshot = { train_attrs: structuredClone(g.growup_train_attr), statuses: [] }
        g.cur_cost_expedition_count = this.config(id).expeditionCount
        this.prepare(entry, id, randomInt)
        return g
    }
    requireRun(entry, id) {
        const g = this.ensure(entry, id)
        ensure(g.cur_starting_id > 0, 'Cultivation run has not started')
        ensure(g.cur_growup_trail_stage !== g.cur_stage, 'Complete the configured cultivation trial first')
        ensure(
            !g.rest_interact_pending_id && !g.cur_event_data?.event_id,
            'Finish the current cultivation interaction first',
        )
        return g
    }
    finish(g, id, trial) {
        const ending = this.tables
            .get('game_events_cul_end')
            .find((x) => x.systemId === id && x.endingId === trial.ending && x.trial === trial.trialId)
        ensure(ending, 'Cultivation ending configuration unavailable', ErrorCode.CultInvalidEndId)
        ensure(
            this.condition(ending.condition, g),
            'Cultivation ending conditions not met',
            ErrorCode.CultEndNotComplete,
        )
        ensure(
            [1, 2, 3].every((phase) => {
                const result = g.trails[phase - 1],
                    row = this.tables
                        .get('game_events_cul_trial')
                        .find((x) => x.systemId === id && x.trialId === result?.trail_id)
                return row?.phase === phase && result.star > 0
            }),
            'Cultivation examinations are incomplete',
        )
        // Explicitly requested local approximation; never add the intermediate
        // star accumulator again or modify the battle's score/rate/star mask.
        const score = cultivationScore(this, id, { attrs: g.growup_train_attr, chrs: g.assist_chars, trails: g.trails })
        g.final_score = String(score.total)
        const snapshot = {
            id: ending.endingId,
            top_rating: g.final_score,
            chrs: structuredClone(g.assist_chars),
            attrs: structuredClone(g.growup_train_attr),
            trails: structuredClone(g.trails),
            starting_ids: [g.cur_starting_id],
        }
        const book = g.end_data.complete_end,
            old = book.find((x) => x.id === ending.endingId)
        if (!old) book.push(snapshot)
        else {
            const starts = [...new Set([...(old.starting_ids ?? []), g.cur_starting_id])]
            if (BigInt(snapshot.top_rating) > BigInt(old.top_rating)) Object.assign(old, snapshot)
            old.starting_ids = starts
        }
        let win = g.final_wins.find((x) => x.starting_id === g.cur_starting_id)
        if (!win)
            g.final_wins.push((win = { starting_id: g.cur_starting_id, score: '0', assist_chars: [], finish_ends: [] }))
        if (BigInt(g.final_score) > BigInt(win.score)) {
            win.score = g.final_score
            win.assist_chars = structuredClone(g.assist_chars)
        }
        win.finish_ends = [...new Set([...win.finish_ends, ending.endingId])]
        g.cur_stage = 4
        g.cur_growup_trail_stage = 4 // RuntimeData.PlayDone checks this field.
        g.action_count = 0
        return snapshot
    }
    advance(g, id) {
        const config = this.config(id)
        g.action_count++
        if (g.action_count < config.actionCount) return false
        g.action_count = 0
        g.cur_growup_stage++
        g.cur_cost_expedition_count = config.expeditionCount
        const last = Array.from({ length: g.cur_stage }, (_, i) => config[`trainingDayNum${i + 1}`]).reduce(
            (n, x) => n + x,
            0,
        )
        if (g.cur_growup_stage > last) {
            g.cur_growup_trail_stage = g.cur_stage
            g.cur_cost_expedition_count = 0
            this.normalizeTrialSelection(g, id)
        }
        g.day_start_snapshot = {
            train_attrs: structuredClone(g.growup_train_attr),
            statuses: structuredClone(g.growup_status),
        }
        return true
    }
    train(entry, id, optionId, randomInt) {
        const g = this.requireRun(entry, id),
            config = this.config(id),
            option = g.train_options.find((x) => x.train_option_id === optionId)
        ensure(option, 'Unknown cultivation training option')
        const row = this.tables
            .get('game_events_cul_train')
            .find((x) => x.systemId === id && x.trainOption === optionId && x.trainLevel === option.train_lv)
        ensure(row, 'Missing cultivation training level', ErrorCode.GameConfig)
        ensure(!row.cost, 'Paid cultivation training is not implemented', ErrorCode.FunctionClosed)
        this.prepare(entry, id, randomInt)
        const assigned = option.assist_char_ids.map((x) => g.assist_chars.find((a) => a.assist_char_id === x))
        ensure(assigned.every(Boolean), 'Cultivation training assistant is unavailable')
        let assistModifier = 10000,
            bondModifier = 10000n,
            staminaModifier = 10000,
            staminaAddition = 0,
            failureModifier = 10000,
            bondPointsModifier = 10000,
            moodBoost = 0
        const additions = new Map()
        for (const assistant of assigned) {
            const data = assistantLevel(this, assistant)
            assistModifier += data.assistTrainModifier
            if (assistant.is_bond_train) bondModifier = (bondModifier * BigInt(data.bondTrainModifier)) / 10000n
            const [attr, amount] = String(data.assistTrainAdd).split('|').map(Number)
            additions.set(attr, (additions.get(attr) ?? 0) + amount)
            staminaModifier += data.assistStaminacost > 0 ? data.assistStaminacost - 10000 : 0
            moodBoost += data.assistmoodModifieradd
        }
        const statusModifiers = new Map(g.growup_train_attr.map((x) => [x.attr_id, 10000]))
        for (const status of g.growup_status) {
            const source = this.tables.get('game_events_cul_status').find((x) => x.statusID === status.status_id)
            ensure(source, 'Unknown cultivation status', ErrorCode.GameConfig)
            for (const effectId of ids(source.effect)) {
                const effect = this.tables.get('game_events_cul_effect').find((x) => x.Id === effectId)
                ensure(effect, 'Cultivation status training effect missing', ErrorCode.GameConfig)
                if (effect.type === 15)
                    for (const [attr, bonus] of pairs(effect.param))
                        statusModifiers.set(attr, (statusModifiers.get(attr) ?? 10000) + bonus)
                else if (effect.type === 28)
                    for (const attr of statusModifiers.keys())
                        statusModifiers.set(attr, statusModifiers.get(attr) + Number(effect.param))
                else if (effect.type === 23) failureModifier += Number(effect.param) - 10000
                else if (effect.type === 24) staminaModifier += Number(effect.param) - 10000
                else if (effect.type === 25) bondPointsModifier += Number(effect.param.split('#').at(-1))
                else if (effect.type === 1 || effect.type === 2)
                    staminaAddition += Number(effect.param) * (effect.type === 1 ? 1 : -1)
                else if (effect.type === 3)
                    for (const [attr, amount] of pairs(effect.param))
                        additions.set(attr, (additions.get(attr) ?? 0) + amount)
                else {
                    const unknown = (entry.growupRuntime.unimplementedStatusTypes ??= [])
                    if (!unknown.includes(effect.type)) {
                        unknown.push(effect.type)
                        console.warn(`Cultivation status effect ${effect.type} is not applied to training`)
                    }
                }
            }
        }
        const remaining =
            g.growup_stamina.stamina + Math.trunc(((-row.costStamina + staminaAddition) * staminaModifier) / 10000)
        const failure = Math.min(
            10000,
            Math.max(0, Math.trunc((trainingFailureRate(remaining) * failureModifier) / 10000)),
        )
        // ModuleRaisingResult.OnTrainResult subtracts one before indexing
        // fail/success/bond artwork. The wire values are 1/2/3, not 0/1/2.
        const result = randomInt(10000) < failure ? 1 : assigned.some((x) => x.is_bond_train) ? 3 : 2
        const mood = this.tables
            .get('game_events_cul_mood')
            .find((x) => x.systemId === id && x.moodLevel === g.growup_mood.mood_level)
        ensure(mood, 'Unknown cultivation mood', ErrorCode.GameConfig)
        const modifier =
            result === 1 ? config.failModifier : result === 3 ? config.greatSuccessModifier : config.successModifier
        const changes = []
        for (const [attr, value] of pairs(row.addTrainAttr)) {
            const target = g.growup_train_attr.find((x) => x.attr_id === attr)
            ensure(target, 'Unknown cultivation training attribute', ErrorCode.GameConfig)
            let amount = BigInt(value + (additions.get(attr) ?? 0)) * 10000n
            amount = (amount * BigInt(modifier)) / 10000n
            amount = (amount * BigInt(statusModifiers.get(attr))) / 10000n
            amount = (amount * BigInt(mood.moodModifier + moodBoost)) / 10000n
            amount = (amount * BigInt(assistModifier)) / 10000n
            amount = (amount * bondModifier) / 10000n
            const before = target.attr_value
            target.attr_value = Math.min(config.maxAttr, before + Number(amount / 10000n))
            changes.push({ attr_id: attr, attr_value: target.attr_value - before })
        }
        g.growup_stamina.stamina = Math.max(0, remaining)
        option.train_exp += row.addEXP
        const levels = this.tables
            .get('game_events_cul_train')
            .filter((x) => x.systemId === id && x.trainOption === optionId)
            .sort((a, b) => a.trainLevel - b.trainLevel)
        while (true) {
            const next = levels.find((x) => x.trainLevel === option.train_lv + 1)
            if (!next || option.train_exp < next.needEXP) break
            option.train_exp -= next.needEXP
            option.train_lv = next.trainLevel
        }
        g.growup_train_exp += row.addEXP
        for (const assistant of assigned) {
            const previous = assistantLevel(this, assistant).bondLevel
            assistant.bond += Math.trunc((row.addBond * bondPointsModifier) / 10000)
            const next = assistantLevel(this, assistant)
            if (next.bondLevel > previous) this.effects(g, id, next.lvlupeffect)
        }
        growupCommonTriggers(this, g, id, { kind: 1, variant: optionId, result, detail: 0 }, randomInt)
        const dayChanged = this.advance(g, id)
        this.afterAction(entry, id, dayChanged, randomInt)
        return { result, changes, dayChanged, failure }
    }
    rest(entry, id, randomInt) {
        const g = this.requireRun(entry, id),
            config = this.config(id)
        this.prepare(entry, id, randomInt)
        const row = this.weighted(
            this.tables.get('game_events_cul_rest').filter((x) => x.systemId === id),
            'weight',
            randomInt,
        )
        g.growup_stamina.stamina = Math.min(config.maxStamina, g.growup_stamina.stamina + row.addStamina)
        this.effects(g, id, row.effect)
        growupCommonTriggers(this, g, id, { kind: 2, variant: 1, result: 0, detail: 0 }, randomInt)
        if (row.type === 3) g.rest_interact_pending_id = row.rest
        const dayChanged = row.type !== 3 && this.advance(g, id)
        if (row.type !== 3) this.afterAction(entry, id, dayChanged, randomInt)
        return { row, dayChanged }
    }
    eventInfo(g, id) {
        return g.cur_event_data ?? { activity_id: id, event_id: 0, cur_step: 0, event_option_infos: [] }
    }
    endQuery(g, id) {
        return {
            activity_id: id,
            end_data: g.end_data.complete_end.map((x) => ({
                id: x.id,
                state: 1,
                history_top_rating: x.top_rating,
                chrs: x.chrs,
                attrs: x.attrs,
                trails: x.trails,
                starting_ids: x.starting_ids,
            })),
        }
    }
    selectEvent(entry, id, request, randomInt) {
        const g = this.ensure(entry, id),
            config = this.config(id)
        ensure(
            g.cur_starting_id > 0 && !g.rest_interact_pending_id && g.cur_growup_trail_stage !== g.cur_stage,
            'Cultivation event is unavailable in current phase',
        )
        const event = g.event_datas.find((x) => x.event_id === request.event_id && !x.finish)
        ensure(event, 'Cultivation event was not offered')
        const steps = this.tables.get('game_events_cul_eventstep').filter((x) => x.systemId === request.event_id)
        if (!g.cur_event_data?.event_id) {
            ensure(g.cur_cost_expedition_count > 0, 'No cultivation expedition points remain')
            const first = steps.find((x) => x.isFirstStep === 1)
            ensure(first, 'Missing cultivation event first step', ErrorCode.ActivityGrowUpInvalidEvent)
            // ModuleTravelPanel sends the first step's entrance option directly;
            // there is no mandatory optional_id=0 handshake in the CBT3 UI.
            if (request.optional_id)
                ensure(
                    ids(first.option).includes(request.optional_id),
                    'Option does not belong to current cultivation step',
                )
            g.cur_event_data = {
                activity_id: id,
                event_id: event.event_id,
                cur_step: first.step,
                event_option_infos: [],
            }
            event.cur_step = first.step
            if (!request.optional_id)
                return { activity_id: id, event_id: event.event_id, optional_id: 0, is_identify_success: true }
        }
        ensure(g.cur_event_data.event_id === event.event_id, 'Another cultivation event is active')
        const step = steps.find((x) => x.step === g.cur_event_data.cur_step)
        ensure(step, 'Missing cultivation event step', ErrorCode.ActivityGrowUpInvalidEvent)
        let next = step.nextStep
        let identified = true
        let selected = request.optional_id ?? 0
        if (!selected && step.option) {
            const options = this.tables
                .get('game_events_cul_eventoption')
                .filter(
                    (x) =>
                        ids(step.option).includes(x.optionId) &&
                        x.buttonType === 0 &&
                        this.condition(x.unlockCondition, g),
                )
            ensure(options.length, 'Select an offered cultivation event option')
            selected = this.weighted(options, 'weight', randomInt).optionId
        }
        if (selected) {
            ensure(ids(step.option).includes(selected), 'Option does not belong to current cultivation step')
            const option = this.tables.get('game_events_cul_eventoption').find((x) => x.optionId === selected)
            ensure(option && this.condition(option.unlockCondition, g), 'Cultivation event option is locked')
            ensure(option.costPoints <= g.cur_cost_expedition_count, 'No cultivation expedition points remain')
            if (option.checkType) {
                const attr = g.growup_train_attr.find((x) => x.attr_id === option.checkType)
                ensure(attr, 'Unknown cultivation check attribute', ErrorCode.GameConfig)
                const rank = this.tables
                    .get('game_events_cul_attrRate')
                    .filter((x) => x.eventid === id && attr.attr_value >= x.needAttr)
                    .sort((a, b) => b.needAttr - a.needAttr)[0]
                // TODO: verify the server-only checklevel adjustment with a real
                // event callback. Compatibility uses the client's six-sided die
                // plus the table's rank bonus against table checkDifficulty.
                identified = randomInt(6) + 1 + (rank?.ACBonus ?? 0) >= option.checkDifficulty
            }
            this.effects(g, id, identified ? option.effect : option.effectFail)
            g.cur_cost_expedition_count -= option.costPoints
            next = identified ? option.nextStep : option.nextStepFail
            g.cur_event_data.event_option_infos.push({ optional_id: option.optionId, is_identify_success: identified })
        } else ensure(!step.option, 'Select an offered cultivation event option')
        if (next > 0) {
            ensure(
                steps.some((x) => x.step === next),
                'Missing cultivation event next step',
                ErrorCode.ActivityGrowUpInvalidEvent,
            )
            event.cur_step = next
            g.cur_event_data.cur_step = next
        } else this.finishEvent(g, event)
        return {
            activity_id: id,
            event_id: event.event_id,
            optional_id: selected,
            is_identify_success: identified,
        }
    }
    finishEvent(g, event) {
        event.finish = true
        const record = g.evt_records.find((x) => x.id === event.event_id)
        if (record) record.complete_cnt++
        else g.evt_records.push({ id: event.event_id, complete_cnt: 1 })
        delete g.cur_event_data
    }
}
