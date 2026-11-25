import { tableExportManifest } from './table-source.js'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

const zone = 8 * 3600
export function configTime(value) {
    if (!value) return 0
    const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(value)
    ensure(m, 'Invalid shop date', ErrorCode.GameConfig)
    const [y, mo, d, h, mi, s] = m.slice(1).map(Number)
    const n = Date.UTC(y, mo - 1, d, h, mi, s) / 1000 - zone
    const date = new Date((n + zone) * 1000)
    ensure(
        date.getUTCFullYear() === y &&
            date.getUTCMonth() === mo - 1 &&
            date.getUTCDate() === d &&
            h < 24 &&
            mi < 60 &&
            s < 60,
        'Invalid shop date',
        ErrorCode.GameConfig,
    )
    return n
}

// Only a complete export can prove that this version ships no static calendar.
// Declared, corrupt, and unclassified missing files retain their strict errors.
export function staticTimeRows(tables) {
    const manifest = tableExportManifest(tables)
    if (manifest && !manifest.names.has('common_timelimit')) return undefined
    const rows = tables.get('common_timelimit')
    ensure(Array.isArray(rows), 'Invalid static time definitions', ErrorCode.GameConfig)
    const ids = new Set()
    for (const row of rows) {
        ensure(
            row &&
                Number.isInteger(row.id) &&
                row.id > 0 &&
                row.id <= 0xffffffff &&
                !ids.has(row.id) &&
                typeof row.startTime === 'string' &&
                typeof row.endTime === 'string',
            'Invalid static time definition',
            ErrorCode.GameConfig,
        )
        ids.add(row.id)
        const start = configTime(row.startTime),
            end = configTime(row.endTime)
        ensure(
            start >= 0 && end >= 0 && (!start || !end || start < end),
            'Invalid static time interval',
            ErrorCode.GameConfig,
        )
    }
    return rows
}

export function staticTimeRow(tables, id) {
    return staticTimeRows(tables)?.find((row) => row.id === Number(id))
}

export function mergeCommonTime(times, row) {
    ensure(
        Number.isInteger(row.time_id) && row.time_id > 0 && row.time_id <= 0xffffffff,
        'Invalid common time ID',
        ErrorCode.GameConfig,
    )
    const values = [row.start_time, row.end_time].map((value) => {
        ensure(
            (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) || (Number.isSafeInteger(value) && value >= 0),
            'Invalid common time value',
            ErrorCode.GameConfig,
        )
        const result = BigInt(value)
        ensure(result <= 0xffffffffffffffffn, 'Common time exceeds uint64', ErrorCode.GameConfig)
        return result.toString()
    })
    const normalized = { time_id: row.time_id, start_time: values[0], end_time: values[1] }
    const previous = times.get(row.time_id)
    ensure(
        !previous || (previous.start_time === normalized.start_time && previous.end_time === normalized.end_time),
        'Conflicting definitions share one common time ID',
        ErrorCode.GameConfig,
    )
    times.set(row.time_id, normalized)
}

// Current ordinary shop/goods rows retain explicit dates even without a static
// calendar. Derive shared IDs from those rows, never from a version-specific list.
export function shopTimeDefinitions(tables) {
    const times = new Map()
    for (const name of ['shop', 'goods']) {
        for (const row of tables.get(name)) {
            if (!row.timelimit || (!row.startTime && !row.endTime)) continue
            const start = configTime(row.startTime),
                end = configTime(row.endTime)
            ensure(!start || !end || start < end, 'Invalid shop schedule interval', ErrorCode.GameConfig)
            mergeCommonTime(times, { time_id: row.timelimit, start_time: start, end_time: end })
        }
    }
    return times.values()
}
