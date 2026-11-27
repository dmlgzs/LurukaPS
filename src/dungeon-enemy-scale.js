import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const int = (value) => Number.isSafeInteger(value) && value >= -0x80000000 && value <= 0x7fffffff
function baseScales(tables, dungeon, mapId, groupId) {
    const seen = new Set()
    for (const part of String(dungeon.difficultIndex ?? '')
        .split('|')
        .filter(Boolean)) {
        const values = part.split('#').map(Number),
            objectId = values[0]
        ensure(
            values.length >= 3 &&
                values.length % 2 === 1 &&
                Number.isSafeInteger(objectId) &&
                objectId >= 0 &&
                !seen.has(objectId),
            'Dungeon group scale source is malformed',
            ErrorCode.GameConfig,
        )
        seen.add(objectId)
        const scales = new Map()
        for (let i = 1; i < values.length; i += 2) {
            ensure(
                Number.isSafeInteger(values[i]) && values[i] > 0 && int(values[i + 1]) && !scales.has(values[i]),
                'Dungeon attribute scale is malformed or duplicated',
                ErrorCode.GameConfig,
            )
            scales.set(values[i], values[i + 1])
        }
        // Current06008731 skips missing variant rows and matches expandId,
        // not the requested object ID or the dungeon.enemy display list.
        if (tables.find(`worldmap_${mapId}`, objectId)?.expandId === groupId) return scales
    }
    return new Map()
}

// Current GetMultiAttScale06008732: float32 merge then conv.i4; preserve base
// attributes absent from the participant coefficient dictionary.
export function dungeonEnemyScales(tables, dungeonId, mapId, groupId, participants) {
    ensure(
        Number.isInteger(participants) && participants >= 1 && participants <= 3,
        'Dungeon participant scale count is unavailable',
        ErrorCode.GameConfig,
    )
    const dungeon = tables.find('dungeon', dungeonId)
    ensure(dungeon, 'Dungeon enemy scale configuration unavailable', ErrorCode.DungeonConfNotExist)
    const base = baseScales(tables, dungeon, mapId, groupId)
    if (!dungeon.multiIndex) return base
    const row = tables.find('dungeon_multi_index', dungeon.multiIndex)
    // Current client returns null for an absent index,leaving its base list.
    // Keep the diagnostic instead of inventing a multiplier or reading CBT3.
    if (!row) {
        console.warn(
            '[dungeon-enemy-scale]',
            JSON.stringify({ event: 'missing-current-multi-index', dungeon_id: dungeonId, index: dungeon.multiIndex }),
        )
        return base
    }
    const field = ['simpleNum', 'doubleNum', 'tripleNum'][participants - 1],
        result = new Map()
    for (const part of String(row[field] ?? '')
        .split('|')
        .filter(Boolean)) {
        const values = part.split('#').map(Number),
            [id, value] = values
        ensure(
            values.length === 2 && Number.isSafeInteger(id) && id > 0 && Number.isFinite(value) && !result.has(id),
            'Dungeon participant attribute scale is malformed',
            ErrorCode.GameConfig,
        )
        let merged = Math.fround(value)
        if (base.has(id)) merged = Math.fround(Math.fround(Math.fround(base.get(id)) / 10000) * merged)
        ensure(
            Number.isFinite(merged) && merged >= -0x80000000 && merged <= 0x7fffffff,
            'Dungeon participant attribute scale overflows',
            ErrorCode.GameConfig,
        )
        result.set(id, Math.trunc(merged))
    }
    if (!result.size) return base
    for (const [id, value] of base) if (!result.has(id)) result.set(id, value)
    return result
}

// InitMonsterData0600e220 multiplies AttrInfo.baseValue before the wire HP
// integer conversion. Do not multiply an already floored single-player HP.
export function scaledEnemyHp(rawBaseHp, scales) {
    const scaled = Math.fround(rawBaseHp * Math.fround(Math.fround(scales.get(5) ?? 10000) / 10000)),
        hp = Math.floor(scaled)
    ensure(
        Number.isSafeInteger(hp) && hp > 0 && hp <= 0xffffffff,
        'Scaled dungeon enemy HP is invalid',
        ErrorCode.GameConfig,
    )
    return hp
}
