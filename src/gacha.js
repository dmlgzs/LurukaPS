import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const uint = (value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff
function tableIndex(tables, name, key) {
    const rows = tables.get(name),
        result = new Map()
    for (const row of rows) {
        ensure(uint(row[key]) && row[key] > 0 && !result.has(row[key]), `Invalid ${name} key`, ErrorCode.GameConfig)
        result.set(row[key], row)
    }
    return result
}
export class GachaCatalog {
    constructor(tables) {
        this.pools = tableIndex(tables, 'gacha', 'gachaId')
        this.types = tableIndex(tables, 'gacha_type', 'id')
        this.guarantees = tableIndex(tables, 'gacha_guarantee', 'guaranteeId')
        this.probabilities = tableIndex(tables, 'gacha_prob_list', 'probList')
    }
    configuration(id) {
        const row = this.pools.get(id)
        ensure(row, 'Gacha pool configuration unavailable', ErrorCode.GameConfig)
        ensure(
            this.types.has(row.gachaType) && this.probabilities.has(row.probList),
            'Gacha pool references unavailable configuration',
            ErrorCode.GameConfig,
        )
        return row
    }
    rules(row) {
        const ids = String(row.guaranteeId || '')
            .split('|')
            .filter(Boolean)
            .map(Number)
        ensure(
            new Set(ids).size === ids.length && ids.every((id) => this.guarantees.has(id)),
            'Gacha guarantee configuration unavailable',
            ErrorCode.GameConfig,
        )
        return ids.map((id) => this.guarantees.get(id))
    }
    state(state, row) {
        const ledger = (state.gacha ??= { pools: {}, history: [], nextRecordId: '1' })
        ensure(
            ledger && typeof ledger === 'object' && !Array.isArray(ledger),
            'Invalid saved gacha ledger',
            ErrorCode.GameConfig,
        )
        ledger.pools ??= {}
        ensure(
            typeof ledger.pools === 'object' && !Array.isArray(ledger.pools),
            'Invalid saved gacha pool ledger',
            ErrorCode.GameConfig,
        )
        const entry = (ledger.pools[row.gachaId] ??= {
            gacha_pool: {
                pool_id: row.gachaId,
                pool_draw_count: 0,
                last_gacha_time: '0',
                triggered_special_rules: [],
                received_stage_count: 0,
                draw_up_hero_count: 0,
                received_up_count: 0,
                received_self_choose: false,
                aimed_item_ids: [],
            },
            pity: [],
        })
        ensure(
            entry && typeof entry === 'object' && !Array.isArray(entry),
            'Invalid saved gacha pool entry',
            ErrorCode.GameConfig,
        )
        return entry
    }
    snapshot(state, id) {
        const row = this.configuration(id),
            entry = this.state(state, row),
            pool = entry.gacha_pool
        ensure(
            pool &&
                pool.pool_id === id &&
                ['pool_draw_count', 'received_stage_count', 'draw_up_hero_count', 'received_up_count'].every((key) =>
                    uint(pool[key]),
                ) &&
                typeof pool.received_self_choose === 'boolean',
            'Invalid saved gacha counters',
            ErrorCode.GameConfig,
        )
        ensure(
            /^\d+$/.test(String(pool.last_gacha_time)) && BigInt(pool.last_gacha_time) <= 0xffffffffffffffffn,
            'Invalid saved gacha time',
            ErrorCode.GameConfig,
        )
        for (const key of ['triggered_special_rules', 'aimed_item_ids'])
            ensure(
                Array.isArray(pool[key]) && pool[key].every(uint) && new Set(pool[key]).size === pool[key].length,
                'Invalid saved gacha selection',
                ErrorCode.GameConfig,
            )
        ensure(
            Array.isArray(entry.pity) &&
                entry.pity.every((item) => item && typeof item === 'object') &&
                new Set(entry.pity.map((item) => item.pity_id)).size === entry.pity.length &&
                entry.pity.every(
                    (item) => uint(item.pity_id) && uint(item.pity_count) && typeof item.is_completed === 'boolean',
                ),
            'Invalid saved gacha pity',
            ErrorCode.GameConfig,
        )
        const pity = this.rules(row).map((rule) => {
            let saved = entry.pity.find((item) => item.pity_id === rule.guaranteeId)
            if (!saved) {
                saved = { pity_id: rule.guaranteeId, pity_count: 0, is_completed: false }
                entry.pity.push(saved)
            }
            return { ...saved }
        })
        return {
            gacha_pool: {
                ...pool,
                triggered_special_rules: [...pool.triggered_special_rules],
                aimed_item_ids: [...pool.aimed_item_ids],
            },
            pity,
        }
    }
}
