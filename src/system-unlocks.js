import { createHash } from 'node:crypto'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { starterProfileMode } from './starter-profile.js'
import { taskNodeFinishedCurrentAttempt } from './task-node-status.js'
import { TaskGraphs } from './tasks.js'
import { battleMessageCount } from './battle-message-events.js'

const uint = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff
const positive = (n) => uint(n) && n > 0
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const valid = (v, message) => ensure(v, message, ErrorCode.GameConfig)
const hash = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
const models = new WeakMap()

export function parseSystemUnlockCondition(text) {
    valid(typeof text === 'string', 'System unlock expression is malformed')
    if (!text.trim()) return { type: 'true' }
    const tokens = text.match(/\d+(?:#\d+)*|&&|\|\||[()]/g) ?? []
    valid(tokens.join('') === text.replace(/\s/g, ''), 'System unlock expression contains unknown syntax')
    let at = 0
    const atom = () => {
        if (tokens[at] === '(') {
            at++
            const result = or()
            valid(tokens[at++] === ')', 'System unlock expression is unbalanced')
            return result
        }
        const raw = tokens[at++]
        valid(/^\d+(?:#\d+)*$/.test(raw ?? ''), 'System unlock expression is missing a condition')
        const values = raw.split('#').map(Number)
        valid(values.every(uint), 'System unlock condition values are malformed')
        return { type: 'condition', values }
    }
    const and = () => {
        let left = atom()
        while (tokens[at] === '&&') {
            at++
            left = { type: 'and', left, right: atom() }
        }
        return left
    }
    const or = () => {
        let left = and()
        while (tokens[at] === '||') {
            at++
            left = { type: 'or', left, right: and() }
        }
        return left
    }
    const tree = or()
    valid(at === tokens.length, 'System unlock expression contains trailing data')
    return tree
}
function visit(tree, callback) {
    if (tree.type === 'condition') callback(tree.values)
    if (tree.left) visit(tree.left, callback)
    if (tree.right) visit(tree.right, callback)
}
function model(tables) {
    if (models.has(tables)) return models.get(tables)
    const rows = tables.get('system_unlock'),
        byId = new Map(),
        nodes = new Map(),
        tasks = new Set(),
        entrusts = new Set(),
        messages = new Set(),
        graphs = new TaskGraphs(tables)
    for (const row of rows) {
        valid(positive(row.id) && !byId.has(row.id), 'System unlock directory is malformed')
        byId.set(row.id, { ...row, tree: parseSystemUnlockCondition(row.unlockCondi) })
    }
    for (const row of byId.values())
        visit(row.tree, ([kind, ...p]) => {
            ensure(
                [2004, 2007, 12045, 12042, 13044, 61009].includes(kind),
                'System unlock condition is not implemented: ' + kind,
                ErrorCode.FunctionClosed,
            )
            valid(
                p.length === ([12045, 13044, 61009].includes(kind) ? 2 : 1) && p.every(positive),
                'System unlock condition parameters are malformed',
            )
            if (kind === 2007 || kind === 12045) {
                valid(tables.find('task', p[0]), 'System unlock task configuration is missing')
                if (kind === 2007) tasks.add(p[0])
                else {
                    valid(graphs.get(p[0]).nodes.has(p[1]), 'System unlock task node is missing')
                    nodes.set(p.join(':'), p)
                }
            }
            if (kind === 12042) valid(byId.has(p[0]), 'System unlock dependency is missing')
            if (kind === 13044) {
                valid(tables.find('dungeon_entrust', p[0]), 'System unlock commission configuration is missing')
                entrusts.add(p[0])
            }
            if (kind === 61009) messages.add(p[0])
        })
    const visiting = new Set(),
        done = new Set()
    const check = (id) => {
        valid(!visiting.has(id), 'Cyclic system unlock dependency')
        if (done.has(id)) return
        visiting.add(id)
        visit(byId.get(id).tree, ([kind, next]) => {
            if (kind === 12042) check(next)
        })
        visiting.delete(id)
        done.add(id)
    }
    for (const id of byId.keys()) check(id)
    const result = {
        byId,
        ids: [...byId.keys()].sort((a, b) => a - b),
        nodes: [...nodes.values()],
        tasks: [...tasks],
        entrusts: [...entrusts],
        messages: [...messages],
        hash: hash([...byId.values()].map((r) => [r.id, r.unlockCondi]).sort((a, b) => a[0] - b[0])),
    }
    models.set(tables, result)
    return result
}
function savedLockList(state) {
    const values = state.player.basic_info.lock_system ?? []
    valid(
        Array.isArray(values) && values.every(positive) && new Set(values).size === values.length,
        'Saved system lock list is malformed',
    )
    return values
}
function projectLocks(state, values) {
    // Tick may use a shallow runtime fork. Never mutate a shared basic-info
    // object or persisted progress record before Store commits the draft.
    state.player = { ...state.player, basic_info: { ...state.player.basic_info, lock_system: [...values] } }
}
function star(state, id) {
    const value = state.entrust?.records?.[id]?.entrust_star ?? 0
    valid(uint(value), 'Saved commission star progress is malformed')
    return value
}
function completedTask(state, id) {
    const records = state.taskRecords ?? []
    valid(Array.isArray(records), 'Saved system unlock task history is malformed')
    const matching = records.filter((row) => row.task_id === id)
    valid(
        matching.every((row) => uint(row.count)),
        'Saved system unlock task count is malformed',
    )
    return matching.some((row) => row.count > 0)
}
function signature(m, state) {
    const level = state.player.basic_info.lv
    valid(positive(level), 'Saved system unlock player level is malformed')
    return hash({
        level,
        nodes: m.nodes.map(([task, node]) => taskNodeFinishedCurrentAttempt(state, task, node)),
        tasks: m.tasks.map((id) => completedTask(state, id)),
        stars: m.entrusts.map((id) => star(state, id)),
        messages: m.messages.map((id) => battleMessageCount(state, id)),
    })
}
function evaluate(m, state, existing) {
    const open = new Set(existing),
        evaluating = new Set(),
        visited = new Set()
    const unlock = (id) => {
        if (open.has(id)) return true
        if (visited.has(id)) return false
        valid(!evaluating.has(id), 'Cyclic system unlock evaluation')
        evaluating.add(id)
        const node = (tree) => {
            if (tree.type === 'true') return true
            if (tree.type === 'and') return node(tree.left) && node(tree.right)
            if (tree.type === 'or') return node(tree.left) || node(tree.right)
            const [kind, a, b] = tree.values
            if (kind === 2004) return state.player.basic_info.lv >= a
            if (kind === 2007) return completedTask(state, a)
            if (kind === 12045) return taskNodeFinishedCurrentAttempt(state, a, b)
            if (kind === 12042) return unlock(a)
            if (kind === 13044) return star(state, a) >= b
            if (kind === 61009) return battleMessageCount(state, a) >= b
            ensure(false, 'Unknown compiled system unlock condition', ErrorCode.FunctionClosed)
        }
        const result = node(m.byId.get(id).tree)
        evaluating.delete(id)
        visited.add(id)
        if (result) open.add(id)
        return result
    }
    for (const id of m.ids) unlock(id)
    return [...open].sort((a, b) => a - b)
}

// One monotonic set owns progression. Native platform bans are a separate
//9871 mechanism; upOneLevel must not be invented as a normal-lock prerequisite.
export class SystemUnlocks {
    constructor(tables) {
        this.model = model(tables)
    }
    inspect(state) {
        const row = state.systemUnlockProgress,
            mode = starterProfileMode(state)
        valid(
            object(row) &&
                row.version === 1 &&
                row.profileMode === mode &&
                row.sourceHash === this.model.hash &&
                uint(row.revision) &&
                Array.isArray(row.unlocked) &&
                row.unlocked.every((id) => this.model.byId.has(id)) &&
                new Set(row.unlocked).size === row.unlocked.length &&
                Array.isArray(row.opaqueLocked) &&
                row.opaqueLocked.every((id) => positive(id) && !this.model.byId.has(id)) &&
                new Set(row.opaqueLocked).size === row.opaqueLocked.length &&
                typeof row.observedSignature === 'string',
            'Saved system unlock progress is unavailable or malformed',
        )
        return row
    }
    locked(row) {
        const open = new Set(row.unlocked)
        return [...this.model.ids.filter((id) => !open.has(id)), ...row.opaqueLocked].sort((a, b) => a - b)
    }
    prepare(state) {
        const mode = starterProfileMode(state),
            locks = savedLockList(state)
        if (state.systemUnlockProgress === undefined) {
            const unlocked =
                mode === 'normal'
                    ? evaluate(this.model, state, [])
                    : mode === 'sandbox'
                      ? this.model.ids
                      : this.model.ids.filter((id) => !locks.includes(id))
            state.systemUnlockProgress = {
                version: 1,
                profileMode: mode,
                sourceHash: this.model.hash,
                unlocked: [...unlocked],
                opaqueLocked: locks.filter((id) => !this.model.byId.has(id)),
                revision: 0,
                observedSignature:
                    unlocked.length === this.model.ids.length ? 'all-open' : signature(this.model, state),
            }
        } else {
            const row = { ...this.inspect(state) },
                next =
                    row.unlocked.length === this.model.ids.length
                        ? row.unlocked
                        : evaluate(this.model, state, row.unlocked)
            if (next.length !== row.unlocked.length) {
                valid(row.revision < 0xffffffff, 'System unlock revision exhausted')
                row.unlocked = next
                row.revision++
            }
            row.observedSignature = next.length === this.model.ids.length ? 'all-open' : signature(this.model, state)
            state.systemUnlockProgress = row
        }
        projectLocks(state, this.locked(this.inspect(state)))
        return state.player.basic_info.lock_system
    }
    observe(state) {
        const original = this.inspect(state),
            before = this.locked(original)
        valid(
            hash([...savedLockList(state)].sort((a, b) => a - b)) === hash(before),
            'System lock projection differs from its saved progression',
        )
        if (original.unlocked.length === this.model.ids.length) return null
        const current = signature(this.model, state)
        if (current === original.observedSignature) return null
        const row = { ...original }
        const next = evaluate(this.model, state, row.unlocked),
            old = new Set(row.unlocked),
            ids = next.filter((id) => !old.has(id))
        row.observedSignature = current
        state.systemUnlockProgress = row
        if (!ids.length) return null
        valid(row.revision < 0xffffffff, 'System unlock revision exhausted')
        row.unlocked = next
        row.revision++
        // Keep the OLD public bitmap until every current-request packet has
        // been encoded. Otherwise auto5008 consumes the transition before10600.
        return { ids, before, after: this.locked(row), revision: row.revision }
    }
    deliver(state, packets, plan, packet) {
        if (!plan) return packets
        const row = this.inspect(state)
        valid(
            plan.revision === row.revision &&
                hash([...savedLockList(state)].sort((a, b) => a - b)) === hash(plan.before) &&
                hash(this.locked(row)) === hash(plan.after),
            'System unlock delivery plan is stale',
        )
        const notification = packet('CSProtoUnLockSync', { unlock_id: plan.ids })
        projectLocks(state, plan.after)
        // Preserve existing ACK/task/push ordering. All encoded fact packets
        // still carry the old bitmap; future fullbasic snapshots use the final one.
        return [...packets, notification]
    }
}
export function systemUnlockRevision(state) {
    return state.systemUnlockProgress?.revision ?? 0
}
export function systemUnlockPersistence(options = {}) {
    const previous = options.persistWhen
    return {
        ...options,
        persistWhen: (draft, base) =>
            systemUnlockRevision(draft) !== systemUnlockRevision(base) || !!previous?.(draft, base),
    }
}

// Call only in an own-player packet context. A foreign profile must keep its
// owner's data; an absent basic payload must not be invented for attr/bag deltas.
export function systemUnlockPlayerPacket(state, value) {
    if (!value?.basic_info || !state.systemUnlockProgress) return value
    const owner = state.player.basic_info.id,
        peer = value.basic_info.id
    if (peer !== undefined && String(peer) !== String(owner)) return value
    return { ...value, basic_info: { ...value.basic_info, lock_system: [...savedLockList(state)] } }
}
