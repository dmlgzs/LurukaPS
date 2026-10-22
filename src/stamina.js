import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { grantRewards } from './rewards.js'

export const STAMINA_ATTRS = new Set([3, 200029, 200030, 200031])
const models = new WeakMap()
function settings(tables) {
    if (models.has(tables)) return models.get(tables)
    const interval = Number(tables.get('game').find((r) => r.title === 'STAMINA_TIME')?.value)
    const hour = Number(tables.get('game').find((r) => r.title === 'DAILY_REFRESH_TIME')?.value)
    ensure(
        Number.isSafeInteger(interval) && interval > 0 && Number.isInteger(hour) && hour >= 0 && hour < 24,
        'Invalid stamina clock configuration',
        ErrorCode.GameConfig,
    )
    const result = { interval, hour }
    models.set(tables, result)
    return result
}
function epoch(now) {
    ensure(
        Number.isFinite(now) && now >= 0 && now <= Number.MAX_SAFE_INTEGER,
        'Invalid stamina clock',
        ErrorCode.GameConfig,
    )
    return Math.floor(now)
}
function day(data, now) {
    return Math.floor((now + (8 - data.hour) * 3600) / 86400)
}
function attributes(state) {
    const attrs = state.player?.attr_infos?.attrs,
        values = new Map()
    ensure(Array.isArray(attrs), 'Missing stamina resource attributes', ErrorCode.GameConfig)
    for (const attr of attrs)
        if (STAMINA_ATTRS.has(attr.attr_id)) {
            ensure(
                !values.has(attr.attr_id) &&
                    /^\d+$/.test(String(attr.attr_val)) &&
                    BigInt(attr.attr_val) <= BigInt(Number.MAX_SAFE_INTEGER),
                'Invalid stamina resource attribute',
                ErrorCode.GameConfig,
            )
            values.set(attr.attr_id, { attr, value: Number(attr.attr_val) })
        }
    ensure(
        values.has(3) && values.get(3).value <= 0x7fffffff,
        'Missing or invalid stamina balance',
        ErrorCode.GameConfig,
    )
    return values
}
function set(state, id, value) {
    ensure(Number.isSafeInteger(value) && value >= 0, 'Invalid stamina attribute value', ErrorCode.GameConfig)
    const attrs = state.player.attr_infos.attrs,
        old = attrs.find((r) => r.attr_id === id)
    if (old) old.attr_val = String(value)
    else attrs.push({ attr_id: id, attr_val: String(value) })
}
function view(tables, state, now) {
    const config = settings(tables),
        time = epoch(now),
        attrs = attributes(state)
    const cap = tables.find('player_level', state.player.basic_info.lv)?.stamina
    ensure(
        Number.isSafeInteger(cap) && cap > 0 && cap <= 0x7fffffff,
        'Missing stamina recovery level cap',
        ErrorCode.GameConfig,
    )
    const saved = state.staminaRecovery
    if (saved !== undefined)
        ensure(
            saved && Number.isSafeInteger(saved.period) && typeof saved.full === 'boolean',
            'Malformed saved stamina clock',
            ErrorCode.GameConfig,
        )
    return { config, time, attrs, cap, saved, amount: attrs.get(3).value, period: day(config, time) }
}

export function staminaSyncDue(tables, state, now) {
    const v = view(tables, state, now)
    if (!v.saved || ![200029, 200030, 200031].every((id) => v.attrs.has(id))) return true
    if (v.period > v.saved.period || v.saved.full !== v.amount >= v.cap) return true
    return !v.saved.full && v.time - v.attrs.get(200030).value >= v.config.interval
}

export function prepareStamina(tables, state, now) {
    const v = view(tables, state, now)
    let saved = v.saved
    const count = v.attrs.get(200031)?.value ?? 0,
        purchased = v.attrs.get(200029)?.value ?? 0
    if (!saved) {
        // Unknown legacy history is not an epoch-sized recovery budget. A
        // proven existing recovery timestamp may be resumed; missing one starts now.
        saved = state.staminaRecovery = {
            period: Math.max(v.period, purchased ? day(v.config, purchased) : v.period),
            full: v.amount >= v.cap,
        }
        if (purchased && day(v.config, purchased) < v.period) set(state, 200031, 0)
        else set(state, 200031, count)
    }
    if (!v.attrs.has(200029)) set(state, 200029, 0)
    if (!v.attrs.has(200031)) set(state, 200031, count)
    if (!v.attrs.has(200030) || (!v.saved && v.attrs.get(200030)?.value === 0)) set(state, 200030, v.time)
    if (v.period > saved.period) {
        set(state, 200031, 0)
        saved.period = v.period
    }
    const anchor = Number(state.player.attr_infos.attrs.find((a) => a.attr_id === 200030).attr_val)
    if (v.amount >= v.cap) {
        saved.full = true
        return
    }
    if (saved.full) {
        set(state, 200030, v.time)
        saved.full = false
        return
    }
    const ticks = Math.max(0, Math.floor((v.time - anchor) / v.config.interval))
    const recovered = Math.min(v.cap - v.amount, ticks)
    if (recovered) {
        grantRewards(tables, state, [{ itemtype: 10, itemid: 3, itemnum: recovered }])
        set(state, 200030, anchor + recovered * v.config.interval)
    }
    saved.full = v.amount + recovered >= v.cap
}

export function finishStamina(tables, state, now) {
    const v = view(tables, state, now)
    if (!v.saved) {
        prepareStamina(tables, state, now)
        return
    }
    const full = v.amount >= v.cap
    if (!full && v.saved.full) set(state, 200030, v.time)
    v.saved.full = full
}

export function staminaAttributes(state) {
    const attrs = state.player?.attr_infos?.attrs
    ensure(Array.isArray(attrs), 'Missing stamina resource attributes', ErrorCode.GameConfig)
    return attrs.filter((a) => STAMINA_ATTRS.has(a.attr_id)).map((a) => ({ ...a }))
}

export function staminaCacheSnapshot(state) {
    return {
        player: { basic_info: { lv: state.player.basic_info.lv }, attr_infos: { attrs: staminaAttributes(state) } },
        ...(state.staminaRecovery ? { staminaRecovery: { ...state.staminaRecovery } } : {}),
    }
}

export function forkStaminaState(base) {
    return {
        ...base,
        ...(base.staminaRecovery ? { staminaRecovery: { ...base.staminaRecovery } } : {}),
        player: {
            ...base.player,
            attr_infos: {
                ...base.player.attr_infos,
                attrs: base.player.attr_infos.attrs.map((a) => (STAMINA_ATTRS.has(a.attr_id) ? { ...a } : a)),
            },
        },
    }
}
