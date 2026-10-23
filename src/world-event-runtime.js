import crypto from 'node:crypto'
import config from '../configs/world-event-runtime.json' with { type: 'json' }
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const definitions = new Map(config.events.map((row) => [row.id, row]))
const integer = (n) => Number.isSafeInteger(n) && n >= 0
const keyOf = (row) => `${row.worldMapID}:${row.id}`
const sessionOf = (c) => {
    const token = c.connectionKey ?? c.combatSessionId
    return typeof token === 'string' && token ? crypto.createHash('sha256').update(token).digest('hex') : null
}
function validAdmission(admission, row, event) {
    return (
        admission?.version === 1 &&
        admission.cfg_id === row.id &&
        admission.map_id === row.worldMapID &&
        admission.condition === String(row.conditionID ?? '') &&
        event?.cfg_id === row.id &&
        Number.isSafeInteger(event.generation) &&
        event.generation > 0 &&
        admission.generation === event.generation &&
        Number.isSafeInteger(admission.order) &&
        admission.order > 0
    )
}
function admissions(state) {
    const value = state.worldEventAdmissions
    ensure(
        value === undefined || (value !== null && typeof value === 'object' && !Array.isArray(value)),
        'Invalid world event admission ledger',
        ErrorCode.GameConfig,
    )
    return value ?? {}
}
function admissionFor(state, row) {
    const value = admissions(state)[keyOf(row)]
    ensure(
        value === undefined ||
            (value !== null &&
                value.version === 1 &&
                value.cfg_id === row.id &&
                value.map_id === row.worldMapID &&
                typeof value.condition === 'string' &&
                Number.isSafeInteger(value.generation) &&
                value.generation > 0 &&
                Number.isSafeInteger(value.order) &&
                value.order > 0),
        'Invalid world event admission receipt',
        ErrorCode.GameConfig,
    )
    return value
}
function runtime(c) {
    const value = c.state.world.eventRuntime
    if (!value) return null
    const session = sessionOf(c)
    return session &&
        value?.version === 1 &&
        value.session === session &&
        value.map_id === c.state.world.map_id &&
        value.epoch === (c.state.world.eventEpoch ?? 0) &&
        Array.isArray(value.entries) &&
        value.entries.length <= 64 &&
        value.entries.every(
            (entry) =>
                entry &&
                Number.isSafeInteger(entry.cfg_id) &&
                entry.cfg_id > 0 &&
                Number.isSafeInteger(entry.generation) &&
                entry.generation > 0 &&
                Number.isSafeInteger(entry.order) &&
                entry.order > 0,
        )
        ? value
        : null
}
function within(c, row, margin) {
    const checks = definitions.get(row.id)?.checks ?? [],
        pos = c.state.world.pos
    if (!checks.length || !pos || !['x', 'y', 'z'].every((axis) => Number.isFinite(pos[axis]))) return false
    return checks.some(
        (check) =>
            ['x', 'y', 'z'].reduce((sum, axis) => sum + (pos[axis] / 100 - check.center[axis]) ** 2, 0) <=
            (check.range + margin) ** 2,
    )
}
function liveAt(c, row, event) {
    // The configured deadline is authoritative even when no later packet for
    // that event has materialized its expired flag. Zero means no deadline.
    return (
        event &&
        !event.expired &&
        Number.isFinite(event.begin_time) &&
        Number.isFinite(row.overtime) &&
        row.overtime >= 0 &&
        (row.overtime === 0 || c.now < event.begin_time + row.overtime)
    )
}
function wire(event) {
    return {
        cfg_id: event.cfg_id,
        step: event.step,
        begin_time: event.begin_time,
        next_trigger_time: event.next_trigger_time,
    }
}
export function clearWorldEventRuntime(state) {
    const epoch = state.world.eventEpoch ?? 0
    ensure(
        integer(epoch) && epoch < Number.MAX_SAFE_INTEGER,
        'World event scene epoch is invalid',
        ErrorCode.GameConfig,
    )
    state.world.eventEpoch = epoch + 1
    delete state.world.eventRuntime
}
// LOCAL spatial sampling: only already admitted entries are checked. This is
// copy-on-write for forkMovement; no timers, complete-state clones, or SQL.
export function pruneWorldEventRuntime(c) {
    const old = runtime(c)
    if (!old) {
        if (c.state.world.eventRuntime) delete c.state.world.eventRuntime
        return
    }
    const entries = old.entries.filter((entry) => {
        const row = c.tables.find('world_event', entry.cfg_id),
            event = row && c.state.worldEvents?.[keyOf(row)]
        return (
            row?.worldMapID === c.state.world.map_id &&
            event?.cfg_id === row.id &&
            entry.generation === event.generation &&
            liveAt(c, row, event) &&
            within(c, row, 100)
        )
    })
    if (entries.length !== old.entries.length) c.state.world.eventRuntime = { ...old, entries }
}
export function worldEventAdmitted(c, row, event) {
    return validAdmission(admissionFor(c.state, row), row, event)
}
export function admitWorldEvent(c, row, event) {
    // A real accepted trigger/10715 can assign the first local generation to
    // legacy zero-condition history; merely loading that history cannot.
    if (!row.conditionID && event.cfg_id === row.id && event.generation === undefined) event.generation = 1
    ensure(
        event.cfg_id === row.id && Number.isSafeInteger(event.generation) && event.generation > 0,
        'Invalid world event generation identity',
        ErrorCode.GameConfig,
    )
    let admission = admissionFor(c.state, row)
    if (!validAdmission(admission, row, event)) {
        const previous = c.state.worldEventAdmissionOrder ?? 0
        ensure(
            integer(previous) &&
                Object.values(admissions(c.state)).every(
                    (value) => value && integer(value.order) && value.order <= previous,
                ),
            'World event admission counter does not match its receipts',
            ErrorCode.GameConfig,
        )
        const order = previous + 1
        ensure(Number.isSafeInteger(order) && order > 0, 'World event admission order is invalid', ErrorCode.GameConfig)
        c.state.worldEventAdmissionOrder = order
        admission = {
            version: 1,
            cfg_id: row.id,
            map_id: row.worldMapID,
            condition: String(row.conditionID ?? ''),
            generation: event.generation,
            order,
        }
        ;(c.state.worldEventAdmissions ??= {})[keyOf(row)] = admission
    }
    recordWorldEventSync(c, row, event)
}
export function recordWorldEventSync(c, row, event) {
    const session = sessionOf(c),
        admission = admissionFor(c.state, row)
    if (!session || !validAdmission(admission, row, event) || !within(c, row, 100) || !liveAt(c, row, event)) return
    const old = runtime(c),
        entries = (old?.entries ?? []).filter((entry) => entry.cfg_id !== row.id)
    entries.push({ cfg_id: row.id, generation: event.generation, order: admission.order })
    ensure(entries.length <= 64, 'Too many admitted world events', ErrorCode.GameConfig)
    c.state.world.eventRuntime = {
        version: 1,
        session,
        map_id: row.worldMapID,
        epoch: c.state.world.eventEpoch ?? 0,
        entries,
    }
}
export function checkWorldEventConditions(c, row) {
    const text = String(row.conditionID ?? '')
    if (!text) return
    pruneWorldEventRuntime(c)
    for (const clause of text.split('|')) {
        const parts = clause.split('#').map(Number),
            [kind, a, b, value] = parts
        ensure(parts.every(integer) && kind > 0, 'Invalid world event condition', ErrorCode.GameConfig)
        if (kind === 40001) {
            ensure(parts.length === 3 && a > 0, 'Invalid event-group condition', ErrorCode.GameConfig)
            const candidates = (runtime(c)?.entries ?? []).flatMap((entry) => {
                const source = c.tables.find('world_event', entry.cfg_id),
                    event = source && c.state.worldEvents?.[keyOf(source)]
                return source?.worldMapID === row.worldMapID &&
                    source.group === a &&
                    entry.generation === event?.generation &&
                    Number.isInteger(event.step) &&
                    liveAt(c, source, event)
                    ? [event.step]
                    : []
            })
            ensure(
                new Set(candidates).size <= 1,
                'Current world event group instance order is ambiguous',
                ErrorCode.FunctionClosed,
            )
            ensure(
                candidates.length && candidates[0] === b,
                'World event group condition not met',
                ErrorCode.WorldEvCondition,
            )
        } else if (kind === 40003) {
            ensure(
                parts.length === 4 && b > 0 && [0, 1].includes(value),
                'Invalid world-object event condition',
                ErrorCode.GameConfig,
            )
            const map = a || c.state.world.map_id,
                record = map === c.state.world.map_id ? c.state.worldObjects?.[`${map}:${b}`] : null
            if (record !== undefined && record !== null)
                ensure(
                    typeof record === 'object' && !Array.isArray(record) && record.obj_id === b,
                    'Invalid current world object data',
                    ErrorCode.GameConfig,
                )
            if (record?.complete !== undefined)
                ensure(
                    typeof record.complete === 'boolean',
                    'Invalid world object completion field',
                    ErrorCode.GameConfig,
                )
            ensure(
                record && (record.complete ?? false) === (value === 1),
                'World event object condition not met',
                ErrorCode.WorldEvCondition,
            )
        } else ensure(false, `Unsupported world event condition ${kind}`, ErrorCode.FunctionClosed)
    }
}
// A fresh10715 publication is server authorization to materialize a saved
// admission. Ordinary history without a real trigger receipt is never active.
export function restoreWorldEventRuntime(c) {
    pruneWorldEventRuntime(c)
    const snapshots = []
    const saved = Object.values(admissions(c.state))
    ensure(
        saved.every(
            (value) =>
                value !== null && typeof value === 'object' && Number.isSafeInteger(value.order) && value.order > 0,
        ),
        'Invalid saved event admission receipt',
        ErrorCode.GameConfig,
    )
    for (const admission of saved.sort((a, b) => a.order - b.order)) {
        const row = c.tables.find('world_event', admission.cfg_id),
            event = row && c.state.worldEvents?.[keyOf(row)]
        if (row) admissionFor(c.state, row)
        if (
            !row ||
            row.worldMapID !== c.state.world.map_id ||
            !validAdmission(admission, row, event) ||
            !Number.isInteger(event.step) ||
            event.step < 1 ||
            event.step >= row.stepCount ||
            event.completed ||
            !liveAt(c, row, event) ||
            !within(c, row, 100)
        )
            continue
        recordWorldEventSync(c, row, event)
        snapshots.push(wire(event))
    }
    if (snapshots.length) c.pushBefore('CSProtoWorldEventInfo', { infos: snapshots })
}
