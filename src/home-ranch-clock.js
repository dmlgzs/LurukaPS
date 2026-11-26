import policy from '../configs/home-production-clock-migration-policy.json' with { type: 'json' }
import { homeClockPolicyId } from './home-production-clock.js'
import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'

const positive = (value) => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff
const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
const identity = (row) => ({ type: row.itemType, ids: String(row.itemId).split('|').map(Number) })
const validIdentity = (row) =>
    object(row) && row.type === 3 && Array.isArray(row.ids) && row.ids.length === 1 && row.ids.every(positive)
const sameAsset = (a, b) => validIdentity(a) && validIdentity(b) && a.type === b.type && a.ids[0] === b.ids[0]
const spec = (row) =>
    JSON.stringify(
        Object.fromEntries(
            Object.keys(row)
                .filter((key) => key !== 'id' && key !== '_note')
                .sort()
                .map((key) => [key, row[key]]),
        ),
    )
ensure(
    object(policy.legacyRanchProfiles) &&
        object(policy.legacyRanchAssets) &&
        Object.entries(policy.legacyRanchProfiles).every(
            ([id, values]) =>
                positive(Number(id)) &&
                Array.isArray(values) &&
                values.length &&
                values.every(positive) &&
                new Set(values).size === values.length,
        ) &&
        Object.entries(policy.legacyRanchAssets).every(([id, value]) => positive(Number(id)) && validIdentity(value)),
    'Malformed historical ranch identity evidence',
    ErrorCode.GameConfig,
)

function validateClock(clock) {
    ensure(
        object(clock) &&
            positive(clock.drop_id) &&
            positive(clock.time) &&
            positive(clock.seconds) &&
            clock.pending === undefined,
        'Malformed saved ranch production clock',
        ErrorCode.GameConfig,
    )
}
export function validateRanchSlotClocks(slot) {
    ensure(object(slot) && Array.isArray(slot.drop_times), 'Malformed ranch clock list', ErrorCode.GameConfig)
    slot.drop_times.forEach(validateClock)
    ensure(
        new Set(slot.drop_times.map((clock) => clock.drop_id)).size === slot.drop_times.length,
        'Duplicate ranch production clock',
        ErrorCode.GameConfig,
    )
}
function receipt(now, source, configId) {
    return { version: 1, policyId: homeClockPolicyId, source, profileId: configId, cutoverAt: now, archive: [] }
}
export function markCurrentRanchSlot(slot, rows, now, configId) {
    ensure(
        Array.isArray(slot.drop_times) && positive(now) && positive(configId),
        'Malformed new ranch clock input',
        ErrorCode.GameConfig,
    )
    for (const clock of slot.drop_times) {
        validateClock(clock)
        const row = rows.find((row) => row.id === clock.drop_id)
        ensure(row, 'New ranch clock has no current recipe', ErrorCode.GameConfig)
        clock.assetIdentity = identity(row)
    }
    slot.clockMigration = receipt(now, 'current', configId)
    return slot
}
function clockFor(row, now, seconds, fraction = 1) {
    const time = now + Math.max(1, Math.ceil(fraction * seconds))
    ensure(positive(seconds) && positive(time), 'Ranch migration clock overflow', ErrorCode.InvalidLogic)
    return { drop_id: row.id, time, seconds, assetIdentity: identity(row) }
}

// LOCAL approved once-only cutover, before settlement/RNG. No floor output,
// bonus, stock, claimed receipt or allocator is read or changed by this leaf.
export function prepareRanchSlotClocks(tables, pet, slot, rows, now, duration) {
    validateRanchSlotClocks(slot)
    ensure(positive(now) && positive(pet.config_id), 'Malformed ranch clock migration input', ErrorCode.GameConfig)
    const meta = slot.clockMigration
    if (meta !== undefined) {
        ensure(
            object(meta) &&
                meta.version === 1 &&
                meta.policyId === homeClockPolicyId &&
                ['current', 'legacy-cutover'].includes(meta.source) &&
                positive(meta.cutoverAt) &&
                meta.profileId === pet.config_id &&
                Array.isArray(meta.archive),
            'Malformed ranch clock migration receipt',
            ErrorCode.GameConfig,
        )
        for (const clock of slot.drop_times) {
            const row = rows.find((row) => row.id === clock.drop_id)
            ensure(
                row && sameAsset(clock.assetIdentity, identity(row)),
                'Current ranch clock has no matching recipe',
                ErrorCode.GameConfig,
            )
        }
        let updated = false
        for (const row of rows)
            if (!slot.drop_times.some((clock) => clock.drop_id === row.id)) {
                slot.drop_times.push(clockFor(row, now, duration(row)))
                updated = true
            }
        return updated
    }
    const membership = policy.legacyRanchProfiles[pet.config_id] ?? [],
        decisions = slot.drop_times.map((clock) => {
            const proof = membership.includes(clock.drop_id) ? policy.legacyRanchAssets[clock.drop_id] : undefined,
                direct = rows.find((row) => row.id === clock.drop_id && sameAsset(proof, identity(row)))
            if (direct) return { clock, target: direct }
            const prior = tables.find('home_drop', clock.drop_id)
            // Compare the complete CURRENT definition, not historical rates/periods,
            // and verify both its old typed identity and current effective period.
            const candidates =
                prior && sameAsset(proof, identity(prior))
                    ? rows.filter(
                          (row) =>
                              sameAsset(proof, identity(row)) &&
                              spec(row) === spec(prior) &&
                              duration(row) === duration(prior),
                      )
                    : []
            return {
                clock,
                target: candidates.length === 1 ? candidates[0] : undefined,
                ambiguous: candidates.length > 1,
            }
        }),
        counts = new Map()
    for (const { clock, target } of decisions)
        if (target && clock.time > now) counts.set(target.id, (counts.get(target.id) ?? 0) + 1)
    const next = [],
        record = receipt(now, 'legacy-cutover', pet.config_id)
    for (const { clock, target, ambiguous } of decisions) {
        const adopt = clock.time > now && target && counts.get(target.id) === 1
        const reason =
            clock.time <= now
                ? 'overdue-no-backpay'
                : adopt
                  ? 'future-proportional'
                  : ambiguous || (target && counts.get(target.id) > 1)
                    ? 'ambiguous-current-equivalent'
                    : 'unmatched-restart-current'
        record.archive.push({
            original: structuredClone(clock),
            reason,
            at: now,
            ...(target ? { targetDropId: target.id } : {}),
        })
        if (adopt) next.push(clockFor(target, now, duration(target), (clock.time - now) / clock.seconds))
    }
    for (const row of rows)
        if (!next.some((clock) => clock.drop_id === row.id)) next.push(clockFor(row, now, duration(row)))
    slot.drop_times = next
    slot.clockMigration = record
    return true
}
