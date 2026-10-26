import { createHash } from 'node:crypto'
import policy from '../configs/activity-drop-currency-policy.json' with { type: 'json' }
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
const positive = (value) => uint(value) && value > 0
const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
const max = 0xffffffffffffffffn
const canonical = (value) =>
    JSON.stringify(
        Array.isArray(value)
            ? value.map((item) => JSON.parse(canonical(item)))
            : object(value)
              ? Object.fromEntries(
                    Object.keys(value)
                        .sort()
                        .map((key) => [key, JSON.parse(canonical(value[key]))]),
                )
              : value,
    )
const fingerprint = (value) => createHash('sha256').update(canonical(value)).digest('hex')
const members = (event) =>
    String(event.dropList)
        .split('|')
        .filter(Boolean)
        .map(Number)
        .sort((a, b) => a - b)
const parentFields = (event) => ({
    id: event.id,
    type: event.type,
    ptCurrencyId: event.ptCurrencyId,
    ptShopId: event.ptShopId,
    dropIds: members(event),
})
ensure(
    policy.version === 1 &&
        policy.officiallyVerified === false &&
        policy.classification === 'current-unique-repeat-parent-pt-currency' &&
        policy.sourceType === 2 &&
        policy.displayType === 10 &&
        policy.balance === 'player.attr_infos.act_attrs:event_id+attr_id' &&
        policy.ordinaryGrantForActivityCurrency === false &&
        policy.originalDropTablesModified === false &&
        Array.isArray(policy.pools),
    'Invalid activity drop currency policy',
    ErrorCode.GameConfig,
)
const registry = new Map()
for (const row of policy.pools) {
    ensure(
        object(row) &&
            positive(row.dropId) &&
            positive(row.eventId) &&
            positive(row.currencyId) &&
            !registry.has(row.dropId) &&
            object(row.parentFields) &&
            row.parentFields.id === row.eventId &&
            row.parentFields.type === 100 &&
            row.parentFields.ptCurrencyId === row.currencyId &&
            positive(row.parentFields.ptShopId) &&
            Array.isArray(row.parentFields.dropIds) &&
            row.parentFields.dropIds.every(positive) &&
            new Set(row.parentFields.dropIds).size === row.parentFields.dropIds.length &&
            row.parentFields.dropIds.includes(row.dropId) &&
            Array.isArray(row.sourcePool) &&
            row.sourcePool.length > 0 &&
            row.sourcePool.every(
                (source) =>
                    positive(source.id) &&
                    source.dropId === row.dropId &&
                    source.type === policy.sourceType &&
                    source.itemId === row.currencyId,
            ) &&
            Array.isArray(row.sourceRowFingerprints) &&
            row.sourceRowFingerprints.length === row.sourcePool.length &&
            row.sourcePool.every(
                (source) =>
                    row.sourceRowFingerprints.filter(
                        (item) => item.id === source.id && item.fingerprint === fingerprint(source),
                    ).length === 1,
            ) &&
            fingerprint(row.sourcePool) === row.sourcePoolFingerprint,
        'Malformed activity currency pool registry',
        ErrorCode.GameConfig,
    )
    registry.set(row.dropId, row)
}

function amount(value) {
    const valid =
        value === undefined ||
        (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) ||
        (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
    ensure(valid, 'Malformed activity currency balance', ErrorCode.GameConfig)
    const parsed = BigInt(value ?? 0)
    ensure(parsed <= max, 'Activity currency balance overflow', ErrorCode.GameConfig)
    return parsed
}
function entries(state) {
    const stored = state.player?.attr_infos?.act_attrs
    const rows = stored === undefined ? [] : stored
    ensure(Array.isArray(rows), 'Malformed activity currency ledger', ErrorCode.GameConfig)
    const seen = new Set()
    for (const row of rows) {
        ensure(
            object(row) && positive(row.event_id) && object(row.attr) && positive(row.attr.attr_id),
            'Malformed activity currency identity',
            ErrorCode.GameConfig,
        )
        const key = row.event_id + ':' + row.attr.attr_id
        ensure(!seen.has(key), 'Duplicate activity currency identity', ErrorCode.GameConfig)
        seen.add(key)
        amount(row.attr.attr_val)
        if (row.attr.deadtime !== undefined)
            ensure(uint(row.attr.deadtime), 'Malformed activity currency expiry', ErrorCode.GameConfig)
        if (row.attr.extra_limit !== undefined) amount(row.attr.extra_limit)
    }
    return rows
}
export function activityCurrencyBalance(state, eventId, currencyId) {
    ensure(positive(eventId) && positive(currencyId), 'Invalid activity currency key', ErrorCode.GameConfig)
    return amount(
        entries(state).find((row) => row.event_id === eventId && row.attr.attr_id === currencyId)?.attr.attr_val,
    ).toString()
}
// Trusted ledger operation; request callers must first classify the actual
// original drop against the sealed parent/pool source below.
export function creditActivityCurrency(state, eventId, currencyId, count) {
    ensure(
        positive(eventId) &&
            positive(currencyId) &&
            positive(count) &&
            object(state.player) &&
            object(state.player.attr_infos),
        'Invalid activity currency credit',
        ErrorCode.GameConfig,
    )
    const rows = entries(state)
    const existing = rows.find((row) => row.event_id === eventId && row.attr.attr_id === currencyId)
    const next = amount(existing?.attr.attr_val) + BigInt(count)
    ensure(next <= max, 'Activity currency balance overflow', ErrorCode.GameConfig)
    const value = {
        ...(existing ?? {}),
        event_id: eventId,
        attr: { ...existing?.attr, attr_id: currencyId, attr_val: next.toString() },
    }
    state.player.attr_infos = {
        ...state.player.attr_infos,
        act_attrs: [...rows.filter((row) => row !== existing), value],
    }
}

export function rollActivityRewardDrop(tables, state, activityId, dropId, catalog, randomInt) {
    const pool = catalog
        .get('drop')
        .filter((row) => row.dropId === dropId)
        .sort((a, b) => a.id - b.id)
    const registered = registry.get(dropId)
    if (!registered && !pool.some((row) => row.type === policy.sourceType)) {
        const rolled = catalog.drops(dropId, randomInt)
        ensure(
            !rolled.some((row) => row.itemtype === policy.sourceType),
            'Nested activity currency source is not classified',
            ErrorCode.FunctionClosed,
        )
        return { ordinary: rolled, activity: [] }
    }
    ensure(pool.length > 0, 'Activity currency drop pool is missing', ErrorCode.GameConfig)
    const parents = tables
        .get('game_events')
        .filter(
            (event) =>
                event.type === 100 &&
                positive(event.ptShopId) &&
                positive(event.ptCurrencyId) &&
                members(event).includes(dropId) &&
                pool.every((row) => row.itemId === event.ptCurrencyId),
        )
    ensure(
        registered &&
            parents.length === 1 &&
            parents[0].id === activityId &&
            registered.eventId === activityId &&
            fingerprint(parentFields(parents[0])) === fingerprint(registered.parentFields) &&
            fingerprint(pool) === registered.sourcePoolFingerprint &&
            tables.find('currency', registered.currencyId),
        'Activity currency drop source is not classified',
        ErrorCode.FunctionClosed,
    )
    const rolled = catalog.drops(dropId, randomInt)
    const special = rolled.filter((row) => row.itemtype === policy.sourceType)
    ensure(
        special.every((row) => row.itemid === registered.currencyId && positive(row.itemnum)),
        'Activity currency drop namespace mismatch',
        ErrorCode.FunctionClosed,
    )
    for (const reward of special) creditActivityCurrency(state, activityId, reward.itemid, reward.itemnum)
    return {
        ordinary: rolled.filter((row) => row.itemtype !== policy.sourceType),
        activity: special.map((row) => ({ ...row, itemtype: policy.displayType })),
    }
}
