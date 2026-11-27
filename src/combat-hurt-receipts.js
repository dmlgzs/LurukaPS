import { createHash } from 'node:crypto'
import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'

const validIndex = (value) => Number.isInteger(value) && value > 0 && value <= 2147483647

export function validateDamageReceipt(prior) {
    ensure(
        prior &&
            typeof prior === 'object' &&
            !Array.isArray(prior) &&
            Array.isArray(prior.ranges) &&
            Array.isArray(prior.order) &&
            prior.order.length <= 512 &&
            prior.recent &&
            typeof prior.recent === 'object' &&
            !Array.isArray(prior.recent) &&
            prior.ranges.every(
                (range, i) =>
                    Array.isArray(range) &&
                    range.length === 2 &&
                    validIndex(range[0]) &&
                    validIndex(range[1]) &&
                    range[0] <= range[1] &&
                    (i === 0 || prior.ranges[i - 1][1] + 1 < range[0]),
            ),
        'Stored combat damage receipts are malformed',
        ErrorCode.GameConfig,
    )
    return prior
}

// Current DamageService.AddDamageData allocates one counter for the entire
// client process. Keep all accepted ranges; the bounded recent payloads only
// diagnose conflicts and must never become the duplicate-retention window.
// Call after actor/activation admission, and only for an HP event being applied.
export function damageReceipt(previous, hurt) {
    const index = hurt.dmg_inc_id ?? 0
    if (index === 0) return { duplicate: false, receipt: previous }
    ensure(validIndex(index), 'Invalid combat damage index')
    const prior = previous ?? { ranges: [], recent: {}, order: [] }
    validateDamageReceipt(prior)
    const fingerprint = JSON.stringify([
        hurt.from_id,
        hurt.tar_id,
        hurt.skill_id ?? 0,
        hurt.hp_change ?? null,
        hurt.element_uniqueId ?? '0',
        hurt.element_tempId ?? 0,
        hurt.from_sp ?? null,
        hurt.tar_sp ?? null,
        hurt.delta_sp ?? null,
    ])
    let lo = 0,
        hi = prior.ranges.length
    while (lo < hi) {
        const mid = (lo + hi) >>> 1
        if (prior.ranges[mid][1] < index) lo = mid + 1
        else hi = mid
    }
    if (prior.ranges[lo]?.[0] <= index) {
        ensure(
            prior.recent[index] === undefined || prior.recent[index] === fingerprint,
            'Conflicting combat damage index',
        )
        return { duplicate: true, receipt: prior }
    }
    const ranges = prior.ranges.slice(),
        left = lo > 0 && ranges[lo - 1][1] + 1 === index,
        right = ranges[lo]?.[0] === index + 1
    if (left && right) ranges.splice(lo - 1, 2, [ranges[lo - 1][0], ranges[lo][1]])
    else if (left) ranges[lo - 1] = [ranges[lo - 1][0], index]
    else if (right) ranges[lo] = [index, ranges[lo][1]]
    else ranges.splice(lo, 0, [index, index])
    const recent = { ...prior.recent, [index]: fingerprint },
        order = [...prior.order, index]
    if (order.length > 512) delete recent[order.shift()]
    return { duplicate: false, receipt: { ranges, recent, order } }
}

export function combatHurtIsDuplicate(c, hurt) {
    if ((hurt.dmg_inc_id ?? 0) === 0) return false
    ensure(
        typeof c.combatSessionId === 'string' && c.combatSessionId.length > 0,
        'Sequenced combat report has no admitted connection',
        ErrorCode.GameConfig,
    )
    const battle = c.state.combat,
        scope = createHash('sha256').update(c.combatSessionId).digest('hex'),
        saved = battle.hurt_receipts,
        prior = saved?.scope === scope ? saved.receipt : undefined,
        result = damageReceipt(prior, hurt)
    // Copy-on-write is required by deferred Store combat transactions. A later
    // invalid row/encoding failure must not consume an index in the base save.
    if (result.receipt !== prior) battle.hurt_receipts = { scope, receipt: result.receipt }
    return result.duplicate
}
