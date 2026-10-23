import { abyssTables } from './abyss-catalog.js'
import { abyssDataSnapshot } from './abyss-data.js'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const modeFields = ['newer', 'persistent', 'rotation']
function requirePrefix(rows) {
    let count = 0,
        gap = false
    for (const row of rows) {
        if (row.passed) {
            ensure(!gap, 'Non-contiguous saved abyss completion', ErrorCode.GameConfig)
            count++
        } else gap = true
    }
    return count
}
function isModeOpen(tables, passed, row) {
    if (!row.condition) return true
    return String(row.condition)
        .split('|')
        .every((text) => {
            const [type, level, ...extra] = text.split('#').map(Number)
            ensure(
                type === 13111 && Number.isSafeInteger(level) && level > 0 && !extra.length,
                'Unsupported abyss overview mode condition',
                ErrorCode.FunctionClosed,
            )
            ensure(
                tables.find('abbys_level', level),
                'Abyss overview prerequisite level missing',
                ErrorCode.AbyssInvalidLevel,
            )
            return passed.has(level)
        })
}

export function abyssGlobalView(external, state, now, policy) {
    const tables = abyssTables(external),
        data = abyssDataSnapshot(tables, state, now, policy)
    const rows = modeFields.map((field) => data[field + '_mode_info']),
        progress = rows.map(requirePrefix),
        passed = new Set(
            rows
                .flat()
                .filter((row) => row.passed)
                .map((row) => row.cur_level),
        )
    ensure(
        rows[0].length && rows[1].length && (!data.rotation_id || rows[2].length),
        'Abyss overview level configuration missing',
        ErrorCode.AbyssInvalidLevel,
    )
    let mode = 1
    for (let candidate = 1; candidate <= 3; candidate++) {
        const config = tables.find('abbys_mode', candidate)
        ensure(config, 'Abyss overview mode configuration missing', ErrorCode.AbyssInvalidMode)
        if ((candidate === 3 && !data.rotation_id) || !isModeOpen(tables, passed, config)) break
        mode = candidate
    }
    // Rotation metadata describes the active season independently of challenge
    // unlock conditions, just like 11449. Do not invent a new map visibility gate.
    const rotationOpen = data.rotation_id > 0,
        totalStar = rotationOpen ? rows[2].reduce((sum, row) => sum + (row.passed ? row.star_num : 0), 0) : 0
    ensure(
        Number.isSafeInteger(totalStar) && totalStar >= 0 && totalStar <= 0xffffffff,
        'Invalid abyss overview star total',
        ErrorCode.GameConfig,
    )
    // Current ReqAbyssGlobalView callback writes these fields into the rotation
    // cache. GetAbyssModePassedProgress uses cur_level as a floor COUNT, not a
    // level ID or the next target; the map chooses its branch from rotation_id.
    return {
        rotation_id: rotationOpen ? data.rotation_id : 0,
        rotation_mode_end_time: rotationOpen ? data.rotation_mode_end_time : 0,
        cur_level: rotationOpen ? progress[2] : 0,
        total_star: totalStar,
        inherit_notify_flag: state.abyss?.inheritNotify === true,
        mode,
    }
}
