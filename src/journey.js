import { journeyAbyssRule, journeyAbyssValue } from './journey-abyss.js'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { taskNodeCompleted } from './tasks.js'
import { guidedConditionValue } from './guided-conditions.js'
import { grantRewards, parseRewards } from './rewards.js'
import overrides from '../configs/journey-overrides.json' with { type: 'json' }
import { rewardSource } from './reward-source.js'
import { capturedPetVarieties } from './capture-variety.js'
import { productionProgressRule, productionProgressValue } from './production-progress.js'
import { forgeProgressRule, forgeProgressValue, forgeProgressRevision } from './forge-progress.js'
import { worldChestsOpened } from './world-chest-progress.js'
import { heroRankProgressRule, heroRankProgressValue } from './hero-rank-progress.js'
import { compileJourneyUnlocks, journeyReputationFacts } from './journey-unlocks.js'
import { petStarSoulProgressRule, petStarSoulProgressValue } from './pet-star-soul-progress.js'
import { worldCollectionProgressRule, worldCollectionProgressValue } from './world-collection-progress.js'
import { homeOrderProgressRule, homeOrderProgressValue } from './home-order-progress.js'
import { heroGiftProgressFacts, heroGiftProgressRule, heroGiftProgressValue } from './hero-gift-progress.js'

const models = new WeakMap()
const integers = (text, separator = '|') =>
    String(text || '')
        .split(separator)
        .filter(Boolean)
        .map(Number)
const uint = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff
const shared = new Set([12027, 12033, 12040, 12067, 12070, 13020, 13044, 15013])
const direct = new Set([13111, 2007, 12014, 12045, 12046, 12072, 12229, 13002, 13006, 13035, 13104, 15017])
function supportedShape(tokens, tables) {
    const [kind, ...p] = tokens,
        positive = (values) => values.every((v) => uint(v) && v > 0)
    if ([2007, 13020, 15017].includes(kind)) return p.length === 1 && positive(p)
    if ([12027, 12045, 12229, 13002, 13044, 13104, 15013].includes(kind)) return p.length === 2 && positive(p)
    if (kind === 12014) return p.length === 3 && p[0] === 0 && p[1] === 0 && p[2] > 0
    if ([12046, 13006, 13035].includes(kind))
        return p.length === (kind === 12046 ? 2 : 3) && p[0] === 0 && positive(p.slice(1))
    // Native dispatch has no local implementation for selector 2.
    // Keep these targets visible but unsupported until semantics are proven.
    if (kind === 12235) return false // Native dispatch lacks this node; selector 2 is unproven.
    if (kind === 12033) return p.length === 5 && positive(p)
    if (kind === 12040) return p.length === 3 && p[0] > 0 && p[1] >= 0 && p[2] > 0
    if (kind === 12067) return p.length === 3 && positive(p)
    if (kind === 12070) return p.length === 2 && p[0] === 1 && p[1] > 0
    if (kind === 13111) return journeyAbyssRule(tables, tokens)
    if (kind === 15072) return forgeProgressRule(tables, tokens)
    if (kind === 12018) return productionProgressRule(tables, tokens)
    if (kind === 12055) return heroRankProgressRule(tables, tokens)
    if (kind === 15045) return petStarSoulProgressRule(tables, tokens)
    if (kind === 13039) return worldCollectionProgressRule(tables, tokens)
    if (kind === 15003) return homeOrderProgressRule(tables, tokens)
    if ([12227, 12228].includes(kind)) return heroGiftProgressRule(tokens)
    if (kind === 12072) return p.length === 2 && p[0] === 0 && uint(p[1]) && p[1] > 0
    return false
}
// These are domains, not per-target exceptions. Other condition kinds remain
// represented in the full wire catalogue and in the coverage report.
export function journeyModel(tables) {
    if (models.has(tables)) return models.get(tables)
    const targets = tables.get('journey_task_target').map((row) => ({ ...row, ...overrides.targets[row.id] }))
    const tasks = tables.get('journey_task'),
        tabs = tables.get('journey_tab')
    const byTarget = new Map(),
        byTask = new Map(),
        owner = new Map(),
        byKind = new Map()
    const guided = new Map(tables.get('task_condition').map((r) => [r.condition, r]))
    for (const row of targets) {
        const tokens = integers(row.condition)
        ensure(
            uint(row.id) &&
                row.id > 0 &&
                !byTarget.has(row.id) &&
                tokens.length > 0 &&
                tokens.every(uint) &&
                uint(row.targetParam) &&
                row.targetParam > 0 &&
                uint(row.completePoint),
            'Invalid journey target configuration',
            ErrorCode.JourneyConfError,
        )
        row.tokens = tokens
        row.supported =
            (direct.has(tokens[0]) ||
                shared.has(tokens[0]) ||
                [12018, 12055, 15045, 13039, 15003, 12227, 12228, 15072].includes(tokens[0])) &&
            supportedShape(tokens, tables) &&
            (tokens[0] !== 13111 || row.targetParam === 1) &&
            (![12018, 12055, 12072, 15045, 13039, 15003, 12227, 12228, 15072].includes(tokens[0]) ||
                tokens.at(-1) === row.targetParam)
        row.guidedId = guided.get(row.condition)?.id
        byTarget.set(row.id, row)
        if (!byKind.has(tokens[0])) byKind.set(tokens[0], [])
        byKind.get(tokens[0]).push(row)
    }
    for (const row of tasks) {
        const ids = integers(row.param)
        ensure(
            uint(row.id) &&
                row.id > 0 &&
                !byTask.has(row.id) &&
                ids.length > 0 &&
                ids.every((id) => byTarget.has(id)) &&
                [0, 1].includes(row.taskType) &&
                tabs.some((tab) => tab.id === row.tabId),
            'Invalid journey task configuration',
            ErrorCode.JourneyConfError,
        )
        byTask.set(row.id, { ...row, ids, unlockRules: compileJourneyUnlocks(tables, row.unlockCondition) })
        for (const id of ids) {
            ensure(!owner.has(id), 'Journey target has multiple owners', ErrorCode.JourneyConfError)
            owner.set(id, row.id)
        }
    }
    // CBT3 retains twenty unreferenced target rows (including seventeen old
    // auto-reward tutorial rows). They are not active tasks or free rewards.
    const compiledTabs = tabs.map((row) => ({
        ...row,
        unlockRules: compileJourneyUnlocks(tables, row.unlockCondition),
    }))
    const sourceTasks = new Set(),
        sourceNodes = new Map(),
        sourceEntrusts = new Set(),
        sourceReputations = new Set()
    const index = ([kind, id, node]) => {
        if (kind === 13044) sourceEntrusts.add(id)
        if (kind === 61001) sourceReputations.add(id)
        if (kind === 2007) sourceTasks.add(id)
        if (kind === 12045) {
            sourceTasks.add(id)
            if (!sourceNodes.has(id)) sourceNodes.set(id, new Set())
            sourceNodes.get(id).add(node)
        }
    }
    for (const row of [...compiledTabs, ...byTask.values()]) for (const rule of row.unlockRules) index(rule)
    for (const row of targets) if (row.supported) index(row.tokens)
    const model = {
        targets,
        tasks: [...byTask.values()],
        tabs: compiledTabs,
        tabById: new Map(compiledTabs.map((row) => [row.id, row])),
        byTarget,
        byTask,
        owner,
        byKind,
        referencedTargets: targets.filter((r) => owner.has(r.id)),
        supportedKinds: [...byKind.keys()].filter((kind) => byKind.get(kind).some((row) => row.supported)),
        sourceTaskIds: [...sourceTasks].sort((a, b) => a - b),
        sourceTaskSet: sourceTasks,
        sourceNodePairs: [...sourceNodes]
            .flatMap(([id, nodes]) => [...nodes].map((node) => [id, node]))
            .sort((a, b) => a[0] - b[0] || a[1] - b[1]),
        sourceNodes,
        sourceEntrustIds: [...sourceEntrusts].sort((a, b) => a - b),
        sourceReputationIds: [...sourceReputations].sort((a, b) => a - b),
        sourceAbyssIds: [
            ...new Set(targets.filter((row) => row.supported && row.tokens[0] === 13111).map((row) => row.tokens[1])),
        ].sort((a, b) => a - b),
        abyssPassedValue: (state, id) => journeyAbyssValue(tables, state, id),
    }
    models.set(tables, model)
    return model
}
export function journeyLedger(state) {
    const ledger = (state.journey ??= { version: 1, targets: {}, tasks: {}, traceId: 0, pointMask: 0, windowShow: 0 })
    ledger.targetRevision ??= 0
    ledger.claimRevision ??= 0
    ensure(
        ledger?.version === 1 &&
            ledger.targets &&
            !Array.isArray(ledger.targets) &&
            ledger.tasks &&
            !Array.isArray(ledger.tasks) &&
            [ledger.traceId, ledger.pointMask, ledger.windowShow, ledger.targetRevision, ledger.claimRevision].every(
                uint,
            ),
        'Malformed journey ledger',
        ErrorCode.JourneyTypeDateError,
    )
    return ledger
}
function permanentPets(state) {
    const trial = new Set((state.trialGroup?.pets ?? []).map((p) => String(p.guid)))
    return (state.pets ?? []).filter((p) => !p.trail && !trial.has(String(p.guid)))
}
export function journeyValue(tables, state, row, facts = new Map()) {
    const [kind, ...p] = row.tokens,
        heroes = state.player.heros_info.heros.filter((h) => !h.trail)
    if (!row.supported) return null
    if (kind === 2007) return state.taskRecords?.some((r) => r.task_id === p[0] && r.count > 0) ? 1 : 0
    if (kind === 12045) return taskNodeCompleted(state, p[0], p[1]) ? 1 : 0
    if (kind === 13002) return heroes.filter((h) => h.hero_lv >= p[0]).length
    if (kind === 13006)
        return state.player.soulessence_infos.soulessences.filter((s) => s.id > 0 && s.lv >= p[1]).length
    if (kind === 13035) return permanentPets(state).filter((pet) => pet.lv >= p[1]).length
    if (kind === 12014)
        return (
            state.noviceCounters?.captures ??
            Object.values(state.petCaptureResults ?? {}).filter((r) => r.guid && r.pet_id > 0).length
        )
    if (kind === 12046) return capturedPetVarieties(tables, state)
    if (kind === 12229) return heroes.filter((h) => h.favorability_lv >= p[0]).length
    if (kind === 12235)
        return heroes.filter(
            (h) =>
                Number(h.wguid) > 0 &&
                state.player.soulessence_infos.soulessences.some(
                    (s) => String(s.guid) === String(h.wguid) && s.wear_hero === h.guid,
                ),
        ).length
    if (kind === 13104) return state.exploration?.map_info?.find((r) => r.map_id === p[0])?.lv ?? 0
    if (kind === 13111) return journeyAbyssValue(tables, state, p[0])
    if (kind === 15017) return state.home?.level ?? 0
    if (kind === 12055) return heroRankProgressValue(tables, state, row.tokens)
    if (kind === 15045) return petStarSoulProgressValue(tables, state, row.tokens, facts)
    if (kind === 13039) return worldCollectionProgressValue(tables, state, row.tokens, facts)
    if (kind === 15003) return homeOrderProgressValue(tables, state, row.tokens, facts)
    if ([12227, 12228].includes(kind)) return heroGiftProgressValue(state, row.tokens)
    if (kind === 15072) return forgeProgressValue(tables, state, row.tokens, facts)
    if (kind === 12018) return productionProgressValue(tables, state, row.tokens)
    if (kind === 12072) return worldChestsOpened(tables, state)
    if (row.guidedId) return guidedConditionValue(row.guidedId, state)
    // Shared evaluator accepts a table row, so journey and main quest do not
    // maintain competing building / cooking / shop / stock interpretations.
    return guidedConditionValue(0, state, undefined, { condition: row.condition })
}
function entrustFacts(model, state) {
    return new Map(
        model.sourceEntrustIds.map((id) => {
            const stars = state.entrust?.records?.[id]?.entrust_star ?? 0
            ensure(uint(stars) && stars <= 3, 'Invalid journey commission star history', ErrorCode.GameConfig)
            return [id, stars]
        }),
    )
}
function sourceFacts(model, state) {
    const completed = new Set()
    for (const record of state.taskRecords ?? [])
        if (record.count > 0 && model.sourceTaskSet.has(record.task_id)) completed.add(record.task_id)
    const nodes = new Set()
    for (const task of state.tasks ?? []) {
        const wanted = model.sourceNodes.get(task.task_id)
        if (!wanted) continue
        for (const node of task.finish_nodes ?? []) if (wanted.has(node)) nodes.add(task.task_id + ':' + node)
    }
    const level = state.player.basic_info.lv,
        entrusts = entrustFacts(model, state),
        homeLevel = state.home?.level ?? 0,
        reputations = journeyReputationFacts(model, state)
    ensure(uint(homeLevel), 'Malformed journey home level', ErrorCode.GameConfig)
    const key = [
        level,
        homeLevel,
        ...model.sourceReputationIds.map((id) => reputations.get(id)),
        ...model.sourceTaskIds.map((id) => (completed.has(id) ? 1 : 0)),
        ...model.sourceNodePairs.map(([id, node]) => (completed.has(id) || nodes.has(id + ':' + node) ? 1 : 0)),
        ...model.sourceEntrustIds.map((id) => entrusts.get(id)),
    ].join(',')
    return { completed, nodes, entrusts, level, homeLevel, reputations, key }
}
function syncKey(ledger, facts) {
    return [
        facts.key,
        ledger.targetRevision,
        ledger.claimRevision,
        ledger.traceId,
        ledger.pointMask,
        ledger.windowShow,
    ].join('/')
}
function bump(ledger, field) {
    ensure(uint(ledger[field] + 1), 'Journey revision overflow', ErrorCode.JourneyTypeDateError)
    ledger[field]++
}
function evaluation(model, state, facts = sourceFacts(model, state)) {
    const ledger = journeyLedger(state),
        unlocked = new Map(),
        completed = new Map(),
        tabs = new Map()
    const pendingUnlock = new Set(),
        pendingComplete = new Set()
    const rules = (list) =>
        list.every(([kind, id, node]) => {
            if (kind === 2004) return facts.level >= id
            if (kind === 15017) return facts.homeLevel >= id
            if (kind === 61001) return (facts.reputations.get(id) ?? 0) >= node
            if (kind === 2007) return facts.completed.has(id)
            if (kind === 12045) return facts.completed.has(id) || facts.nodes.has(id + ':' + node)
            if (kind === 13044)
                return uint(id) && id > 0 && uint(node) && node > 0 && (facts.entrusts.get(id) ?? 0) >= node
            if (kind === 12096) return isComplete(id)
            if (kind === 12098) return !!ledger.tasks[id]?.claimed
            return false
        })
    const tabUnlocked = (id) => {
        if (!tabs.has(id)) tabs.set(id, rules(model.tabById.get(id).unlockRules))
        return tabs.get(id)
    }
    const isUnlocked = (id) => {
        if (unlocked.has(id)) return unlocked.get(id)
        if (pendingUnlock.has(id)) return false
        const row = model.byTask.get(id)
        if (!row) return false
        pendingUnlock.add(id)
        const value = tabUnlocked(row.tabId) && rules(row.unlockRules)
        pendingUnlock.delete(id)
        unlocked.set(id, value)
        return value
    }
    const isComplete = (id) => {
        if (completed.has(id)) return completed.get(id)
        if (pendingComplete.has(id)) return false
        const row = model.byTask.get(id)
        if (!row) return false
        pendingComplete.add(id)
        const value =
            isUnlocked(id) &&
            row.ids.reduce((n, target) => n + (ledger.targets[target]?.complete ? 1 : 0), 0) >=
                (row.needCompleteNum || row.ids.length)
        pendingComplete.delete(id)
        completed.set(id, value)
        return value
    }
    return { facts, tabUnlocked, isUnlocked, isComplete }
}
export function journeyUnlocked(model, state, task) {
    return evaluation(model, state).isUnlocked(task.id)
}
export function taskComplete(model, state, id) {
    return evaluation(model, state).isComplete(id)
}
export function observeJourney(tables, state, kinds) {
    const model = journeyModel(tables),
        ledger = journeyLedger(state),
        changed = [],
        facts = new Map()
    const rows = kinds ? [...new Set(kinds)].flatMap((kind) => model.byKind.get(kind) ?? []) : model.targets
    for (const row of rows) {
        const saved = ledger.targets[row.id]
        if (saved)
            ensure(
                uint(saved.value) &&
                    saved.value <= row.targetParam &&
                    typeof saved.complete === 'boolean' &&
                    typeof saved.claimed === 'boolean' &&
                    (!saved.claimed || saved.complete),
                'Malformed journey target receipt',
                ErrorCode.JourneyTargetDateError,
            )
        if (saved?.complete || !row.supported) continue
        const raw = journeyValue(tables, state, row, facts)
        if (raw === null) continue
        ensure(uint(raw), 'Invalid journey condition value', ErrorCode.JourneyTargetDateError)
        const value = Math.max(saved?.value ?? 0, Math.min(row.targetParam, raw))
        if (!saved || value !== saved.value) {
            ledger.targets[row.id] = { value, complete: value >= row.targetParam, claimed: false }
            changed.push(row.id)
        }
    }
    if (changed.length) bump(ledger, 'targetRevision')
    if (kinds === undefined) ledger.observedSources = sourceRevisions(state, model)
    return changed
}
export function journeyPoints(model, state) {
    const ledger = journeyLedger(state)
    return model.targets.reduce((n, r) => n + (ledger.targets[r.id]?.claimed ? r.completePoint : 0), 0)
}
export function journeySnapshot(tables, state) {
    const model = journeyModel(tables),
        ledger = journeyLedger(state),
        resolver = evaluation(model, state)
    const snapshot = {
        journey_group: model.tabs.map((row) => ({
            group_id: row.id,
            group_is_unlock: resolver.tabUnlocked(row.id),
        })),
        journey_task: model.tasks.map((row) => ({
            task_id: row.id,
            task_is_unlock: resolver.isUnlocked(row.id),
            task_reward_status: ledger.tasks[row.id]?.claimed ? 2 : resolver.isComplete(row.id) ? 1 : 0,
        })),
        journey_target: model.referencedTargets.map((row) => ({
            target_id: row.id,
            target_progress: [{ condition_id: row.tokens[0], condition_val: ledger.targets[row.id]?.value ?? 0 }],
            target_reward_status: ledger.targets[row.id]?.claimed ? 2 : ledger.targets[row.id]?.complete ? 1 : 0,
        })),
        trace_id: ledger.traceId,
        point_val: journeyPoints(model, state),
        reward_index: ledger.pointMask,
        window_show: ledger.windowShow,
        ...(ledger.specialItem ? { special_item: ledger.specialItem } : {}),
    }
    ledger.sourceSignature = syncKey(ledger, resolver.facts)
    return snapshot
}
export function claimJourney(c, request) {
    const model = journeyModel(c.tables),
        ledger = journeyLedger(c.state),
        ids = request.u32s
    ensure(
        Array.isArray(ids) &&
            ids.length > 0 &&
            ids.length <= model.targets.length + model.tasks.length &&
            ids.every((id) => uint(id) && id > 0) &&
            new Set(ids).size === ids.length,
        'Invalid journey reward batch',
        ErrorCode.InvalidArgument,
    )
    observeJourney(c.tables, c.state)
    const claims = [],
        selectedTargets = new Set()
    const addTarget = (target, explicit) => {
        const saved = ledger.targets[target.id]
        if (saved?.claimed || selectedTargets.has(target.id)) return
        if (!explicit && (!target.supported || !saved?.complete)) return
        ensure(target.supported, 'Journey condition event source not implemented', ErrorCode.FunctionClosed)
        ensure(saved?.complete, 'Journey reward requirements are incomplete', ErrorCode.JourneyContReward)
        selectedTargets.add(target.id)
        claims.push({ id: target.id, target, row: target })
    }
    for (const id of ids) {
        const target = model.byTarget.get(id),
            task = model.byTask.get(id)
        ensure(target || task, 'Unknown journey reward target', ErrorCode.JourneyConfError)
        const owner = task ?? model.byTask.get(model.owner.get(id))
        ensure(owner, 'Journey target is not referenced by an active task', ErrorCode.JourneyConfError)
        ensure(journeyUnlocked(model, c.state, owner), 'Journey stage is locked', ErrorCode.JourneyTypeLock)
        if (target) {
            // Retain explicitly addressed target compatibility; current CBT3
            // UI sends the owning journey_task ID, not this target ID.
            addTarget(target, true)
            continue
        }
        // PageStarJourney.ReqCurPanelReward (0602a11b) sends every displayed
        // task ID. Claim its ready targets even while the card is incomplete.
        for (const targetId of task.ids) addTarget(model.byTarget.get(targetId), false)
        if (!ledger.tasks[id]?.claimed && taskComplete(model, c.state, id)) claims.push({ id, target: null, row: task })
    }
    const rewards = grantRewards(
        c.tables,
        c.state,
        claims.flatMap(({ row, target }) => parseRewards(target ? row.reward : row.taskReward)),
    )
    for (const { id, target } of claims) {
        const map = target ? ledger.targets : ledger.tasks
        map[id] = { ...map[id], ...(target ? {} : { complete: true }), claimed: true }
    }
    if (claims.length) bump(ledger, 'claimRevision')
    publishJourney(c)
    return { rewards, ...(rewards.length ? { src: rewardSource(c.tables, 'journeyTaskReward') } : {}) }
}
const dirtyKinds = [
    [/Gift/, [12227, 12228]],
    [/Task|Story/, [2007, 12045]],
    [/Hero|Soul|Ornament|Equip|Trial|Group/, [12055, 12229, 12235, 13002, 13006]],
    [/Pet|Catch|Hatch|Egg/, [12014, 12040, 12046, 13035, 15045]],
    [
        /Home|Build|Crop|Plant|Cook|Product|Ranch|Collection|Shop|Exchange|Item|GM|Playable|Entrust|Dungeon|WorldMapExplore/,
        [...shared, 12018, 15017, 13104, 13039, 15072],
    ],
]
function sourceRevisions(state, model) {
    const sources = {
        pet: state.petRevision ?? 0,
        home: state.homeRevision ?? 0,
        chest: state.worldChestHistory?.total ?? 0,
        reputation: state.reputationRevision ?? 0,
        forge: forgeProgressRevision(state),
        gift: heroGiftProgressFacts(state).revision,
        orders: state.homeExchange?.completedOrders ?? 0,
    }
    ensure(
        Object.values(sources).every((n) => Number.isSafeInteger(n) && n >= 0),
        'Invalid journey source revision',
        ErrorCode.GameConfig,
    )
    // These few referenced records can change during the battle-report path,
    // where general journey observation is deferred. A later ordinary request
    // must notice them even when its name does not match Entrust/Dungeon.
    return {
        ...sources,
        entrust: [...entrustFacts(model, state)].map(([id, stars]) => `${id}:${stars}`).join(','),
        abyss: model.sourceAbyssIds.map((id) => `${id}:${model.abyssPassedValue(state, id)}`).join(','),
    }
}
export function notifyJourney(c, protocolName) {
    const model = journeyModel(c.tables)
    const fresh = !c.state.journey
    const ledger = journeyLedger(c.state),
        revisions = sourceRevisions(c.state, model)
    if (fresh) observeJourney(c.tables, c.state)
    else {
        const kinds = dirtyKinds.filter(([pattern]) => pattern.test(protocolName)).flatMap(([, kinds]) => kinds)
        // Rewards and automatic settlements can change a domain under another
        // request name. Observe its real revision, not just the packet's label.
        if (ledger.observedSources?.pet !== revisions.pet) kinds.push(12014, 12040, 12046, 13035, 15045)
        if (ledger.observedSources?.home !== revisions.home) kinds.push(...shared, 12018, 15017, 13104, 13039)
        // Observe the authoritative aggregate, including claims under another
        // request name. Stable callbacks neither scan objects nor serialize state.
        if (ledger.observedSources?.chest !== revisions.chest) kinds.push(12072)
        if (ledger.observedSources?.entrust !== revisions.entrust) kinds.push(13044)
        if (ledger.observedSources?.reputation !== revisions.reputation) kinds.push(61001)
        if (ledger.observedSources?.abyss !== revisions.abyss) kinds.push(13111)
        if (ledger.observedSources?.forge !== revisions.forge) kinds.push(15072)
        if (ledger.observedSources?.orders !== revisions.orders) kinds.push(15003)
        if (ledger.observedSources?.gift !== revisions.gift) kinds.push(12227, 12228)
        if (!kinds.length && !/Journey/.test(protocolName)) return
        observeJourney(c.tables, c.state, /Journey|GM/.test(protocolName) ? model.supportedKinds : kinds)
    }
    // Lifetime migration may initialize the chest aggregate during evaluation.
    ledger.observedSources = sourceRevisions(c.state, model)
    const facts = sourceFacts(model, c.state)
    if (ledger.sourceSignature === syncKey(ledger, facts)) return
    publishJourney(c)
}
export function publishJourney(c) {
    const model = journeyModel(c.tables),
        ledger = journeyLedger(c.state)
    if (ledger.sourceSignature === syncKey(ledger, sourceFacts(model, c.state))) return
    const snapshot = journeySnapshot(c.tables, c.state)
    c.pushBefore('SCProtoJourneySync', snapshot)
}
