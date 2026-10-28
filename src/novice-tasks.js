import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { noviceCounters } from './novice-counters.js'
import { noviceDuelVictoryRule, noviceDuelVictoryValue } from './novice-duel-victory.js'
import { noviceDuelFeverRule, noviceDuelFeverValue } from './novice-duel-fever.js'
import { noviceNpcEventRule, noviceNpcEventValue } from './novice-duel-events.js'

export class NoviceTasks {
    constructor(tables) {
        this.tables = tables
        this.tasks = new Map(tables.get('novice_task').map((r) => [r.id, r]))
        this.groups = new Map(tables.get('novice_task_group').map((r) => [r.id, r]))
    }
    ledger(state) {
        return (state.noviceTasks ??= { claimedTasks: {}, claimedGroups: {}, completedTasks: {} })
    }
    unlocked(state, group, seen = new Set()) {
        ensure(group && !seen.has(group.id), 'Invalid novice group chain', ErrorCode.GameConfig)
        seen.add(group.id)
        const ledger = this.ledger(state)
        if (group.exId) {
            const parent = this.groups.get(group.exId)
            ensure(parent, 'Missing novice parent group', ErrorCode.GameConfig)
            if (!this.unlocked(state, parent, seen) || !ledger.claimedGroups[parent.id]) return false
        }
        const tokens = String(group.unlockContidion || '')
            .split('#')
            .map(Number)
        if (!group.unlockContidion) return true
        if (tokens[0] === 2007 && tokens.length === 2)
            return (state.taskRecords ?? []).some((record) => record.task_id === tokens[1] && record.count > 0)
        return false // Unknown group conditions never silently open the group.
    }
    value(state, row) {
        const [kind, ...p] = String(row.finishCondition).split('#').map(Number)
        ensure([kind, ...p].every(Number.isSafeInteger), 'Invalid novice condition', ErrorCode.GameConfig)
        const counters = noviceCounters(state)
        switch (kind) {
            case 2004:
                return state.player.basic_info.lv
            case 13002:
                return state.player.heros_info.heros.filter((h) => !h.trail && h.hero_lv >= p[0]).length
            case 13006:
                if (p[0] !== 0) return null
                return state.player.soulessence_infos.soulessences.filter((s) => s.id > 0 && s.lv >= p[1]).length
            case 13035:
                if (p[0] !== 0) return null
                return state.pets.filter(
                    (pet) =>
                        !pet.trail &&
                        !(state.trialGroup?.pets ?? []).some((trial) => trial.guid === pet.guid) &&
                        pet.lv >= p[1],
                ).length
            case 11006:
                return counters.staminaSpent
            case 12014:
                return p[0] === 0 && p[1] === 0 ? counters.captures : null
            case 13053:
                if (!noviceDuelVictoryRule(this.tables, [kind, ...p])) return null
                ensure(p[2] === row.param, 'Novice duel victory threshold mismatch', ErrorCode.GameConfig)
                return noviceDuelVictoryValue(state, p[0], p[1])
            case 13055:
            case 13056:
                if (!noviceNpcEventRule(this.tables, [kind, ...p])) return null
                ensure(p[2] === row.param, 'Novice NPC event threshold mismatch', ErrorCode.GameConfig)
                return noviceNpcEventValue(state, kind, p[0], p[1])
            case 13058:
                if (!noviceDuelFeverRule([kind, ...p])) return null
                ensure(p[0] === row.param, 'Novice fever victory threshold mismatch', ErrorCode.GameConfig)
                return noviceDuelFeverValue(state)
            // TODO: the other4 duel tutorial conditions need actual receipts for
            // elemental KOs and distinct pets.
            // Do not infer them from the current team or a first-clear record.
            default:
                return null
        }
    }
    observe(state) {
        const ledger = this.ledger(state)
        for (const row of this.tasks.values()) {
            const group = this.groups.get(row.groupId)
            ensure(group, 'Missing novice task group', ErrorCode.GameConfig)
            if (!group.canAcceptEarly && !this.unlocked(state, group)) continue
            const value = this.value(state, row)
            if (value !== null && value >= row.param) ledger.completedTasks[row.id] = true
        }
    }
    snapshot(state) {
        this.observe(state)
        const ledger = this.ledger(state)
        return {
            groups: [...this.groups.values()].map((group) => ({
                group_id: group.id,
                finished: !!ledger.claimedGroups[group.id],
                tasks: [...this.tasks.values()]
                    .filter((row) => row.groupId === group.id)
                    .map((row) => ({
                        task_id: row.id,
                        task_value: ledger.completedTasks[row.id]
                            ? row.param
                            : Math.min(row.param, this.value(state, row) ?? 0),
                        task_status: ledger.claimedTasks[row.id] ? 2 : ledger.completedTasks[row.id] ? 1 : 0,
                    })),
            })),
        }
    }
    notify(c) {
        const data = this.snapshot(c.state),
            signature = JSON.stringify(data)
        const ledger = this.ledger(c.state)
        if (ledger.signature === signature) return
        ledger.signature = signature
        c.pushBefore('CSProtoNoviceTaskInfoSync', data)
    }
    initial(state) {
        const data = this.snapshot(state)
        this.ledger(state).signature = JSON.stringify(data)
        return data
    }
}
