import { createHash } from 'node:crypto'
import localPolicy from '../configs/gacha-local-policy.json' with { type: 'json' }
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { parseRewards } from './rewards.js'
import { payGachaTickets } from './gacha-payment.js'
import { configTime } from './shops.js'
import { grantGachaAcquisition, gachaWireItem } from './gacha-acquisition.js'

const max64 = 0xffffffffffffffffn
const uint = (n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff
const identity = (item) => item.itemtype + ':' + item.itemid
function saved64(value, message) {
    ensure(
        (typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value))) &&
            /^\d+$/.test(String(value)) &&
            BigInt(value) <= max64,
        message,
        ErrorCode.GameConfig,
    )
    return BigInt(value)
}
function random(rng, maximum) {
    ensure(Number.isSafeInteger(maximum) && maximum > 0, 'Invalid gacha random domain', ErrorCode.GameConfig)
    const n = rng(maximum)
    ensure(Number.isInteger(n) && n >= 0 && n < maximum, 'Invalid gacha random output', ErrorCode.GameConfig)
    return n
}
function weighted(rows, rng) {
    const total = rows.reduce((n, row) => n + row.weight, 0)
    let n = random(rng, total)
    for (const row of rows) {
        n -= row.weight
        if (n < 0) return row
    }
    ensure(false, 'Gacha weighted selection failed', ErrorCode.GameConfig)
}
export class GachaDrawEngine {
    constructor(catalog, tables, policy = {}) {
        ensure(
            policy && typeof policy === 'object' && !Array.isArray(policy),
            'Invalid local gacha policy',
            ErrorCode.GameConfig,
        )
        this.catalog = catalog
        this.tables = tables
        this.policy = {
            ...localPolicy,
            ...policy,
            pool_overrides: { ...localPolicy.pool_overrides, ...policy.pool_overrides },
        }
        this.poolRows = new Map(tables.get('gacha_pool').map((row) => [row.gachaId, row]))
    }
    window(config) {
        const policy = this.policy
        ensure(
            ['offline_open', 'closed'].includes(policy.missing_schedule) &&
                policy.pool_overrides &&
                typeof policy.pool_overrides === 'object' &&
                !Array.isArray(policy.pool_overrides),
            'Invalid local gacha opening policy',
            ErrorCode.GameConfig,
        )
        if (Object.hasOwn(policy.pool_overrides, config.gachaId)) {
            ensure(
                typeof policy.pool_overrides[config.gachaId] === 'boolean',
                'Invalid gacha pool override',
                ErrorCode.GameConfig,
            )
            if (!policy.pool_overrides[config.gachaId]) return { start: 0, end: 0, closed: true }
            return this.offlineWindow()
        }
        ensure(uint(config.timelimit), 'Invalid gacha time limit reference', ErrorCode.GameConfig)
        if (!config.timelimit) return this.offlineWindow()
        let schedule
        try {
            schedule = this.tables.find('common_timelimit', config.timelimit)
        } catch {
            ensure(false, 'Gacha schedule table unavailable', ErrorCode.GameConfig)
        }
        if (!schedule)
            return policy.missing_schedule === 'offline_open'
                ? this.offlineWindow()
                : { start: 0, end: 0, closed: true }
        const start = configTime(schedule.startTime),
            end = configTime(schedule.endTime)
        ensure(!end || !start || end > start, 'Invalid gacha schedule window', ErrorCode.GameConfig)
        return { start, end, closed: !end }
    }
    offlineWindow() {
        const window = this.policy.offline_window
        ensure(
            window &&
                Number.isSafeInteger(window.start) &&
                window.start >= 0 &&
                Number.isSafeInteger(window.end) &&
                window.end > window.start,
            'Invalid local gacha time window',
            ErrorCode.GameConfig,
        )
        return { start: window.start, end: window.end, closed: false }
    }
    open(config, now) {
        const window = this.window(config)
        return !window.closed && now >= window.start && now <= window.end
    }
    commonTimes() {
        const times = new Map()
        for (const row of this.catalog.pools.values()) {
            if (!row.timelimit) continue
            const window = this.window(row),
                time = { time_id: row.timelimit, start_time: String(window.start), end_time: String(window.end) }
            const previous = times.get(row.timelimit)
            ensure(
                !previous || (previous.start_time === time.start_time && previous.end_time === time.end_time),
                'Conflicting gacha policies share one common time ID',
                ErrorCode.GameConfig,
            )
            times.set(row.timelimit, time)
        }
        return { data_list: [...times.values()] }
    }
    view(state) {
        for (const config of this.catalog.pools.values()) this.catalog.snapshot(state, config.gachaId)
        for (const config of this.catalog.pools.values()) {
            const rules = this.catalog.rules(config)
            ensure(
                rules.every((rule) => [0, 1].includes(rule.isInheritable)),
                'Invalid gacha inheritance flag',
                ErrorCode.GameConfig,
            )
            this.inherit(state, config, this.catalog.state(state, config), rules)
        }
        return [...this.catalog.pools.keys()].map((id) => this.catalog.snapshot(state, id))
    }
    compile(config) {
        ensure(
            this.policy.probability_mode === 'cumulative_thresholds',
            'Gacha probability mode not implemented',
            ErrorCode.FunctionClosed,
        )
        ensure(
            ['selected', 'uniform'].includes(this.policy.aimed_ssr_policy),
            'Invalid gacha aim policy',
            ErrorCode.GameConfig,
        )
        const pool = this.poolRows.get(config.gachaId)
        ensure(pool, 'Gacha candidate pool unavailable', ErrorCode.GameConfig)
        const rules = this.catalog
            .rules(config)
            .map((rule) => {
                ensure(
                    [rule.guaranteepoolId, rule.guaranteeType, rule.guaranteeCount, rule.probability_base].every(
                        uint,
                    ) &&
                        rule.guaranteepoolId > 0 &&
                        [0, 1].includes(rule.isRepeatable) &&
                        [0, 1].includes(rule.isInheritable) &&
                        [0, 1].includes(rule.selfchoose),
                    'Invalid gacha guarantee configuration',
                    ErrorCode.GameConfig,
                )
                ensure(
                    rule.guaranteeType <= 3 && rule.selfchoose === 0,
                    'Gacha guarantee variant not implemented',
                    ErrorCode.FunctionClosed,
                )
                const buckets = String(rule.gacha_pool_type_list || '')
                    .split('|')
                    .filter(Boolean)
                    .map((token) => {
                        const [field, text = '1', ...rest] = token.split('#'),
                            weight = Number(text),
                            items = parseRewards(pool[field])
                        ensure(
                            !rest.length && Number.isSafeInteger(weight) && weight > 0 && items.length > 0,
                            'Invalid or empty gacha candidate bucket',
                            ErrorCode.GameConfig,
                        )
                        ensure(
                            items.every((item) => [1, 9].includes(item.itemtype) && item.itemnum === 1),
                            'Gacha candidate category or quantity not implemented',
                            ErrorCode.FunctionClosed,
                        )
                        for (const item of items) {
                            const entry = this.tables.find(item.itemtype === 1 ? 'hero' : 'soulessence', item.itemid)
                            ensure(
                                entry &&
                                    Number.isInteger(entry.rarity) &&
                                    entry.rarity > 0 &&
                                    (item.itemtype !== 1 || entry.isUsable === 1),
                                'Gacha candidate item unavailable',
                                ErrorCode.GameConfig,
                            )
                            ensure(
                                entry.rarity >= 2 && entry.rarity <= 4,
                                'Gacha rarity category not implemented',
                                ErrorCode.FunctionClosed,
                            )
                        }
                        return { field, weight, items }
                    })
                ensure(buckets.length > 0, 'Gacha guarantee has no candidate buckets', ErrorCode.GameConfig)
                const members = new Set(buckets.flatMap((b) => b.items.map(identity)))
                const minimum = Math.min(
                    ...buckets.flatMap((b) =>
                        b.items.map(
                            (item) =>
                                this.tables.find(item.itemtype === 1 ? 'hero' : 'soulessence', item.itemid).rarity,
                        ),
                    ),
                )
                return { ...rule, buckets, members, minimum }
            })
            .sort((a, b) => a.guaranteepoolId - b.guaranteepoolId)
        ensure(
            new Set(rules.map((r) => r.guaranteepoolId)).size === rules.length,
            'Ambiguous gacha guarantee priority',
            ErrorCode.GameConfig,
        )
        const fallback = rules.at(-1),
            scale = fallback?.probability_base
        ensure(
            fallback &&
                fallback.guaranteeType === 0 &&
                fallback.guaranteeCount === 0 &&
                Number.isSafeInteger(scale) &&
                scale > 0,
            'Gacha fallback probability scale unavailable',
            ErrorCode.GameConfig,
        )
        let threshold = 0
        for (const r of rules) {
            ensure(r.probability_base <= scale, 'Gacha probability exceeds its scale', ErrorCode.GameConfig)
            // FIRST_FREE's one-off fixed tutorial rule is forced separately;
            // the remaining probabilities are ordered cumulative thresholds.
            if (r.guaranteeCount === 1 && !r.isRepeatable && r.probability_base === scale) continue
            ensure(r.probability_base >= threshold, 'Gacha probability thresholds are unordered', ErrorCode.GameConfig)
            threshold = r.probability_base
        }
        return { rules, scale, pool }
    }
    fee(config, pool, count) {
        ensure(count === 1 || count === 10, 'Invalid gacha draw count')
        ensure(
            [0, 1].includes(config.onlyTenPull) && uint(config.gachaLimit),
            'Invalid gacha draw limits',
            ErrorCode.GameConfig,
        )
        ensure(!config.onlyTenPull || count === 10, 'This pool only supports ten draws')
        ensure(
            !config.gachaLimit || pool.pool_draw_count + count <= config.gachaLimit,
            'Gacha draw limit reached',
            ErrorCode.GachaPoolIsNotOpen,
        )
        const special = String(config.specialRule || '')
            .split('|')
            .filter(Boolean)
        ensure(
            special.every((rule) => rule === 'FIRST_FREE'),
            'Gacha special rule not implemented',
            ErrorCode.FunctionClosed,
        )
        if (special.includes('FIRST_FREE') && pool.pool_draw_count === 0) {
            ensure(count === 1, 'Complete the first single observation first', ErrorCode.GachaFirstDrawNotUsed)
            return 0
        }
        ensure(
            Number.isInteger(config.tenPullDiscount) && config.tenPullDiscount >= 0 && config.tenPullDiscount <= 10,
            'Invalid gacha ten-draw discount',
            ErrorCode.GameConfig,
        )
        return count === 10 && config.tenPullDiscount > 0 ? Math.trunc((count * config.tenPullDiscount) / 10) : count
    }
    inherit(state, config, entry, rules) {
        if (entry.inheritance_initialized) return
        const sources = []
        for (const [id, source] of Object.entries(state.gacha.pools)) {
            const known = this.catalog.pools.get(Number(id)),
                type = known?.gachaType ?? source?.gacha_type
            if (Number(id) === config.gachaId || type !== config.gachaType) continue
            if (known) this.catalog.snapshot(state, Number(id))
            const time = saved64(source?.gacha_pool?.last_gacha_time ?? '0', 'Invalid inherited gacha timestamp')
            if (!time) continue
            const groups = known
                ? this.catalog.rules(known).map((r) => ({
                      pity_id: r.guaranteeId,
                      group: r.guaranteepoolId,
                      type: r.guaranteeType,
                      inherit: r.isInheritable,
                  }))
                : source.guarantee_groups
            ensure(
                Array.isArray(groups) &&
                    groups.every(
                        (r) =>
                            r &&
                            uint(r.pity_id) &&
                            r.pity_id > 0 &&
                            uint(r.group) &&
                            r.group > 0 &&
                            uint(r.type) &&
                            [0, 1].includes(r.inherit),
                    ),
                'Retired gacha inheritance metadata unavailable',
                ErrorCode.GameConfig,
            )
            sources.push({
                id,
                source,
                groups,
                time,
                record: saved64(source.last_record_id ?? '0', 'Invalid inherited gacha record identity'),
            })
        }
        sources.sort((a, b) =>
            a.record !== b.record
                ? a.record > b.record
                    ? -1
                    : 1
                : a.time !== b.time
                  ? a.time > b.time
                      ? -1
                      : 1
                  : Number(b.id) - Number(a.id),
        )
        for (const rule of rules.filter((r) => r.isInheritable)) {
            for (const candidate of sources) {
                const matches = candidate.groups.filter(
                    (r) => r.inherit && r.group === rule.guaranteepoolId && r.type === rule.guaranteeType,
                )
                ensure(matches.length <= 1, 'Ambiguous inherited guarantee group', ErrorCode.GameConfig)
                if (!matches.length) continue
                const source =
                    Array.isArray(candidate.source.pity) &&
                    candidate.source.pity.find((p) => p.pity_id === matches[0].pity_id)
                ensure(
                    source && uint(source.pity_count) && typeof source.is_completed === 'boolean',
                    'Invalid saved inherited gacha counter',
                    ErrorCode.GameConfig,
                )
                Object.assign(
                    entry.pity.find((p) => p.pity_id === rule.guaranteeId),
                    { pity_count: source.pity_count, is_completed: source.is_completed },
                )
                break
            }
        }
        entry.inheritance_initialized = true
    }
    history(state, config, item, now) {
        const ledger = state.gacha
        ensure(Array.isArray(ledger.history), 'Invalid saved gacha history', ErrorCode.GameConfig)
        const value = ledger.nextRecordId
        ensure(
            (typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value))) &&
                /^\d+$/.test(String(value)),
            'Invalid gacha history sequence',
            ErrorCode.GameConfig,
        )
        const id = BigInt(value)
        ensure(id > 0n && id <= max64, 'Gacha history identity space exhausted', ErrorCode.GameConfig)
        const seen = new Set()
        for (const row of ledger.history) {
            ensure(
                row &&
                    typeof row === 'object' &&
                    (typeof row.record_id === 'string' ||
                        (typeof row.record_id === 'number' && Number.isSafeInteger(row.record_id))) &&
                    /^\d+$/.test(String(row.record_id)),
                'Invalid saved gacha history identity',
                ErrorCode.GameConfig,
            )
            const prior = BigInt(row.record_id)
            ensure(
                prior > 0n && prior < id && !seen.has(String(prior)),
                'Gacha history identity is duplicate or not monotonic',
                ErrorCode.GameConfig,
            )
            seen.add(String(prior))
        }
        ledger.history.push({
            record_id: String(id),
            pool_id: config.gachaId,
            gacha_type: config.gachaType,
            gacha_time: String(now),
            item: [gachaWireItem(item)],
        })
        ledger.nextRecordId = String(id + 1n)
        return String(id)
    }
    propagate(state, config, entry, rules) {
        const changed = []
        for (const other of this.catalog.pools.values()) {
            if (other.gachaId === config.gachaId || other.gachaType !== config.gachaType) continue
            this.catalog.snapshot(state, other.gachaId)
            const next = this.catalog.state(state, other),
                otherRules = this.catalog.rules(other)
            let did = false
            for (const source of rules.filter((r) => r.isInheritable)) {
                const target = otherRules.find(
                    (r) =>
                        r.isInheritable &&
                        r.guaranteepoolId === source.guaranteepoolId &&
                        r.guaranteeType === source.guaranteeType,
                )
                if (!target) continue
                const a = entry.pity.find((p) => p.pity_id === source.guaranteeId),
                    b = next.pity.find((p) => p.pity_id === target.guaranteeId)
                if (a.pity_count !== b.pity_count || a.is_completed !== b.is_completed) {
                    b.pity_count = a.pity_count
                    b.is_completed = a.is_completed
                    did = true
                }
            }
            if (did) {
                next.inheritance_initialized = true
                changed.push(this.catalog.snapshot(state, other.gachaId))
            }
        }
        return changed
    }
    draw(c, request) {
        ensure(Number.isSafeInteger(c.now) && c.now >= 0, 'Invalid gacha server clock', ErrorCode.GameConfig)
        const config = this.catalog.configuration(request.pool_id)
        this.catalog.snapshot(c.state, config.gachaId)
        const ledger = c.state.gacha,
            entry = this.catalog.state(c.state, config),
            pool = entry.gacha_pool
        const key = c.requestKey ? createHash('sha256').update(c.requestKey).digest('hex') : null
        ledger.draw_receipts ??= {}
        ensure(
            ledger.draw_receipts && typeof ledger.draw_receipts === 'object' && !Array.isArray(ledger.draw_receipts),
            'Invalid saved gacha request receipts',
            ErrorCode.GameConfig,
        )
        ensure(
            Number.isInteger(this.policy.receipt_limit) &&
                this.policy.receipt_limit > 0 &&
                Number.isInteger(this.policy.receipt_ttl_seconds) &&
                this.policy.receipt_ttl_seconds > 0,
            'Invalid gacha receipt policy',
            ErrorCode.GameConfig,
        )
        for (const [id, row] of Object.entries(ledger.draw_receipts)) {
            ensure(
                row && Number.isSafeInteger(row.time) && row.time >= 0,
                'Invalid saved gacha request receipt',
                ErrorCode.GameConfig,
            )
            if (c.now - row.time > this.policy.receipt_ttl_seconds) delete ledger.draw_receipts[id]
        }
        const past = key && ledger.draw_receipts[key]
        if (past) {
            ensure(
                past.pool === request.pool_id && past.count === request.draw_count,
                'Gacha request identity reused with different input',
            )
            ensure(
                past.reply &&
                    Array.isArray(past.reply.gacha_results) &&
                    past.reply.gacha_results.length === request.draw_count,
                'Invalid cached gacha reply',
                ErrorCode.GameConfig,
            )
            return {
                reply: {
                    ...structuredClone(past.reply),
                    pool_info: this.catalog.snapshot(c.state, config.gachaId),
                    other_pool_infos: (past.reply.other_pool_infos ?? []).map((info) =>
                        this.catalog.snapshot(c.state, info.gacha_pool.pool_id),
                    ),
                },
                newHero: false,
                replay: true,
            }
        }
        ensure(this.open(config, c.now), 'Gacha pool is closed', ErrorCode.GachaPoolIsNotOpen)
        const model = this.compile(config),
            fee = this.fee(config, pool, request.draw_count),
            type = this.catalog.types.get(config.gachaType)
        ensure(
            entry.gacha_type === undefined || entry.gacha_type === config.gachaType,
            'Saved gacha category changed',
            ErrorCode.GameConfig,
        )
        entry.gacha_type = config.gachaType
        entry.guarantee_groups = model.rules.map((r) => ({
            pity_id: r.guaranteeId,
            group: r.guaranteepoolId,
            type: r.guaranteeType,
            inherit: r.isInheritable,
        }))
        ensure(
            uint(type.costItem) && type.costItem > 0 && this.tables.find('common_item', type.costItem),
            'Gacha ticket configuration unavailable',
            ErrorCode.GameConfig,
        )
        payGachaTickets(c, this.tables, type.costItem, fee)
        this.inherit(c.state, config, entry, model.rules)
        const up = new Set(parseRewards(model.pool.UP_hero_SSR).map(identity)),
            results = []
        const targets = parseRewards(config.selfChooseuplist),
            aimed = pool.aimed_item_ids
        ensure(
            aimed.length <= 1 && (!aimed.length || targets.some((t) => t.itemid === aimed[0])),
            'Saved gacha target is no longer offered',
            ErrorCode.GameConfig,
        )
        let newHero = false
        for (let i = 0; i < request.draw_count; i++) {
            const roll = random(c.randomInt, model.scale)
            const active = model.rules.filter(
                (r) => r.isRepeatable || !entry.pity.find((p) => p.pity_id === r.guaranteeId).is_completed,
            )
            const winner = active.find(
                (r) =>
                    (r.guaranteeCount > 0 &&
                        entry.pity.find((p) => p.pity_id === r.guaranteeId).pity_count + 1 >= r.guaranteeCount) ||
                    roll < r.probability_base,
            )
            ensure(winner, 'Gacha rules did not produce an item', ErrorCode.GameConfig)
            const bucket = weighted(winner.buckets, c.randomInt)
            let item = bucket.items[random(c.randomInt, bucket.items.length)]
            if (aimed.length && bucket.field === 'soulessence_SSR' && this.policy.aimed_ssr_policy === 'selected') {
                item = bucket.items.find((item) => item.itemtype === 9 && item.itemid === aimed[0])
                ensure(item, 'Aimed gacha target is absent from the selected bucket', ErrorCode.GameConfig)
            }
            const acquired = grantGachaAcquisition(this.tables, c.state, item)
            results.push(acquired.result)
            newHero ||= acquired.newHero
            ensure(pool.pool_draw_count < 0xffffffff, 'Gacha draw counter overflow', ErrorCode.GameConfig)
            pool.pool_draw_count++
            if (up.has(identity(item))) {
                ensure(pool.draw_up_hero_count < 0xffffffff, 'Gacha UP counter overflow', ErrorCode.GameConfig)
                pool.draw_up_hero_count++
            }
            for (const rule of active) {
                const saved = entry.pity.find((p) => p.pity_id === rule.guaranteeId)
                if (!rule.guaranteeCount) continue
                const qualified =
                    rule.guaranteeType === 1
                        ? rule.members.has(identity(item))
                        : [2, 3].includes(rule.guaranteeType)
                          ? acquired.rarity >= rule.minimum
                          : rule.guaranteeId === winner.guaranteeId
                if (qualified) {
                    saved.pity_count = 0
                    if (!rule.isRepeatable) {
                        saved.is_completed = true
                        if (!pool.triggered_special_rules.includes(rule.guaranteeId))
                            pool.triggered_special_rules.push(rule.guaranteeId)
                    }
                } else {
                    ensure(saved.pity_count < 0xffffffff, 'Gacha pity counter overflow', ErrorCode.GameConfig)
                    saved.pity_count++
                }
            }
            entry.last_record_id = this.history(c.state, config, item, c.now)
        }
        pool.last_gacha_time = String(c.now)
        const reply = {
            gacha_results: results,
            pool_info: this.catalog.snapshot(c.state, config.gachaId),
            other_pool_infos: this.propagate(c.state, config, entry, model.rules),
        }
        if (key) {
            ledger.draw_receipts[key] = {
                pool: request.pool_id,
                count: request.draw_count,
                time: c.now,
                reply: structuredClone(reply),
            }
            while (Object.keys(ledger.draw_receipts).length > this.policy.receipt_limit)
                delete ledger.draw_receipts[Object.keys(ledger.draw_receipts)[0]]
        }
        return { reply, newHero }
    }
}
