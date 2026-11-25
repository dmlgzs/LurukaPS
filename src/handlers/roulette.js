import { readTable } from '../table-source.js'
import { ensure } from './common.js'
import { u64 } from '../combat-state.js'
const items = new Map(readTable('common_item').map((r) => [r.id, r]))
export function roulettePayload(state) {
    return {
        roulettes: Object.values(state.roulettes ?? {}).map((row) => ({
            ...row,
            guid:
                row.type === 1
                    ? row.guid.map((id) => (id === '0' || state.pets.some((p) => p.guid === id) ? id : '0'))
                    : row.guid,
        })),
    }
}
export function registerRoulette(on) {
    on('SetRouletteItem', (c, r) => {
        const type = r.type,
            raw = r.guid ?? [],
            pos = r.pos ?? 0
        ensure(type === 1 || type === 3, 'Unknown roulette type')
        ensure(raw.length <= 9 && Number.isInteger(pos) && pos >= 0 && pos <= 9, 'Invalid roulette layout')
        const guid = raw.map(u64)
        while (guid.length < 9) guid.push('0')
        const selected = guid.filter((id) => id !== '0')
        ensure(new Set(selected).size === selected.length, 'Duplicate roulette item')
        for (const id of selected) {
            if (type === 1)
                ensure(
                    c.state.pets.some((p) => p.guid === id),
                    'Pet not owned',
                )
            else {
                const number = Number(id),
                    item = items.get(number)
                ensure(
                    Number.isSafeInteger(number) && item?.rouletteType === 3,
                    'Item cannot be placed in this roulette',
                )
                ensure(
                    c.state.player.sbag_infos.items.some(
                        (i) => i.itemid === number && i.itemnum > 0 && (!i.deadtime || i.deadtime > c.now),
                    ),
                    'Item not owned',
                )
            }
        }
        ;(c.state.roulettes ??= {})[type] = { type, guid, pos }
        c.pushBefore('CSProtoAllRouletteInfoSync', roulettePayload(c.state))
        return {}
    })
}
