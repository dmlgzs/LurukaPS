import { ErrorCode } from './error-codes.js'
import { randomInt } from 'node:crypto'
import { ensure } from './handlers/common.js'

function qualityEntries(text) {
    const entries = String(text || '')
        .split('|')
        .filter(Boolean)
        .map((token) => {
            const [id, weight, ...extra] = token.split('#').map(Number)
            ensure(
                !extra.length && Number.isInteger(id) && id > 0 && Number.isInteger(weight) && weight > 0,
                'Invalid custom ornament quality',
                ErrorCode.GameConfig,
            )
            return { id, weight }
        })
    const total = entries.reduce((sum, entry) => sum + entry.weight, 0)
    ensure(total > 0 && Number.isSafeInteger(total), 'Missing custom ornament quality', ErrorCode.GameConfig)
    return entries
}
function quality(entries, rng) {
    let draw = rng(entries.reduce((sum, entry) => sum + entry.weight, 0))
    for (const entry of entries) {
        draw -= entry.weight
        if (draw < 0) return entry.id
    }
    throw Error('Invalid custom ornament quality draw')
}

export function customOrnamentConfiguration(tables, id) {
    const custom = tables.find('accessory_customed', id),
        accessory = tables.find('accessory', custom?.accessoryId)
    ensure(custom && accessory, 'Unknown custom ornament', ErrorCode.OrnamentConfFail)
    return { custom, accessory, qualities: qualityEntries(custom.quality) }
}

export function createCustomOrnaments(tables, state, id, count, rng = randomInt) {
    const { custom, accessory, qualities } = customOrnamentConfiguration(tables, id)
    state.ornaments ??= []
    ensure(
        Number.isInteger(count) && count > 0 && count <= 1000 && state.ornaments.length + count <= 10000,
        'Ornament bag limit',
    )
    let next = Math.max(state.nextOrnamentGuid || 1, ...state.ornaments.map((entry) => entry.guid + 1))
    ensure(next + count - 1 <= 0xffffffff, 'Ornament identity space exhausted')
    const created = []
    for (let i = 0; i < count; i++)
        created.push({
            guid: next++,
            id: accessory.id,
            lv: 0,
            infos: [],
            wear_hero: '0',
            lock: false,
            group: 0,
            score: custom.score || 0,
            affixes: [],
            ele_group: 0,
            grade: custom.grade || 0,
            quality: quality(qualities, rng),
        })
    state.ornaments.push(...created)
    state.nextOrnamentGuid = next
    state.ornamentRevision = (state.ornamentRevision || 0) + 1
    return created
}
