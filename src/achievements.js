import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { taskNodeCompleted } from './tasks.js'
import { NoviceTasks } from './novice-tasks.js'
import overrides from '../configs/achievement-overrides.json' with { type: 'json' }
import { achievementStateRule, achievementStateValue } from './achievement-state-progress.js'
import { productionProgressRule, productionProgressValue } from './production-progress.js'

const catalogues = new WeakMap()
function sharedRule(tokens) {
    const [kind, ...p] = tokens
    if (kind === 13002) return p.length === 2
    if ([13006, 13035].includes(kind)) return p.length === 3 && p[0] === 0
    if (kind === 11006) return p.length <= 1
    if (kind === 12014) return p.length === 3 && p[0] === 0 && p[1] === 0
    return false
}

export function achievementCatalogue(tables) {
    if (catalogues.has(tables)) return catalogues.get(tables)
    const rows = tables.get('achievement').map((row) => ({ ...row, ...overrides.rows[row.id] })),
        groups = tables.get('achievement_group')
    const byId = new Map(),
        groupIds = new Set(groups.map((row) => row.id)),
        rules = new Map()
    for (const row of rows) {
        ensure(
            Number.isSafeInteger(row.id) &&
                row.id > 0 &&
                !byId.has(row.id) &&
                groupIds.has(row.groupId) &&
                Number.isSafeInteger(row.param) &&
                row.param > 0 &&
                Number.isSafeInteger(row.achPoint) &&
                row.achPoint >= 0 &&
                typeof row.finishCondition === 'string',
            'Malformed achievement configuration',
            ErrorCode.AchievementConfFail,
        )
        byId.set(row.id, row)
        // Compound expressions and event kinds without a trustworthy server
        // receipt stay explicitly unsupported. Never infer completion from UI.
        const tokens = /^\d+(#\d+)*$/.test(row.finishCondition) ? row.finishCondition.split('#').map(Number) : null
        const chain = (row.nextAchi_id ?? row.nextAchi ?? 0) !== 0 || row.firstAchi !== row.id
        const kind = tokens?.[0]
        const supported =
            !chain &&
            !!tokens &&
            tokens.every(Number.isSafeInteger) &&
            ((kind === 2007 && tokens.length === 2) ||
                (kind === 12045 && tokens.length === 3) ||
                (kind === 2004 && tokens.length === 2) ||
                sharedRule(tokens) ||
                achievementStateRule(tokens) ||
                (tokens.at(-1) === row.param && productionProgressRule(tables, tokens)))
        rules.set(row.id, { tokens, supported, chain })
    }
    const model = { rows, byId, groups, rules, novice: new NoviceTasks(tables) }
    catalogues.set(tables, model)
    return model
}

export function achievementLedger(state) {
    const ledger = (state.achievements ??= { entries: {}, lastAwardPoint: 0 })
    ensure(
        ledger &&
            typeof ledger === 'object' &&
            ledger.entries &&
            !Array.isArray(ledger.entries) &&
            Number.isSafeInteger(ledger.lastAwardPoint) &&
            ledger.lastAwardPoint >= 0,
        'Malformed achievement ledger',
        ErrorCode.GameConfig,
    )
    return ledger
}

function observedValue(tables, model, row, state, completedTasks, facts) {
    const rule = model.rules.get(row.id)
    if (!rule.supported) return null
    const [kind, ...p] = rule.tokens
    if (kind === 2007) return completedTasks.has(p[0]) ? 1 : 0
    if (kind === 12045) return taskNodeCompleted(state, p[0], p[1]) ? 1 : 0
    if (kind === 2004) return state.player.basic_info.lv
    if (kind === 12018) return productionProgressValue(tables, state, rule.tokens, facts)
    if (achievementStateRule(rule.tokens)) return achievementStateValue(tables, state, rule.tokens, facts)
    return model.novice.value(state, { finishCondition: row.finishCondition })
}

export function observeAchievements(tables, state, now) {
    ensure(Number.isFinite(now) && now > 0, 'Invalid achievement clock', ErrorCode.GameConfig)
    const model = achievementCatalogue(tables),
        ledger = achievementLedger(state),
        changed = []
    const completedTasks = new Set((state.taskRecords ?? []).filter((row) => row.count > 0).map((row) => row.task_id)),
        facts = new Map()
    for (const row of model.rows) {
        const saved = ledger.entries[row.id]
        if (saved)
            ensure(
                Number.isInteger(saved.value) &&
                    saved.value >= 0 &&
                    saved.value <= row.param &&
                    Number.isSafeInteger(saved.finishTime) &&
                    saved.finishTime >= 0 &&
                    typeof saved.claimed === 'boolean',
                'Malformed achievement receipt',
                ErrorCode.GameConfig,
            )
        if (saved?.finishTime) continue
        const raw = observedValue(tables, model, row, state, completedTasks, facts)
        if (raw === null) continue
        ensure(Number.isSafeInteger(raw) && raw >= 0, 'Invalid achievement progress', ErrorCode.GameConfig)
        const value = Math.max(saved?.value ?? 0, Math.min(row.param, raw))
        if (!value || value === saved?.value) continue
        ledger.entries[row.id] = { value, finishTime: value >= row.param ? Math.floor(now) : 0, claimed: false }
        changed.push(row.id)
    }
    return changed
}

function wireAchievement(model, ledger, id) {
    const saved = ledger.entries[id]
    return {
        id,
        achievement_id: id,
        count: model.rules.get(id).supported ? [saved?.value ?? 0] : [],
        finish_time: String(saved?.finishTime ?? 0),
        is_reward: saved?.claimed ?? false,
        sub_ach_id: [],
        sub_ach_fini_time: [],
    }
}

function buildSnapshot(tables, state, selection) {
    const model = achievementCatalogue(tables),
        ledger = achievementLedger(state)
    return {
        groups: selection ? [] : model.groups.map((row) => ({ id: row.id, is_reward: false })),
        achievements: (selection ?? model.rows.map((row) => row.id)).map((id) => wireAchievement(model, ledger, id)),
        last_achievement_award_point: ledger.lastAwardPoint,
        achievement_medals: [],
    }
}

export function achievementSnapshot(tables, state, now, selection) {
    observeAchievements(tables, state, now)
    return buildSnapshot(tables, state, selection)
}

export function notifyAchievements(c, selection = []) {
    const changed = new Set([...selection, ...observeAchievements(c.tables, c.state, c.now)])
    if (changed.size) c.pushBefore('CSProtoAchievementSync', buildSnapshot(c.tables, c.state, [...changed]))
}

export function achievementPoints(tables, state) {
    const model = achievementCatalogue(tables),
        ledger = achievementLedger(state)
    let points = 0
    for (const [id, saved] of Object.entries(ledger.entries)) {
        const row = model.byId.get(Number(id))
        ensure(
            row && saved && Number.isSafeInteger(saved.finishTime) && saved.finishTime >= 0,
            'Unknown or malformed achievement receipt',
            ErrorCode.GameConfig,
        )
        if (saved.finishTime) {
            ensure(saved.value === row.param, 'Incomplete achievement receipt has a finish time', ErrorCode.GameConfig)
            points += row.achPoint
        }
    }
    ensure(Number.isSafeInteger(points) && points <= 0xffffffff, 'Achievement point overflow', ErrorCode.GameConfig)
    return points
}
