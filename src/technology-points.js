import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const MAX = 0xffffffff
const uint = (n, name) => {
    ensure(Number.isSafeInteger(n) && n >= 0 && n <= MAX, `Invalid technology ${name}`, ErrorCode.GameConfig)
    return n
}
function read(tables, state) {
    ensure(state.home && state.player?.attr_infos?.attrs, 'Technology state missing', ErrorCode.GameConfig)
    const tech = state.home.technology ?? { levels: {}, spent: 0 }
    const spent = uint(tech.spent, 'spent points')
    const level = uint(state.player.basic_info.lv, 'player level')
    let levelTotal = 0
    for (const row of tables.get('home_technology_level')) {
        uint(row.id, 'schedule level')
        uint(row.technologyCount, 'schedule points')
        if (row.id <= level) levelTotal = uint(levelTotal + row.technologyCount, 'level total')
    }
    const attrs = state.player.attr_infos.attrs
    ensure(Array.isArray(attrs), 'Invalid technology attributes', ErrorCode.GameConfig)
    const matches = attrs.filter((a) => a.attr_id === 205)
    ensure(matches.length <= 1, 'Duplicate technology currency', ErrorCode.GameConfig)
    const attr = matches[0]
    ensure(!attr || /^(0|[1-9]\d*)$/.test(attr.attr_val), 'Invalid technology currency', ErrorCode.GameConfig)
    const oldValue = attr ? BigInt(attr.attr_val) : 0n
    ensure(oldValue <= BigInt(MAX), 'Technology currency overflow', ErrorCode.GameConfig)
    const ledger = tech.pointLedger
    let extraTotal
    if (ledger === undefined) {
        ensure(state.technologyPointVersion === undefined, 'Managed technology ledger missing', ErrorCode.GameConfig)
        // 0349 never mirrored level points into 205 or debited it for study.
        // Import that independent credit once; managed mirrors are never credits.
        extraTotal = Number(oldValue)
    } else {
        ensure(state.technologyPointVersion === 1, 'Technology migration marker mismatch', ErrorCode.GameConfig)
        ensure(ledger?.version === 1, 'Unknown technology point ledger', ErrorCode.GameConfig)
        extraTotal = uint(ledger.extraTotal, 'extra total')
        const previousTotal = uint(uint(ledger.levelTotal, 'previous level total') + extraTotal, 'previous total')
        ensure(
            attr && oldValue === BigInt(Math.max(0, previousTotal - spent)),
            'Technology currency mirror mismatch',
            ErrorCode.GameConfig,
        )
    }
    const total = uint(levelTotal + extraTotal, 'total points')
    return { tech, attr, attrs, levelTotal, extraTotal, spent, total, available: Math.max(0, total - spent) }
}
function write(state, view) {
    const { tech, attr, attrs, levelTotal, extraTotal, spent, available } = view
    const changed =
        !state.home.technology ||
        !tech.pointLedger ||
        tech.pointLedger.levelTotal !== levelTotal ||
        tech.pointLedger.extraTotal !== extraTotal ||
        tech.spent !== spent ||
        attr?.attr_val !== String(available)
    state.home.technology = tech
    state.technologyPointVersion = 1
    tech.spent = spent
    tech.pointLedger = { version: 1, extraTotal, levelTotal }
    if (attr) attr.attr_val = String(available)
    else attrs.push({ attr_id: 205, attr_val: String(available) })
    if (changed) state.homeRevision = (state.homeRevision || 0) + 1
    return { total: view.total, available }
}
export function reconcileTechnologyPoints(tables, state) {
    return write(state, read(tables, state))
}
export function creditTechnologyPoints(tables, state, amount) {
    uint(amount, 'credit')
    ensure(amount > 0, 'Invalid technology credit', ErrorCode.GameConfig)
    const view = read(tables, state)
    view.extraTotal = uint(view.extraTotal + amount, 'extra total')
    view.total = uint(view.total + amount, 'total points')
    view.available = Math.max(0, view.total - view.spent)
    return write(state, view)
}
export function spendTechnologyPoints(tables, state, amount) {
    uint(amount, 'cost')
    const view = read(tables, state)
    ensure(view.available >= amount, 'Insufficient technology points', ErrorCode.HomeTechnologyPointLimit)
    view.spent = uint(view.spent + amount, 'spent points')
    view.available -= amount
    return write(state, view)
}
