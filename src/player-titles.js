import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'

const fields = ['preffix_title', 'suffix_title']
const views = new WeakMap()
const uint = (id) => Number.isInteger(id) && id > 0 && id <= 0xffffffff
function catalogue(tables) {
    const rows = tables.get('player_title'),
        byId = new Map()
    for (const row of rows) {
        ensure(
            uint(row.id) && [1, 2].includes(row.type) && !byId.has(row.id),
            'Malformed player title configuration',
            ErrorCode.GameConfig,
        )
        byId.set(row.id, row)
    }
    const value = tables.get('game').find((row) => row.title === 'PLAYERTITLE_DEFAULT')?.value
    ensure(
        typeof value === 'string' && value.length > 0,
        'Missing default player title configuration',
        ErrorCode.GameConfig,
    )
    const defaults = value.split('|').map(Number)
    ensure(
        defaults.every((id) => uint(id) && byId.has(id)) && new Set(defaults).size === defaults.length,
        'Invalid default player title configuration',
        ErrorCode.GameConfig,
    )
    return { byId, defaults }
}
export function playerTitleSnapshot(tables, state) {
    const { byId, defaults } = catalogue(tables),
        saved = state.titles
    ensure(
        saved === undefined || (saved && typeof saved === 'object' && !Array.isArray(saved)),
        'Malformed player title ownership',
        ErrorCode.GameConfig,
    )
    return Object.fromEntries(
        fields.map((field, index) => {
            const list = saved?.[field] ?? []
            ensure(
                Array.isArray(list) &&
                    list.every((id) => uint(id) && byId.get(id)?.type === index + 1) &&
                    new Set(list).size === list.length,
                'Malformed owned player title list',
                ErrorCode.GameConfig,
            )
            return [
                field,
                [...new Set([...defaults.filter((id) => byId.get(id).type === index + 1), ...list])].sort(
                    (a, b) => a - b,
                ),
            ]
        }),
    )
}
export function playerTitleList(store, tables, id) {
    if (!views.has(store)) views.set(store, new Map())
    const entries = views.get(store),
        token = store.readCacheToken(id)
    let cached = entries.get(id)
    if (cached?.token !== token) {
        const titles = store.read(id, (state) => {
            playerTitleSnapshot(tables, state)
            return state.titles === undefined
                ? undefined
                : Object.fromEntries(fields.map((field) => [field, [...(state.titles[field] ?? [])]]))
        })
        cached = { token, titles }
        if (!entries.has(id) && entries.size >= 4096) entries.delete(entries.keys().next().value)
        entries.set(id, cached)
    }
    return playerTitleSnapshot(tables, cached)
}
export function changePlayerTitle(c, request) {
    ensure([1, 2].includes(request.type), 'Invalid player title slot', ErrorCode.TitleTypeFail)
    const { byId } = catalogue(c.tables),
        row = byId.get(request.id)
    ensure(row, 'Player title configuration not found', ErrorCode.TitleConfNotExist)
    ensure(row.type === request.type, 'Player title does not match its slot', ErrorCode.TitleTypeFail)
    const field = fields[request.type - 1],
        owned = playerTitleSnapshot(c.tables, c.state)
    ensure(owned[field].includes(row.id), 'Player title is not owned', ErrorCode.PlayerHadNotTheTitle)
    c.state.player.basic_info[field] = row.id
    // Game.dispatch publishes changed basic_info before the empty success reply.
    return {}
}
export function grantPlayerTitle(tables, state, id) {
    const { byId } = catalogue(tables),
        row = byId.get(id)
    ensure(row, 'Unknown player title reward', ErrorCode.GameConfig)
    const owned = playerTitleSnapshot(tables, state),
        field = fields[row.type - 1]
    if (owned[field].includes(id)) return false
    state.titles = { ...state.titles, [field]: [...(state.titles?.[field] ?? []), id] }
    return true
}
