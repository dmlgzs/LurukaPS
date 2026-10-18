import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'

const catalogs = new WeakMap()
function catalog(tables) {
    if (!catalogs.has(tables)) {
        const rows = tables
            .get('home_level')
            .slice()
            .sort((a, b) => a.id - b.id)
        ensure(rows.length, 'Missing home level configuration', ErrorCode.HomeLvConfigNotFound)
        ensure(
            rows.every((row, i) => row.id === i + 1 && Number.isSafeInteger(row.exp) && row.exp > 0),
            'Invalid home level curve',
            ErrorCode.GameConfig,
        )
        catalogs.set(tables, rows)
    }
    return catalogs.get(tables)
}
function levelFromTotal(rows, total) {
    let level = 1,
        remainder = total
    while (level < rows.length && remainder >= BigInt(rows[level - 1].exp)) remainder -= BigInt(rows[level++ - 1].exp)
    return { level, exp: Number(remainder > BigInt(rows[level - 1].exp) ? BigInt(rows[level - 1].exp) : remainder) }
}
function mirror(state, total) {
    const attrs = state.player.attr_infos.attrs
    let attr = attrs.find((a) => a.attr_id === 1003)
    if (!attr) attrs.push((attr = { attr_id: 1003, attr_val: '0' }))
    attr.attr_val = String(total)
}
export function reconcileHomeExperience(tables, state) {
    const home = state.home
    if (!home || home.experienceVersion === 1) return false
    const rows = catalog(tables),
        level = Math.max(1, Math.min(rows.length, home.level || 1))
    const saved = rows.slice(0, level - 1).reduce((n, row) => n + BigInt(row.exp), BigInt(home.exp || 0))
    const wallet = BigInt(state.player.attr_infos.attrs.find((a) => a.attr_id === 1003)?.attr_val ?? '0')
    const total = wallet > saved ? wallet : saved
    ensure(total >= 0n && total <= 0xffffffffffffffffn, 'Invalid home experience', ErrorCode.InvalidLogic)
    Object.assign(home, levelFromTotal(rows, total), { experienceVersion: 1, experienceTotal: String(total) })
    // Repair the old resource-only ledger without paying historical level rewards twice.
    home.levelRewardedThrough = home.level
    if (total > 0n || wallet > 0n) mirror(state, total)
    state.homeRevision = (state.homeRevision || 0) + 1
    return true
}
export function grantHomeExperience(tables, state, count) {
    reconcileHomeExperience(tables, state)
    const home = state.home,
        rows = catalog(tables),
        previous = home.level
    const total = BigInt(home.experienceTotal) + BigInt(count)
    ensure(total <= 0xffffffffffffffffn, 'Home experience overflow', ErrorCode.InvalidArgument)
    Object.assign(home, levelFromTotal(rows, total), { experienceTotal: String(total) })
    mirror(state, total)
    const rewards = []
    for (
        let level = Math.max(previous + 1, (home.levelRewardedThrough || previous) + 1);
        level <= home.level;
        level++
    ) {
        if (rows[level - 1].level_reward) rewards.push(rows[level - 1].level_reward)
    }
    home.levelRewardedThrough = Math.max(home.levelRewardedThrough || 0, home.level)
    state.homeRevision = (state.homeRevision || 0) + 1
    return rewards
}
