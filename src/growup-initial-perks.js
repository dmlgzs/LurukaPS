import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { permanentModel, permanentState } from './growup-permanent.js'

const uint = (v) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff
const fail = (ok, text) => ensure(ok, text, ErrorCode.GameConfig)

export function permanentRunGuid(entry, owner) {
    // GrowUp.guid is uint64; existing allocation encodes owner32 / sequence32.
    fail(uint(owner) && owner > 0, 'Invalid cultivation GUID owner')
    let sequence = entry.nextGrowupGuid
    fail(sequence === undefined || uint(sequence), 'Invalid cultivation run sequence')
    sequence ??= 0
    const observe = (value) => {
        if (typeof value !== 'string' || !/^\d+$/.test(value)) return
        const n = BigInt(value)
        if (n > 0n && n <= 0xffffffffffffffffn && n >> 32n === BigInt(owner))
            sequence = Math.max(sequence, Number(n & 0xffffffffn))
    }
    observe(entry.growup?.guid)
    for (const key of Object.keys(entry.growupPermanent?.endings ?? {})) observe(key)
    const endings = entry.growup?.end_data?.complete_end
    for (const ending of Array.isArray(endings) ? endings : [])
        for (const trial of Array.isArray(ending?.trails) ? ending.trails : []) observe(trial?.guid)
    fail(sequence < 0xffffffff, 'Cultivation run sequence exhausted')
    entry.nextGrowupGuid = sequence + 1
    return String((BigInt(owner) << 32n) | BigInt(sequence + 1))
}

export function sealPermanentInitial(system, entry, id, owner) {
    const model = permanentModel(system, id),
        ledger = permanentState(system, entry, id, owner),
        attributes = {},
        bonds = {},
        rows = []
    for (const group of model.groups.values()) {
        const level = ledger?.levels[group.type]
        if (level === undefined) continue
        const row = group.rows.get(level)
        rows.push({ type: group.type, level, row_id: row.id })
        for (const [key, value] of Object.entries(row.attribute)) attributes[key] = (attributes[key] ?? 0) + value
        for (const [key, value] of Object.entries(row.bond)) bonds[key] = (bonds[key] ?? 0) + value
    }
    fail([...Object.values(attributes), ...Object.values(bonds)].every(uint), 'Permanent initial effect overflow')
    const g = entry.growup,
        sealed = {
            version: 1,
            system_id: id,
            run_guid: g.guid,
            model_fingerprint: model.fingerprint,
            rows,
            attributes,
            bonds,
            applied_assistants: [],
        }
    entry.growupRuntime.initialPerks = sealed
    for (const [key, value] of Object.entries(attributes)) {
        const attr = g.growup_train_attr.find((x) => x.attr_id === Number(key))
        fail(attr && uint(attr.attr_value), 'Invalid cultivation initial attribute')
        attr.attr_value = Math.min(model.config.maxAttr, attr.attr_value + value)
    }
    for (const assistant of g.assist_chars) applyPermanentJoin(system, entry, g, id, assistant)
    return sealed
}

export function applyPermanentJoin(system, entry, g, id, assistant) {
    const sealed = entry?.growupRuntime?.initialPerks
    // Legacy running cycles have no seal and receive no retroactive effect.
    if (sealed === undefined) return
    fail(
        sealed &&
            sealed.version === 1 &&
            sealed.system_id === id &&
            sealed.run_guid === g.guid &&
            Array.isArray(sealed.applied_assistants) &&
            new Set(sealed.applied_assistants).size === sealed.applied_assistants.length &&
            sealed.bonds &&
            typeof sealed.bonds === 'object' &&
            !Array.isArray(sealed.bonds) &&
            Object.entries(sealed.bonds).every(
                ([k, v]) =>
                    /^\d+$/.test(k) &&
                    system.tables
                        .get('game_events_cul_assist')
                        .some((r) => r.systemId === id && r.assistId === Number(k)) &&
                    uint(v),
            ),
        'Invalid sealed permanent initial bond budget',
    )
    if (sealed.applied_assistants.includes(assistant.assist_char_id)) return
    const value = sealed.bonds[assistant.assist_char_id] ?? 0
    fail(uint(assistant.bond) && uint(assistant.bond + value), 'Cultivation initial bond overflow')
    assistant.bond += value
    sealed.applied_assistants.push(assistant.assist_char_id)
}
