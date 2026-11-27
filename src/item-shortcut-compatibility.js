import { createHash } from 'node:crypto'
import policy from '../configs/item-shortcut-compatibility.json' with { type: 'json' }
import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const positive = (value) => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff
const slot = (value) => Number.isInteger(value) && value >= 1 && value <= 6
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const valid = (condition, message) => ensure(condition, message, ErrorCode.GameConfig)
const sortedIds = (value) => Array.isArray(value) && value.every((id, i) => positive(id) && (!i || id > value[i - 1]))

export function compileItemShortcutCompatibility(items, source = policy) {
    valid(
        object(source) &&
            source.version === 1 &&
            source.policyId === 'retired-item-shortcuts-1.0.0-v1' &&
            source.origin === 'LOCAL' &&
            source.scope === 'historical-shortcut-layout-only' &&
            source.execution === 'current-item-definition-and-current-quickbar-eligibility-only' &&
            source.automaticPrune === 'retain-proven-retired-raw-slots-and-archive-originals' &&
            source.explicitEdit === 'permit-current-replacement-or-matching-clear-with-original-archive' &&
            source.restoreFromInventoryOrArchive === false &&
            object(source.source) &&
            object(source.target) &&
            source.target.clientVersion === '1.0.0' &&
            source.target.packageVersion === '3217420',
        'Item-shortcut compatibility policy is unavailable',
    )
    const historical = source.source.historicalQuickIds,
        retiredIds = source.retiredIds
    valid(
        sortedIds(historical) &&
            historical.length > 0 &&
            sortedIds(retiredIds) &&
            retiredIds.every((id) => historical.includes(id)) &&
            digest(historical) === source.source.historicalQuickIdsSha256 &&
            [
                source.source.historicalItemsSha256,
                source.source.historicalSourceSha256,
                source.source.historicalItemIdsSha256,
                source.target.currentItemIdsSha256,
                source.target.currentItemsSha256,
            ].every((hash) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)),
        'Historical item-shortcut identities are malformed',
    )
    valid(
        Array.isArray(items) &&
            items.length > 0 &&
            items.every((row) => object(row) && positive(row.id)) &&
            new Set(items.map((row) => row.id)).size === items.length,
        'Current item-shortcut identity catalogue is malformed',
    )
    const current = new Set(items.map((row) => row.id)),
        historicalSet = new Set(historical),
        retiredSet = new Set(retiredIds),
        currentHash = digest([...current].sort((a, b) => a - b))
    let verified = false
    const retired = (id) => {
        // A current row always wins. Historical flags never grant current
        // execution/quickbar eligibility, including after an ID is reused.
        if (current.has(id) || !historicalSet.has(id)) return false
        if (!verified) {
            valid(
                currentHash === source.target.currentItemIdsSha256 &&
                    historical.filter((key) => !current.has(key)).length === retiredIds.length &&
                    historical.every((key) => current.has(key) || retiredSet.has(key)),
                'Retired shortcuts require the verified complete current catalogue',
            )
            verified = true
        }
        return retiredSet.has(id)
    }
    const validate = (state) => {
        const archive = state.itemShortcutCompatibility
        if (archive === undefined) return undefined
        valid(
            object(archive) &&
                archive.version === 1 &&
                archive.policyId === source.policyId &&
                archive.origin === 'LOCAL' &&
                archive.historicalItemsSha256 === source.source.historicalItemsSha256 &&
                Array.isArray(archive.entries) &&
                archive.entries.length <= 6 * historical.length,
            'Saved item-shortcut compatibility archive is malformed',
        )
        const seen = new Set()
        for (const entry of archive.entries) {
            const key = `${entry?.slot_id}:${entry?.item_id}`
            valid(
                object(entry) &&
                    slot(entry.slot_id) &&
                    historicalSet.has(entry.item_id) &&
                    object(entry.original) &&
                    entry.original.slot_id === entry.slot_id &&
                    entry.original.item_id === entry.item_id &&
                    !seen.has(key),
                'Saved retired shortcut reference is malformed',
            )
            seen.add(key)
        }
        return archive
    }
    const remember = (state, rows) => {
        const previous = validate(state)
        valid(
            Array.isArray(rows) &&
                rows.length <= 6 &&
                rows.every((row) => object(row) && slot(row.slot_id) && positive(row.item_id)) &&
                new Set(rows.map((row) => row.slot_id)).size === rows.length,
            'Stored item-shortcut layout is malformed',
        )
        const additions = rows.filter(
            (row) =>
                retired(row.item_id) &&
                !previous?.entries.some((entry) => entry.slot_id === row.slot_id && entry.item_id === row.item_id),
        )
        if (!additions.length) return false
        state.itemShortcutCompatibility = {
            version: 1,
            policyId: source.policyId,
            origin: 'LOCAL',
            historicalItemsSha256: source.source.historicalItemsSha256,
            entries: [
                ...(previous?.entries ?? []),
                ...additions.map((row) => ({
                    slot_id: row.slot_id,
                    item_id: row.item_id,
                    original: structuredClone(row),
                })),
            ],
        }
        return true
    }
    return { retired, validate, remember }
}
