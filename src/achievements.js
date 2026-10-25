import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { taskNodeCompleted } from './tasks.js'
import { NoviceTasks } from './novice-tasks.js'
import overrides from '../configs/achievement-overrides.json' with { type: 'json' }
import { achievementStateRule, achievementStateValue } from './achievement-state-progress.js'
import {
    productionProgressRule,
    productionProgressValue,
    productionCategoryRule,
    productionCategoryValue,
    cookingVarietyRule,
    cookingVarietyValue,
} from './production-progress.js'
import { heroRankProgressRule, heroRankProgressValue } from './hero-rank-progress.js'
import { petStarSoulProgressRule, petStarSoulProgressValue } from './pet-star-soul-progress.js'
import { entrustStarProgressRule, entrustStarProgressValue } from './entrust-star-progress.js'
import { captureCardStockRule, captureCardStockValue } from './capture-card-stock.js'
import { heroFavorProgressRule, heroFavorProgressValue } from './hero-favor-progress.js'
import { homeOrderProgressRule, homeOrderProgressValue } from './home-order-progress.js'
import { farmHarvestProgressRule, farmHarvestProgressValue } from './farm-harvest-progress.js'
import { loginDayProgressRule, loginDayProgressValue } from './login-day-progress.js'
import { parseAchievementExpression } from './achievement-expression.js'
import {
    readingAchievementRule,
    readingAchievementValue,
    compileReadingConjunction,
    readingConjunctionCounts,
} from './reading-achievements.js'

import { forgeProgressRule, forgeProgressValue } from './forge-progress.js'

import { buildingPlacementRule, buildingPlacementValue } from './building-placement-progress.js'

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
        // Unknown event and compound progress contracts stay unsupported.
        // Only separately verified leaf shapes may use the bounded parser.
        const tokens = /^\d+(#\d+)*$/.test(row.finishCondition) ? row.finishCondition.split('#').map(Number) : null
        const chain = (row.nextAchi_id ?? row.nextAchi ?? 0) !== 0 || row.firstAchi !== row.id
        const kind = tokens?.[0]
        const readingScalar =
            !chain &&
            !!tokens &&
            readingAchievementRule(tables, tokens) &&
            ((kind === 13064 && tokens.at(-1) === row.param) || (kind === 15032 && row.param === 1))
        const readingCompound =
            !chain && !tokens
                ? compileReadingConjunction(tables, parseAchievementExpression(row.finishCondition), row.param)
                : null
        const scalarSupported =
            !chain &&
            !!tokens &&
            tokens.every(Number.isSafeInteger) &&
            ((kind === 2007 && tokens.length === 2) ||
                (kind === 12045 && tokens.length === 3) ||
                (kind === 2004 && tokens.length === 2) ||
                sharedRule(tokens) ||
                achievementStateRule(tokens) ||
                (tokens.at(-1) === row.param && loginDayProgressRule(tables, tokens)) ||
                (tokens.at(-1) === row.param && farmHarvestProgressRule(tables, tokens)) ||
                (tokens.at(-1) === row.param && homeOrderProgressRule(tables, tokens)) ||
                (tokens.at(-1) === row.param && captureCardStockRule(tables, tokens)) ||
                (tokens.at(-1) === row.param && entrustStarProgressRule(tables, tokens)) ||
                (tokens.at(-1) === row.param && heroFavorProgressRule(tables, tokens)) ||
                (tokens.at(-1) === row.param && petStarSoulProgressRule(tables, tokens)) ||
                (tokens.at(-1) === row.param && heroRankProgressRule(tables, tokens)) ||
                (tokens.at(-1) === row.param && productionProgressRule(tables, tokens)) ||
                (tokens.at(-1) === row.param && productionCategoryRule(tables, tokens)) ||
                (tokens.at(-1) === row.param && buildingPlacementRule(tables, tokens)) ||
                (tokens.at(-1) === row.param && cookingVarietyRule(tables, tokens)) ||
                (tokens.at(-1) === row.param && forgeProgressRule(tables, tokens)) ||
                readingScalar)
        const supported = scalarSupported || !!readingCompound
        rules.set(row.id, { tokens, supported, chain, readingScalar, readingCompound })
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
    if (rule.readingScalar) return readingAchievementValue(tables, state, rule.tokens, facts)
    const [kind, ...p] = rule.tokens
    if (kind === 2007) return completedTasks.has(p[0]) ? 1 : 0
    if (kind === 12045) return taskNodeCompleted(state, p[0], p[1]) ? 1 : 0
    if (kind === 2004) return state.player.basic_info.lv
    if (kind === 15045) return petStarSoulProgressValue(tables, state, rule.tokens, facts)
    if (kind === 12252) return entrustStarProgressValue(tables, state, rule.tokens, facts)
    if (kind === 13007) return heroFavorProgressValue(tables, state, rule.tokens, facts)
    if (kind === 12055) return heroRankProgressValue(tables, state, rule.tokens, facts)
    if (kind === 12018) return productionProgressValue(tables, state, rule.tokens, facts)
    if (kind === 15072) return forgeProgressValue(tables, state, rule.tokens, facts)
    if (kind === 15021) return productionCategoryValue(tables, state, rule.tokens, facts)
    if (kind === 15020 || kind === 13096) return buildingPlacementValue(tables, state, rule.tokens, facts)
    if (kind === 12210) return cookingVarietyValue(tables, state, rule.tokens, facts)
    if (kind === 15022) return captureCardStockValue(tables, state, rule.tokens, facts)
    if (kind === 15003) return homeOrderProgressValue(tables, state, rule.tokens, facts)
    if (kind === 12005) return farmHarvestProgressValue(tables, state, rule.tokens, facts)
    if (kind === 15048 || kind === 20003) return loginDayProgressValue(tables, state, rule.tokens, facts)
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
        const rule = model.rules.get(row.id)
        const loginRule = [15048, 20003].includes(rule.tokens?.[0]) && rule.supported
        if (loginRule)
            ensure(
                (!saved?.claimed || saved.finishTime > 0) && (!saved?.finishTime || saved.value === row.param),
                'Login achievement has no valid terminal receipt',
                ErrorCode.GameConfig,
            )
        if (rule.readingScalar || rule.readingCompound)
            ensure(
                !saved?.claimed || saved.finishTime > 0,
                'Reading claim has no terminal receipt',
                ErrorCode.GameConfig,
            )
        if (rule.readingCompound) {
            if (saved?.leafCounts !== undefined)
                ensure(
                    Array.isArray(saved.leafCounts) &&
                        saved.leafCounts.length === rule.readingCompound.leaves.length &&
                        saved.leafCounts.every((n) => n === 0 || n === 1),
                    'Invalid reading leaf progress shape',
                    ErrorCode.GameConfig,
                )
            const leafCounts = readingConjunctionCounts(tables, state, rule.readingCompound, facts),
                sameCounts = JSON.stringify(saved?.leafCounts) === JSON.stringify(leafCounts)
            if (saved?.finishTime) {
                // Preserve an existing terminal/import receipt, but never turn
                // its scalar value into invented leaves or owned book records.
                if (!sameCounts) {
                    ledger.entries[row.id] = { ...saved, leafCounts }
                    changed.push(row.id)
                }
                continue
            }
            const value = leafCounts.reduce((n, count) => n + count, 0)
            if ((!value && !saved) || (value === saved?.value && sameCounts)) continue
            ledger.entries[row.id] = {
                value,
                leafCounts,
                finishTime: leafCounts.every((count) => count === 1) ? Math.floor(now) : 0,
                claimed: false,
            }
            changed.push(row.id)
            continue
        }
        if (saved?.finishTime) continue
        const raw = observedValue(tables, model, row, state, completedTasks, facts)
        if (raw === null) continue
        ensure(Number.isSafeInteger(raw) && raw >= 0, 'Invalid achievement progress', ErrorCode.GameConfig)
        const value =
            rule.readingScalar || loginRule
                ? Math.min(row.param, raw)
                : Math.max(saved?.value ?? 0, Math.min(row.param, raw))
        if ((!value && !saved) || (value === saved?.value && (!loginRule || value < row.param))) continue
        ledger.entries[row.id] = { value, finishTime: value >= row.param ? Math.floor(now) : 0, claimed: false }
        changed.push(row.id)
    }
    return changed
}

function wireAchievement(model, ledger, id) {
    const saved = ledger.entries[id]
    const rule = model.rules.get(id)
    return {
        id,
        achievement_id: id,
        count: rule.supported
            ? rule.readingCompound
                ? (saved?.leafCounts ?? rule.readingCompound.leaves.map(() => 0))
                : [saved?.value ?? 0]
            : [],
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
