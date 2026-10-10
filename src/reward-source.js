import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// Source metadata controls presentation, never eligibility or delivery.
// Loot validation remains in grantRewards and the relevant claim handler.
const warned = new Set()
const defaultLog = fileURLToPath(new URL('../data/reward-source-warnings.jsonl', import.meta.url))
function warn(reason, operation, id, error) {
    const key = JSON.stringify([reason, String(operation), id ?? null])
    if (warned.has(key)) return
    warned.add(key)
    while (warned.size > 256) warned.delete(warned.values().next().value)
    const record = {
        time: new Date().toISOString(),
        reason,
        operation: String(operation),
        source_id: id ?? null,
        fallback: 'omit_src',
        ...(error ? { error: String(error.message ?? error).slice(0, 512) } : {}),
    }
    const line = JSON.stringify(record)
    try {
        console.warn('[reward-source] ' + line)
    } catch {
        /* Logging must not block delivery. */
    }
    const file = process.env.LURUKAPS_REWARD_SOURCE_LOG ?? process.env.AZUR_REWARD_SOURCE_LOG ?? defaultLog
    if (!file) return
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.appendFileSync(file, line + '\n')
    } catch (writeError) {
        try {
            console.warn('[reward-source] log-write-failed: ' + String(writeError.message ?? writeError))
        } catch {
            /* Keep the fallback nonblocking. */
        }
    }
}
let sources = {}
try {
    const configured = JSON.parse(fs.readFileSync(new URL('../configs/reward-sources.json', import.meta.url), 'utf8'))
    if (configured && typeof configured === 'object' && !Array.isArray(configured)) sources = configured
    else warn('invalid_source_config', 'config')
} catch (error) {
    warn('source_config_unavailable', 'config', undefined, error)
}
export function rewardSource(tables, operation) {
    const id = Object.hasOwn(sources, operation) ? sources[operation] : undefined
    if (!Number.isInteger(id) || id <= 0) {
        warn(id === undefined ? 'unknown_operation' : 'invalid_source_id', operation, id)
        return undefined
    }
    try {
        if (tables.find('reason_itemnum_change', id)?.id === id) return id
        warn('source_row_missing', operation, id)
    } catch (error) {
        warn('source_table_unavailable', operation, id, error)
    }
    return undefined
}
