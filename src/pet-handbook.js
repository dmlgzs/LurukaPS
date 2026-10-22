import { createHash } from 'node:crypto'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const caches = new WeakMap()
const warnedAmbiguities = new Set()
const value = (row, key) => row?.[key + '_id'] ?? row?.[key]
const ids = (text) =>
    String(text ?? '')
        .split('|')
        .filter(Boolean)
        .map(Number)
        .filter((n) => n !== 0)
const firstElement = (pet) => Number(String(value(pet, 'element') ?? '0').split('|')[0])
function catalog(tables) {
    if (caches.has(tables)) return caches.get(tables)
    const tasks = new Map(tables.get('iconography_task').map((r) => [r.id, r]))
    const effects = new Map(tables.get('iconography_type').map((r) => [r.id, r]))
    const conditions = new Set(tables.get('common_condition').map((r) => r.id))
    const pets = new Map(tables.get('pet').map((r) => [r.id, r]))
    const dimensions = tables.get('pet_learningenum').map((r) => r.attributeEnum)
    ensure(
        dimensions.length === 6 && new Set(dimensions).size === 6,
        'Invalid handbook aptitude dimensions',
        ErrorCode.GameConfig,
    )
    const plans = new Map()
    for (const pet of pets.values()) {
        if (pet.iconographyshow !== 1) continue
        const roots = ids(value(pet, 'iconographyTaskId'))
        if (!roots.length) continue
        const candidates = tables
            .get('iconography_level')
            .filter((r) => r.petid === pet.id)
            .sort((a, b) => a.iconographyLevel - b.iconographyLevel || a.id - b.id)
        // Three current species have duplicate level keys. Lua takes a first
        // matching row; choose the lowest row ID deterministically and retain
        // the ambiguity for diagnostics rather than summing duplicate effects.
        const selected = new Map()
        for (const row of candidates) if (!selected.has(row.iconographyLevel)) selected.set(row.iconographyLevel, row)
        const levels = [...selected.values()]
        ensure(
            levels.length &&
                levels.every(
                    (r, i) =>
                        r.iconographyLevel === i + 1 &&
                        Number.isSafeInteger(r.exp) &&
                        (i === levels.length - 1 ? r.exp === 0 : r.exp > 0),
                ),
            'Invalid handbook level configuration',
            ErrorCode.GameConfig,
        )
        const visited = new Set(),
            chains = roots.map((root) => {
                const chain = []
                for (let id = root; id;) {
                    ensure(
                        Number.isSafeInteger(id) && id > 0 && !visited.has(id),
                        'Invalid handbook task chain',
                        ErrorCode.GameConfig,
                    )
                    visited.add(id)
                    const row = tasks.get(id),
                        parts = row && ids(row.taskcondition)
                    ensure(
                        row &&
                            parts.length === 3 &&
                            Number.isSafeInteger(parts[0]) &&
                            parts[0] > 0 &&
                            parts[1] === pet.id &&
                            Number.isSafeInteger(parts[2]) &&
                            parts[2] > 0 &&
                            Number.isSafeInteger(row.taskAward) &&
                            row.taskAward > 0,
                        'Invalid handbook task configuration',
                        ErrorCode.GameConfig,
                    )
                    ensure(conditions.has(parts[0]), 'Missing handbook condition definition', ErrorCode.GameConfig)
                    ensure(
                        [13051, 13052, 13081].includes(parts[0]),
                        'Handbook condition requires support',
                        ErrorCode.FunctionClosed,
                    )
                    ensure(
                        !chain.length || (chain.at(-1).kind === parts[0] && chain.at(-1).target < parts[2]),
                        'Handbook task thresholds are not increasing',
                        ErrorCode.GameConfig,
                    )
                    chain.push({ id, kind: parts[0], target: parts[2], xp: row.taskAward })
                    id = row.nextTaskId
                }
                return chain
            })
        for (const level of levels)
            for (const id of ids(level.attrReward)) {
                const effect = effects.get(id)
                ensure(effect, 'Missing handbook attribute reward', ErrorCode.GameConfig)
                ensure(
                    [5009, 5010].includes(effect.rewardtype),
                    'Handbook attribute reward requires support',
                    ErrorCode.FunctionClosed,
                )
                for (const term of String(effect.abilities || '')
                    .split('|')
                    .filter(Boolean)) {
                    const tuple = term.split('#').map(Number)
                    ensure(
                        tuple.length === 2 &&
                            Number.isSafeInteger(tuple[0]) &&
                            tuple[0] > 0 &&
                            Number.isSafeInteger(tuple[1]),
                        'Invalid handbook attribute amount',
                        ErrorCode.GameConfig,
                    )
                }
            }
        plans.set(pet.id, {
            pet,
            levels,
            chains,
            ambiguous: candidates.length !== levels.length,
            maxCasts: Math.max(
                0,
                ...chains
                    .flat()
                    .filter((r) => r.kind === 13081)
                    .map((r) => r.target),
            ),
        })
    }
    const data = { plans, effects, pets, dimensions }
    caches.set(tables, data)
    return data
}
export function handbookPlan(tables, id) {
    return catalog(tables).plans.get(id)
}
function wire(row) {
    return {
        pet_id: row.pet_id,
        tasks: row.tasks,
        lv: row.lv,
        exp: row.exp,
        had: true,
        rewarded_lv: row.rewarded_lv,
        colors: row.colors ?? [],
        colorfuls: row.colorfuls ?? [],
        report_reward_times: row.report_reward_times ?? 0,
        selected_colorful: row.selected_colorful ?? 0,
    }
}
export function petHandbookSnapshot(state, selection = undefined) {
    return {
        infos: Object.values(state.petHandbook ?? {})
            .filter((r) => !selection || selection.includes(r.pet_id))
            .sort((a, b) => a.pet_id - b.pet_id)
            .map(wire),
    }
}
export function markHandbookDirty(state, id) {
    state.petHandbookDirtyIds = [...new Set([...(state.petHandbookDirtyIds ?? []), id])]
}
export function takePetHandbookSync(state) {
    const pending = state.petHandbookDirtyIds ?? []
    state.petHandbookDirtyIds = []
    return pending.length ? petHandbookSnapshot(state, pending) : null
}
function minimumTalent(data, pet) {
    const levels = data.dimensions.map((attr) => pet.comprehension?.find((r) => r.attr_id === attr)?.level)
    return levels.every((n) => Number.isSafeInteger(n) && n > 0 && n <= 9) ? Math.min(...levels) : 0
}
function rebuildBonuses(data, state) {
    const bonuses = { own: {}, elements: {} }
    for (const row of Object.values(state.petHandbook ?? {})) {
        const plan = data.plans.get(row.pet_id)
        if (!plan) continue
        for (const level of plan.levels.filter((l) => l.iconographyLevel <= row.lv))
            for (const id of ids(level.attrReward)) {
                const effect = data.effects.get(id),
                    target = effect.rewardtype === 5009 ? bonuses.own : bonuses.elements
                const key = effect.rewardtype === 5009 ? row.pet_id : firstElement(plan.pet)
                const attrs = (target[key] ??= {})
                for (const term of String(effect.abilities || '')
                    .split('|')
                    .filter(Boolean)) {
                    const [attr, amount] = term.split('#').map(Number)
                    attrs[attr] = (attrs[attr] ?? 0) + amount
                }
            }
    }
    state.petHandbookBonuses = bonuses
}
// Observed maxima are retained after release/evolution. Old released pets
// have no recoverable training evidence and are not assigned invented values.
export function preparePetHandbook(tables, state, { force = false, only = undefined } = {}) {
    const records = state.recordPets ?? [],
        revision = state.petRevision ?? 0,
        key = records.join(',')
    if (!only && !force && state.handbookObservedPetRevision === revision && state.handbookObservedRecords === key)
        return false
    if (!records.length && !Object.keys(state.petHandbook ?? {}).length) {
        state.petHandbook ??= {}
        state.petHandbookBonuses ??= { own: {}, elements: {} }
        state.handbookObservedPetRevision = revision
        state.handbookObservedRecords = key
        return false
    }
    const data = catalog(tables),
        owned = new Map()
    for (const pet of state.pets ?? []) {
        if (pet.type === 2) continue
        if (!owned.has(pet.config_id)) owned.set(pet.config_id, [])
        owned.get(pet.config_id).push(pet)
    }
    let levelChanged = !state.petHandbookBonuses,
        changed = false
    const rows = { ...(state.petHandbook ?? {}) }
    for (const id of records) {
        if (only && !only.includes(id)) continue
        const plan = data.plans.get(id)
        if (!plan) continue
        if (plan.ambiguous && !warnedAmbiguities.has(id)) {
            warnedAmbiguities.add(id)
            try {
                console.warn(
                    '[pet-handbook] ' +
                        JSON.stringify({
                            reason: 'duplicate_level_keys',
                            pet_id: id,
                            policy: 'lowest_row_id',
                            selected_rows: plan.levels.map((r) => r.id),
                        }),
                )
            } catch {
                /* Diagnostics do not block earned progress. */
            }
        }
        const old = rows[id],
            specimens = owned.get(id) ?? []
        const maxLevel = Math.max(
            old?.max_level ?? 0,
            0,
            ...specimens.map((p) => (Number.isSafeInteger(p.lv) && p.lv > 0 ? p.lv : 0)),
        )
        const maxTalent = Math.max(old?.max_talent ?? 0, 0, ...specimens.map((p) => minimumTalent(data, p)))
        const casts = state.petHandbookCasts?.[id] ?? 0,
            metrics = { 13051: maxLevel, 13052: maxTalent, 13081: casts }
        const active = [],
            completed = []
        let xp = 0
        for (const chain of plan.chains) {
            for (const task of chain)
                if (metrics[task.kind] >= task.target) {
                    completed.push(task.id)
                    xp += task.xp
                }
            const current = chain.find((t) => metrics[t.kind] < t.target) ?? chain.at(-1)
            active.push({
                task_id: current.id,
                count: Math.min(metrics[current.kind], current.target),
                complete: metrics[current.kind] >= current.target,
            })
        }
        let lv = 1,
            exp = xp
        while (lv < plan.levels.length && exp >= plan.levels[lv - 1].exp) {
            exp -= plan.levels[lv - 1].exp
            lv++
        }
        if (lv === plan.levels.length) exp = 0
        ensure(
            !old || (Number.isSafeInteger(old.rewarded_lv) && old.rewarded_lv >= 1 && old.rewarded_lv <= lv),
            'Invalid saved handbook reward progress',
            ErrorCode.GameConfig,
        )
        const row = {
            ...old,
            pet_id: id,
            tasks: active,
            lv,
            exp,
            rewarded_lv: old?.rewarded_lv ?? 1,
            max_level: maxLevel,
            max_talent: maxTalent,
            total_exp: xp,
            completed_tasks: completed,
        }
        rows[id] = row
        if (!old || JSON.stringify(wire(old)) !== JSON.stringify(wire(row))) {
            markHandbookDirty(state, id)
            changed = true
        }
        if (!old || old.lv !== lv) levelChanged = true
    }
    state.petHandbook = rows
    if (levelChanged) rebuildBonuses(data, state)
    if (!only) {
        state.handbookObservedPetRevision = revision
        state.handbookObservedRecords = key
    }
    return changed
}
export function petHandbookAttributes(tables, state, pet, bonuses = state.petHandbookBonuses) {
    const result = new Map()
    if (!bonuses || pet.type === 2) return result
    const element = firstElement(catalog(tables).pets.get(pet.config_id))
    for (const dict of [bonuses.own?.[pet.config_id], bonuses.elements?.[element]])
        for (const [key, amount] of Object.entries(dict ?? {}))
            result.set(Number(key), (result.get(Number(key)) ?? 0) + amount)
    return result
}
export function recordHandbookSkill(c, pet, request) {
    const plan = handbookPlan(c.tables, pet.config_id)
    if (!plan || pet.type === 2 || !(c.state.recordPets ?? []).includes(pet.config_id)) return false
    // Provisional condition13081 rule: selected signature slot206. Ordinary
    // attacks, blink responses, hero skills and temporary actors do not count.
    // Keep this interpretation explicit pending official/event evidence.
    if (!pet.inherent_skills?.some((s) => s.skill_id === request.skill?.skill_id && s.skill_slot === 206)) return false
    const count = c.state.petHandbookCasts?.[pet.config_id] ?? 0
    if (count >= plan.maxCasts) return false
    if (!c.state.pets.some((p) => p.guid === pet.guid)) return false
    const index = String(request.verify_info?.battle_index ?? '0'),
        time = String(request.op_time ?? '0')
    const scope = c.connectionKey ?? c.requestKey?.split(':').slice(0, -2).join(':') ?? String(c.id ?? '')
    const raw =
        index !== '0' || time !== '0'
            ? `${scope}:${c.state.world.map_id}:${pet.guid}:${request.skill.skill_id}:${index}:${time}`
            : c.requestKey
    // Unidentified one-way starts are legal in the existing combat protocol.
    // Count the accepted invocation; reliable duplicate detection is impossible
    // without an index, time or request key. Do not invent a cooldown cutoff.
    if (raw) {
        const receipt = createHash('sha256').update(raw).digest('hex')
        if (c.state.petHandbookCastReceipts?.includes(receipt)) return false
        c.state.petHandbookCastReceipts = [...(c.state.petHandbookCastReceipts ?? []), receipt].slice(-256)
    }
    c.state.petHandbookCasts = { ...(c.state.petHandbookCasts ?? {}), [pet.config_id]: count + 1 }
    preparePetHandbook(c.tables, c.state, { only: [pet.config_id] })
    return true
}
export function handbookRewardPlan(tables, state) {
    const entries = Object.values(state.petHandbook ?? {})
    ensure(entries.length, 'No acquired pet handbook entries', ErrorCode.PetHandbookHaveNone)
    for (const row of entries) {
        const plan = handbookPlan(tables, row.pet_id)
        ensure(
            plan &&
                Number.isSafeInteger(row.lv) &&
                row.lv >= 1 &&
                row.lv <= plan.levels.length &&
                Number.isSafeInteger(row.rewarded_lv) &&
                row.rewarded_lv >= 1 &&
                row.rewarded_lv <= row.lv,
            'Invalid saved handbook reward progress',
            ErrorCode.GameConfig,
        )
    }
    const eligible = entries.filter((r) => r.lv > r.rewarded_lv)
    ensure(
        eligible.length,
        'No unclaimed handbook level rewards',
        entries.some((r) => r.lv > 1) ? ErrorCode.PetHandbookRewardClaimed : ErrorCode.PetHandbookLvNotReached,
    )
    return eligible.map((row) => ({
        row,
        rewards: handbookPlan(tables, row.pet_id)
            .levels.filter((l) => l.iconographyLevel > row.rewarded_lv && l.iconographyLevel <= row.lv)
            .map((l) => l.reward),
    }))
}
