export class GameError extends Error {
    constructor(message, code = 1024) {
        super(message)
        this.code = code
    }
}
export function ensure(condition, message = 'Invalid argument', code = 1024) {
    if (!condition) throw new GameError(message, code)
}
export function textValue(value, max = 64) {
    ensure(typeof value === 'string', 'Missing text')
    const b = Buffer.from(value, 'base64')
    const s = b.toString('utf8')
    ensure(s.trim().length > 0 && [...s].length <= max && !s.includes('\0'), 'Invalid text')
    return value
}
export function hero(s, id) {
    const h = s.player.heros_info.heros.find((h) => h.guid === String(id))
    ensure(h, 'Hero not owned')
    return h
}
export function pet(s, id) {
    const p = s.pets.find((p) => p.guid === String(id))
    ensure(p, 'Pet not owned')
    return p
}
export function manager(s, type = 1) {
    const m = s.player.group_mgrs.find((m) => m.type === type)
    ensure(m, 'Unknown group type')
    return m
}
export function group(s, type = 1, id) {
    const m = manager(s, type)
    const g = m.groups.find((g) => g.id === (id ?? m.cur_group))
    ensure(g, 'Unknown group')
    return g
}
export const syncPlayer = (c, data) => c.push('CSProtoSyncPlayerData', data || c.state.player)
export const syncPets = (c) =>
    c.push('CSProtoPetInfoSync', { pet_infos: { pets: c.state.pets }, record_pets: c.state.recordPets ?? [] })

// src=1 refreshes cached formation metadata without recreating its entities.
export function syncGroupControl(c, type = 1) {
    const m = manager(c.state, type),
        g = group(c.state, type)
    c.pushBefore('CSProtoSyncPlayerData', {
        group_mgrs: [{ type: m.type, cur_group: m.cur_group, src: 1, groups: [g] }],
    })
}
