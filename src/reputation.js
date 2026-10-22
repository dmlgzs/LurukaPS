import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'
const catalogues = new WeakMap()
function catalogue(tables) {
    if (catalogues.has(tables)) return catalogues.get(tables)
    const groups = new Map()
    for (const row of tables.get('reputation_level')) {
        let group = groups.get(row.reputationId)
        if (!group) groups.set(row.reputationId, (group = []))
        group.push(row)
    }
    for (const [id, rows] of groups) {
        rows.sort((a, b) => a.reputationlevel - b.reputationlevel)
        ensure(
            rows.every(
                (r, i) =>
                    r.reputationlevel === i + 1 &&
                    Number.isInteger(r.reputationNeed) &&
                    r.reputationNeed >= 0 &&
                    (i === rows.length - 1 || r.reputationNeed > 0),
            ),
            'Invalid reputation level curve',
            ErrorCode.GameConfig,
        )
        const group = tables.find('groups', id)
        ensure(
            group && tables.find('currency', group.reputation),
            'Reputation display currency unavailable',
            ErrorCode.GameConfig,
        )
    }
    catalogues.set(tables, groups)
    return groups
}
export function ensureReputations(tables, state) {
    let map = state.reputations
    for (const [id] of catalogue(tables))
        if (!map?.[id]) map = { ...map, [id]: { rep_id: id, value: 0, level: 1, total: 0 } }
    if (map !== state.reputations) state.reputations = map
    return map
}
export function grantReputation(tables, state, id, amount) {
    ensure(
        Number.isInteger(amount) && amount > 0 && amount <= 0xffffffff,
        'Invalid reputation reward amount',
        ErrorCode.GameConfig,
    )
    const groups = catalogue(tables)
    const groupId = groups.has(id) ? id : [...groups.keys()].find((key) => tables.find('groups', key).reputation === id)
    ensure(groupId, 'Unknown reputation reward', ErrorCode.GameConfig)
    ensureReputations(tables, state)
    const rows = groups.get(groupId),
        old = state.reputations[groupId],
        info = { ...old }
    ensure(
        Number.isInteger(info.level) &&
            info.level >= 1 &&
            info.level <= rows.length &&
            Number.isInteger(info.value) &&
            info.value >= 0,
        'Invalid saved reputation',
        ErrorCode.GameConfig,
    )
    info.total =
        (info.total ?? rows.slice(0, info.level - 1).reduce((n, r) => n + r.reputationNeed, 0) + info.value) + amount
    info.value += amount
    ensure(
        Number.isSafeInteger(info.total) &&
            info.total <= 0xffffffff &&
            Number.isSafeInteger(info.value) &&
            info.value <= 0xffffffff,
        'Reputation reward overflow',
        ErrorCode.GameConfig,
    )
    while (info.level < rows.length && info.value >= rows[info.level - 1].reputationNeed) {
        info.value -= rows[info.level - 1].reputationNeed
        info.level++
    }
    if (info.level === rows.length) {
        info.overflow = (info.overflow ?? 0) + info.value
        info.value = 0
    }
    state.reputations = { ...state.reputations, [groupId]: info }
    state.reputationRevision = (state.reputationRevision ?? 0) + 1
    // Order tables use a group ID; ItemManager renders type29 CommonItem IDs
    // through currency. Keep the group ID in the11250 progression snapshot.
    return { itemtype: 29, itemid: tables.find('groups', groupId).reputation, itemnum: amount }
}
export function reputationSnapshot(tables, state) {
    return {
        infos: [...catalogue(tables).keys()].map((id) => {
            const info = state.reputations?.[id]
            return { rep_id: id, value: info?.value ?? 0, level: info?.level ?? 1 }
        }),
    }
}
