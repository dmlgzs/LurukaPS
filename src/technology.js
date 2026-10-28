import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { homeCondition } from './home-grid.js'
import { reconcileTechnologyPoints } from './technology-points.js'
export function technologyState(tables, state) {
    ensure(state.home, 'Home state missing', ErrorCode.GameConfig)
    if (!state.home.technology) {
        state.home.technology = { levels: {}, spent: 0 }
        state.homeRevision = (state.homeRevision || 0) + 1
    }
    reconcileAutomaticTechnology(tables, state)
    return state.home.technology
}
const automaticRows = new WeakMap()
export function reconcileAutomaticTechnology(tables, state) {
    const tech = state.home?.technology
    if (!tech) return false
    let rows = automaticRows.get(tables)
    if (!rows) {
        rows = tables
            .get('home_technology_tree')
            .filter((tree) => tree.isAutoUnlock === 1)
            .map((tree) => ({
                tree,
                row: tables.get('home_technology').find((row) => row.type === tree.id && row.level === 1),
            }))
        automaticRows.set(tables, rows)
    }
    let changed = false,
        added
    do {
        added = false
        for (const { tree, row } of rows) {
            if (
                tech.levels[tree.id]?.level > 0 ||
                !row ||
                !technologyParents(tree, tech) ||
                !homeCondition(row.unlockCondi1, state)
            )
                continue
            tech.levels[tree.id] = { level: 1, lastTime: 0, isOpened: false }
            added = changed = true
        }
    } while (added)
    if (changed) state.homeRevision = (state.homeRevision || 0) + 1
    return changed
}
export function technologyPoints(tables, state) {
    technologyState(tables, state)
    return reconcileTechnologyPoints(tables, state)
}
export function technologyParents(tree, tech) {
    return String(tree.pretechnologyTypeId || '')
        .split('|')
        .filter(Boolean)
        .map(Number)
        .every((id) => (tech.levels[id]?.level || 0) > 0)
}
export function technologyType(tables, state, type) {
    ensure(
        tables.get('home_technology_type').some((t) => t.categroy === type),
        'Unknown technology category',
    )
    const tech = technologyState(tables, state)
    const list = tables
        .get('home_technology_tree')
        .filter((t) => t.category === type)
        .map((tree) => {
            const rows = tables.get('home_technology').filter((r) => r.type === tree.id),
                record = tech.levels[tree.id]
            return {
                subType: tree.id,
                subLevel: record?.level || 0,
                lastTime: record?.lastTime || 0,
                maxSubLevel: Math.max(0, ...rows.map((r) => r.level)),
                isOpened:
                    tree.isAutoUnlock === 1
                        ? !!record && (record.isOpened ?? true)
                        : !!record ||
                          (technologyParents(tree, tech) &&
                              homeCondition(rows.find((r) => r.level === 1)?.unlockCondi1, state)),
            }
        })
    return { type, list }
}
export function technologyPayload(tables, state) {
    const points = technologyPoints(tables, state)
    return {
        point: points.available,
        totalPoint: points.total,
        level: state.player.basic_info.lv,
        list: tables.get('home_technology_type').map((t) => technologyType(tables, state, t.categroy)),
    }
}
