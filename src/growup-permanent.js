import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { ErrorCode } from './error-codes.js'
import { ensure, GameError } from './handlers/common.js'
import { cultivationScore } from './growup-score.js'

const policy = JSON.parse(fs.readFileSync(new URL('../configs/growup-permanent-policy.json', import.meta.url)))
const uint = (v) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff
const object = (v) => v && typeof v === 'object' && !Array.isArray(v)
const fail = (ok, text) => ensure(ok, text, ErrorCode.GameConfig)
const list = (v) =>
    String(v ?? '')
        .split('|')
        .filter(Boolean)
        .map(Number)
const digest = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
fail(
    policy.version === 1 &&
        policy.officiallyVerified === false &&
        policy.defaultLevel === 1 &&
        Array.isArray(policy.supportedSystems) &&
        policy.supportedSystems.every((x) => uint(x) && x > 0),
    'Invalid permanent cultivation policy',
)
const models = new WeakMap()
export function permanentModel(system, id) {
    ensure(policy.supportedSystems.includes(id), 'Unsupported permanent cultivation system', ErrorCode.FunctionClosed)
    let cache = models.get(system)
    if (!cache) models.set(system, (cache = new Map()))
    if (cache.has(id)) return cache.get(id)
    const config = system.config(id),
        aids = new Set(
            system.tables
                .get('game_events_cul_assist')
                .filter((x) => x.systemId === id)
                .map((x) => x.assistId),
        ),
        attrs = new Set(
            system.tables
                .get('game_events_cul_attr')
                .filter((x) => x.systemId === id)
                .map((x) => x.AttrId),
        ),
        groups = new Map()
    fail(
        aids.size > 0 && attrs.size > 0 && uint(config.maxAttr) && config.maxAttr > 0,
        'Missing permanent cultivation model',
    )
    for (const row of system.tables.get('game_events_cul_excultivation').filter((x) => x.eventsid === id)) {
        const rule = String(row.unlockcondition).split('#').map(Number)
        ensure(
            rule.length === 3 && rule[0] === 80010 && rule[1] === id,
            'Unsupported permanent cultivation unlock rule',
            ErrorCode.FunctionClosed,
        )
        fail(
            aids.has(rule[2]) && uint(row.type) && row.type > 0 && uint(row.lvl) && row.lvl > 0,
            'Invalid permanent cultivation row identity',
        )
        const cost = String(row.cost).split('#').map(Number)
        fail(
            cost.length === 3 && cost[0] === 10 && uint(cost[1]) && cost[1] > 0 && uint(cost[2]) && cost[2] > 0,
            'Invalid permanent cultivation cost',
        )
        const attribute = {},
            bond = {}
        for (const effectId of list(row.effect)) {
            const effect = system.tables.get('game_events_cul_effect').find((x) => x.Id === effectId)
            fail(effect, 'Missing permanent cultivation effect')
            ensure([3, 13].includes(effect.type), 'Unsupported permanent cultivation effect', ErrorCode.FunctionClosed)
            for (const text of String(effect.param).split('|')) {
                const tuple = text.split('#').map(Number),
                    [target, value, mode] = tuple
                fail(
                    tuple.length === 3 &&
                        tuple.every(uint) &&
                        mode === 0 &&
                        (effect.type === 3 ? attrs : aids).has(target),
                    'Invalid permanent cultivation effect tuple',
                )
                const values = effect.type === 3 ? attribute : bond
                values[target] = (values[target] ?? 0) + value
                fail(uint(values[target]), 'Permanent cultivation effect overflow')
            }
        }
        let group = groups.get(row.type)
        if (!group) groups.set(row.type, (group = { type: row.type, assistant: rule[2], rows: new Map() }))
        fail(group.assistant === rule[2] && !group.rows.has(row.lvl), 'Ambiguous permanent cultivation level')
        group.rows.set(row.lvl, { id: row.id, level: row.lvl, cost, attribute, bond, effectIds: list(row.effect) })
    }
    fail(groups.size > 0, 'Missing permanent cultivation levels')
    for (const group of groups.values()) {
        const levels = [...group.rows.keys()].sort((a, b) => a - b)
        fail(
            levels.every((v, i) => v === i + 1),
            'Discontinuous permanent cultivation levels',
        )
        group.max = levels.at(-1)
    }
    const model = {
        config,
        aids,
        attrs,
        groups,
        fingerprint: digest(
            [...groups.values()].map((g) => ({ type: g.type, assistant: g.assistant, rows: [...g.rows.values()] })),
        ),
    }
    cache.set(id, model)
    return model
}
const warnedModels = new WeakMap()
function optionalModel(system, id) {
    // Only the new static-model compiler is optional. Ledger, codec and persistence errors must propagate.
    try {
        return permanentModel(system, id)
    } catch (error) {
        if (
            !(error instanceof GameError) ||
            ![ErrorCode.GameConfig, ErrorCode.FunctionClosed, ErrorCode.GrowUpConfNoExist].includes(error.code)
        )
            throw error
        let seen = warnedModels.get(system)
        if (!seen) warnedModels.set(system, (seen = new Set()))
        const key = `${id}:${error.code}:${error.message}`
        if (!seen.has(key)) {
            seen.add(key)
            console.warn(
                '[growup-permanent]',
                JSON.stringify({ event: 'unsupported-model-skipped', system: id, reason: error.message }),
            )
        }
        return null
    }
}
function guid(value, owner) {
    fail(typeof value === 'string' && /^\d+$/.test(value), 'Missing cultivation ending run GUID')
    const n = BigInt(value)
    fail(
        n > 0n && n <= 0xffffffffffffffffn && n >> 32n === BigInt(owner) && (n & 0xffffffffn) > 0n,
        'Foreign or invalid cultivation ending run GUID',
    )
    return String(n)
}
function snapshotIdentity(system, id, record, owner) {
    const model = permanentModel(system, id),
        ending = system.tables.get('game_events_cul_end').find((x) => x.systemId === id && x.endingId === record?.id)
    fail(
        ending &&
            Array.isArray(record.starting_ids) &&
            record.starting_ids.length > 0 &&
            new Set(record.starting_ids).size === record.starting_ids.length &&
            record.starting_ids.every((x) =>
                system.tables.get('game_events_cul_starting').some((s) => s.systemId === id && s.startingId === x),
            ),
        'Incomplete cultivation ending opening provenance',
    )
    fail(
        Array.isArray(record.attrs) &&
            record.attrs.length === model.attrs.size &&
            new Set(record.attrs.map((x) => x.attr_id)).size === model.attrs.size &&
            record.attrs.every(
                (x) => model.attrs.has(x.attr_id) && uint(x.attr_value) && x.attr_value <= model.config.maxAttr,
            ),
        'Incomplete cultivation ending attributes',
    )
    fail(
        Array.isArray(record.chrs) &&
            new Set(record.chrs.map((x) => x.assist_char_id)).size === record.chrs.length &&
            record.chrs.every(
                (x) =>
                    model.aids.has(x.assist_char_id) &&
                    uint(x.bond) &&
                    (x.is_bond_train === undefined || typeof x.is_bond_train === 'boolean'),
            ),
        'Invalid cultivation ending companions',
    )
    fail(Array.isArray(record.trails) && record.trails.length === 3, 'Incomplete cultivation ending examinations')
    const phases = new Set(),
        guids = new Set()
    for (const result of record.trails) {
        const trial = system.tables
            .get('game_events_cul_trial')
            .find((x) => x.systemId === id && x.trialId === result.trail_id)
        fail(
            trial &&
                [1, 2, 3].includes(trial.phase) &&
                !phases.has(trial.phase) &&
                uint(result.star) &&
                result.star >= 1 &&
                result.star <= 3,
            'Invalid cultivation ending examination',
        )
        phases.add(trial.phase)
        guids.add(guid(result.guid, owner))
        fail(
            ((typeof result.score === 'string' && /^\d+$/.test(result.score)) ||
                (Number.isSafeInteger(result.score) && result.score >= 0)) &&
                BigInt(result.score) <= 0xffffffffffffffffn,
            'Invalid cultivation ending examination score',
        )
        if (trial.phase === 3)
            fail(trial.trialId === ending.trial, 'Cultivation ending does not match final examination')
    }
    fail(guids.size === 1, 'Cultivation ending mixes different runs')
    // Current ending predicates can be reconstructed from sealed attributes. A
    // future history-dependent predicate cannot be proven by a merged record.
    ensure(
        !ending.condition ||
            String(ending.condition)
                .split('|')
                .every((text) => {
                    const [kind, activity] = text.split('#').map(Number)
                    return [80001, 80009].includes(kind) && activity === id
                }),
        'Unsupported historical cultivation ending condition',
        ErrorCode.FunctionClosed,
    )
    ensure(
        system.condition(ending.condition, { growup_train_attr: record.attrs }),
        'Cultivation ending conditions not met',
        ErrorCode.CultEndNotComplete,
    )
    cultivationScore(system, id, record) // Validate the full score inputs, never require equality to migrated historical top_rating.
    return {
        run_guid: [...guids][0],
        ending_id: record.id,
        assist_ids: record.chrs.map((x) => x.assist_char_id).sort((a, b) => a - b),
    }
}
function checkedLedger(system, entry, id, owner) {
    const ledger = entry.growupPermanent
    if (ledger === undefined) return null
    const model = permanentModel(system, id)
    fail(
        object(ledger) &&
            ledger.version === 1 &&
            ledger.owner_id === owner &&
            Array.isArray(ledger.unlocked) &&
            object(ledger.levels) &&
            object(ledger.endings) &&
            object(ledger.upgrades) &&
            object(ledger.migration) &&
            ledger.migration.version === 1 &&
            typeof ledger.migration.done === 'boolean' &&
            Array.isArray(ledger.migration.skipped),
        'Invalid permanent cultivation ledger',
    )
    fail(
        new Set(ledger.unlocked).size === ledger.unlocked.length && ledger.unlocked.every((x) => model.aids.has(x)),
        'Invalid permanent cultivation roster',
    )
    const witnesses = new Set()
    for (const [key, receipt] of Object.entries(ledger.endings)) {
        fail(
            guid(key, owner) === key &&
                object(receipt) &&
                receipt.run_guid === key &&
                ['trial-completion', 'sweep-completion', 'legacy-ending'].includes(receipt.source) &&
                uint(receipt.source === 'legacy-ending' ? receipt.observed_at : receipt.earned_at) &&
                Array.isArray(receipt.assist_ids) &&
                new Set(receipt.assist_ids).size === receipt.assist_ids.length &&
                receipt.assist_ids.every((x) => model.aids.has(x)) &&
                system.tables
                    .get('game_events_cul_end')
                    .some((x) => x.systemId === id && x.endingId === receipt.ending_id),
            'Invalid permanent cultivation ending receipt',
        )
        for (const x of receipt.assist_ids) witnesses.add(x)
    }
    fail(
        witnesses.size === ledger.unlocked.length && ledger.unlocked.every((x) => witnesses.has(x)),
        'Permanent cultivation roster has no completion source',
    )
    for (const [key, level] of Object.entries(ledger.levels)) {
        const group = model.groups.get(Number(key))
        fail(
            String(Number(key)) === key &&
                group &&
                ledger.unlocked.includes(group.assistant) &&
                uint(level) &&
                level >= 1 &&
                group.rows.has(level),
            'Invalid permanent cultivation level',
        )
    }
    for (const group of model.groups.values())
        fail(
            ledger.unlocked.includes(group.assistant) === Object.hasOwn(ledger.levels, group.type),
            'Permanent cultivation default level is inconsistent',
        )
    const payments = new Map()
    for (const [key, paid] of Object.entries(ledger.upgrades)) {
        fail(
            key.length > 0 &&
                key.length <= 256 &&
                object(paid) &&
                paid.version === 1 &&
                model.groups.has(paid.type) &&
                uint(paid.from) &&
                paid.from >= 1 &&
                paid.to === paid.from + 1 &&
                model.groups.get(paid.type).rows.has(paid.to) &&
                uint(paid.currency) &&
                paid.currency > 0 &&
                uint(paid.amount) &&
                paid.amount > 0 &&
                uint(paid.time),
            'Invalid permanent cultivation payment receipt',
        )
        const rows = payments.get(paid.type) ?? []
        rows.push(paid)
        payments.set(paid.type, rows)
    }
    for (const group of model.groups.values()) {
        const rows = (payments.get(group.type) ?? []).sort((a, b) => a.from - b.from)
        fail(
            rows.length === (ledger.levels[group.type] ?? 1) - 1 && rows.every((r, i) => r.from === i + 1),
            'Permanent cultivation level has no payment chain',
        )
    }
    return ledger
}
function fresh(owner) {
    return {
        version: 1,
        owner_id: owner,
        unlocked: [],
        levels: {},
        endings: {},
        upgrades: {},
        migration: { version: 1, done: false, skipped: [] },
    }
}
function addReceipt(model, ledger, info, source, now) {
    const old = ledger.endings[info.run_guid]
    if (old) {
        fail(
            old.ending_id === info.ending_id && JSON.stringify(old.assist_ids) === JSON.stringify(info.assist_ids),
            'Cultivation run ending identity changed',
        )
        return false
    }
    ledger.endings[info.run_guid] = {
        ...info,
        source,
        ...(source === 'legacy-ending' ? { observed_at: now } : { earned_at: now }),
    }
    ledger.unlocked = [...new Set([...ledger.unlocked, ...info.assist_ids])].sort((a, b) => a - b)
    for (const group of model.groups.values())
        if (ledger.unlocked.includes(group.assistant)) ledger.levels[group.type] ??= 1
    return true
}
// Only call from owned writable protocol transactions, never generic snapshot/ensure or Store.read.
export function preparePermanent(system, entry, id, owner, now) {
    fail(Number.isSafeInteger(owner) && owner > 0 && uint(now), 'Invalid permanent cultivation owner or time')
    const model = permanentModel(system, id),
        previous = checkedLedger(system, entry, id, owner)
    if (previous?.migration.done) return previous
    const ledger = previous ? structuredClone(previous) : fresh(owner),
        candidates = []
    const records = entry.growup?.end_data?.complete_end
    if (records !== undefined && !Array.isArray(records))
        ledger.migration.skipped.push({ reason: 'invalid legacy ending list' })
    else
        for (const record of records ?? []) {
            try {
                candidates.push(snapshotIdentity(system, id, record, owner))
            } catch (error) {
                ledger.migration.skipped.push({ ending_id: record?.id ?? 0, reason: error.message })
            }
        }
    for (const info of candidates) {
        if (candidates.filter((x) => x.run_guid === info.run_guid).length > 1) {
            ledger.migration.skipped.push({ ending_id: info.ending_id, reason: 'ambiguous legacy run GUID' })
            continue
        }
        try {
            addReceipt(model, ledger, info, 'legacy-ending', now)
        } catch (error) {
            ledger.migration.skipped.push({ ending_id: info.ending_id, reason: error.message })
        }
    }
    ledger.migration.done = true
    if (ledger.migration.skipped.length)
        console.warn(
            '[growup-permanent]',
            JSON.stringify({
                event: 'legacy-history-not-backfilled',
                activity: id,
                owner,
                reasons: ledger.migration.skipped,
            }),
        )
    entry.growupPermanent = ledger
    return ledger
}
export function permanentPayload(system, entry, id, owner) {
    const model = permanentModel(system, id),
        ledger = checkedLedger(system, entry, id, owner)
    return {
        roster: { activity_id: id, excultivation_assist_chars: ledger?.unlocked ?? [] },
        levels: {
            activity_id: id,
            datas: [...model.groups.keys()]
                .sort((a, b) => a - b)
                .map((type) => ({ type, level: ledger?.levels[type] ?? 1 })),
        },
    }
}
export function pushPermanent(c, catalog, { migrate = true } = {}) {
    const levels = []
    for (const row of catalog.rows.filter((x) => x.type === 60)) {
        if (!optionalModel(catalog.growup, row.systemId)) continue
        const entry = catalog.entry(c.state, row.id)
        if (migrate) preparePermanent(catalog.growup, entry, row.systemId, c.id, c.now)
        const value = permanentPayload(catalog.growup, entry, row.systemId, c.id)
        levels.push({ ...value.levels, activity_id: row.id })
        c.pushBefore('CSProtoSyncGrowupExcultivationAssistCharData', { ...value.roster, activity_id: row.id })
    }
    c.pushBefore('CSProtoSyncGrowupExcultivationData', { data: levels })
}
export function commitPermanentEnding(c, catalog, row, entry, snapshot, source) {
    fail(['trial-completion', 'sweep-completion'].includes(source), 'Invalid permanent cultivation source')
    const model = optionalModel(catalog.growup, row.systemId)
    if (!model) return false
    const info = snapshotIdentity(catalog.growup, row.systemId, snapshot, c.id)
    fail(
        info.run_guid === guid(entry.growup.guid, c.id) &&
            entry.growup.cur_stage === 4 &&
            entry.growup.cur_growup_trail_stage === 4,
        'Cultivation ending is not committed',
    )
    // Register this completion before migration sees the just-merged best snapshot.
    let ledger = checkedLedger(catalog.growup, entry, row.systemId, c.id)
    ledger = ledger ? structuredClone(ledger) : fresh(c.id)
    addReceipt(model, ledger, info, source, c.now)
    entry.growupPermanent = ledger
    preparePermanent(catalog.growup, entry, row.systemId, c.id, c.now)
    pushPermanent(c, catalog, { migrate: false })
}
