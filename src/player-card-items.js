import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'

export function playerCardSnapshot(tables, state) {
    state.playerCardItems ??= []
    const ids = new Set(state.playerCardItems.map((item) => item.config))
    for (const row of tables.get('playercard_dress'))
        if (row.defaultComponent === 1 && !ids.has(row.id)) {
            state.playerCardItems.push({ config: row.id, url: '' })
            ids.add(row.id)
        }
    return { bags: state.playerCardItems }
}
export function grantPlayerCardItem(tables, state, id) {
    ensure(tables.find('playercard_dress', id), 'Unknown player card decoration', ErrorCode.CardDressConfNone)
    const { bags } = playerCardSnapshot(tables, state)
    if (bags.some((item) => item.config === id)) return
    bags.push({ config: id, url: '' })
    state.playerCardRevision = (state.playerCardRevision ?? 0) + 1
}
