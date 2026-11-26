import policy from '../configs/home-production-clock-migration-policy.json' with { type: 'json' }
import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'
import { collectionDropIds } from './collection-drop.js'

const positive = (value) => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff
const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
const uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
const validIdentity = (value) =>
    object(value) &&
    [3, 10, 14].includes(value.type) &&
    Array.isArray(value.ids) &&
    value.ids.length > 0 &&
    value.ids.every(positive) &&
    new Set(value.ids).size === value.ids.length &&
    (value.type !== 14 ||
        (object(value.eggConstraints) && uint(value.eggConstraints.element_type) && uint(value.eggConstraints.race)))
ensure(
    policy.schemaVersion === 1 &&
        policy.origin === 'LOCAL' &&
        policy.userApproved === true &&
        policy.migrationOnly === true &&
        policy.targetVersion === '1.0.0' &&
        policy.packageVersion === '3217420' &&
        object(policy.legacyCollectionAssets) &&
        policy.rules.overdue === 'archive-no-backpay-restart-now' &&
        policy.rules.future === 'proven-asset-progress-fraction' &&
        policy.rules.unmatched === 'archive-restart-current-now' &&
        policy.rules.sealed === 'preserve-original-item-and-quantity',
    'Invalid home production migration policy',
    ErrorCode.GameConfig,
)
ensure(
    Array.isArray(policy.knownRetiredHomeTalents) &&
        policy.knownRetiredHomeTalents.every(positive) &&
        Object.entries(policy.legacyCollectionAssets).every(
            ([id, value]) => /^\d+$/.test(id) && positive(Number(id)) && validIdentity(value),
        ),
    'Malformed migration identity evidence',
    ErrorCode.GameConfig,
)
export const homeClockPolicyId = policy.policyId
const identity = (stream) => ({
    type: stream.drop.itemType,
    ids: [...stream.itemIds],
    ...(stream.drop.itemType === 14
        ? { eggConstraints: { element_type: stream.drop.elementTypeId ?? 0, race: stream.drop.raceId ?? 0 } }
        : {}),
})
const sameIdentity = (a, b) =>
    object(a) &&
    object(b) &&
    a.type === b.type &&
    Array.isArray(a.ids) &&
    Array.isArray(b.ids) &&
    a.ids.length === b.ids.length &&
    a.ids.every((id, index) => id === b.ids[index]) &&
    (a.type !== 14 ||
        (a.eggConstraints?.element_type === b.eggConstraints?.element_type &&
            a.eggConstraints?.race === b.eggConstraints?.race))
const archive = (ledger, clock, reason, now) =>
    ledger.archive.push({ original: structuredClone(clock), reason, at: now })
export function compileCollectionMigrationAliases(rows) {
    ensure(Array.isArray(rows), 'Malformed collection migration aliases', ErrorCode.GameConfig)
    const result = new Map(),
        targets = new Set()
    for (const row of rows) {
        ensure(
            object(row) &&
                [row.stationId, row.sourceProduct, row.targetProduct].every(positive) &&
                row.sourceProduct !== row.targetProduct &&
                validIdentity(row.identity) &&
                sameIdentity(row.identity, policy.legacyCollectionAssets[row.sourceProduct]),
            'Malformed collection migration correspondence',
            ErrorCode.GameConfig,
        )
        const source = row.stationId + ':' + row.sourceProduct,
            target = row.stationId + ':' + row.targetProduct
        ensure(
            !result.has(source) && !targets.has(target),
            'Ambiguous collection migration correspondence',
            ErrorCode.GameConfig,
        )
        result.set(source, row)
        targets.add(target)
    }
    return result
}
const collectionAliases = compileCollectionMigrationAliases(policy.legacyCollectionAliases)
function aliasStream(stationId, sourceProduct, proof, streams) {
    const alias = collectionAliases.get(stationId + ':' + sourceProduct)
    if (!alias) return undefined
    const stream = streams.find((row) => row.product === alias.targetProduct)
    ensure(
        stream && sameIdentity(alias.identity, identity(stream)) && sameIdentity(alias.identity, proof),
        'Current collection migration target differs from proven correspondence',
        ErrorCode.GameConfig,
    )
    return stream
}
function ledger(job, now, source) {
    return {
        version: 1,
        policyId: homeClockPolicyId,
        source,
        cutoverAt: now,
        archive: [],
        sealedPending: [],
        stockSeals: [],
        unidentified: [],
        nextPendingId: 1,
    }
}
export function markCurrentCollectionJob(job, now) {
    job.clockMigration = ledger(job, now, 'current')
    return job
}
function validateClock(clock) {
    ensure(
        object(clock) &&
            positive(clock.product) &&
            Number.isFinite(clock.seconds) &&
            clock.seconds > 0 &&
            Number.isFinite(clock.next) &&
            clock.next > 0 &&
            (clock.remaining === undefined || (Number.isFinite(clock.remaining) && clock.remaining >= 0)),
        'Malformed saved collection clock',
        ErrorCode.GameConfig,
    )
    if (clock.pending !== undefined)
        ensure(
            (Number.isSafeInteger(clock.pending) && clock.pending >= 0 && clock.pending <= 0xffffffff) ||
                (object(clock.pending) &&
                    positive(clock.pending.item_id) &&
                    [3, 10, 14].includes(clock.pending.item_type) &&
                    Number.isSafeInteger(clock.pending.item_num) &&
                    clock.pending.item_num >= 0 &&
                    clock.pending.item_num <= 0xffffffff),
            'Malformed sealed collection pending output',
            ErrorCode.GameConfig,
        )
}
function pendingIdentity(clock, proof) {
    if (clock.pending === undefined) return undefined
    if (typeof clock.pending === 'object') return structuredClone(clock.pending)
    if (object(proof) && Array.isArray(proof.ids) && proof.ids.length === 1)
        return { item_type: proof.type, item_id: proof.ids[0], item_num: clock.pending }
}
function currentAsset(tables, value) {
    return (
        value &&
        tables.find(
            value.item_type === 3 ? 'common_item' : value.item_type === 10 ? 'currency' : 'pet_egg',
            value.item_id,
        )
    )
}
function matchingEggDrop(tables, productId, proof, item) {
    if (proof?.type !== 14 || !validIdentity(proof)) return undefined
    const product = tables.find('products_collection', productId),
        drop = product && tables.find('home_drop', product.homeDropId)
    if (!drop || drop.itemType !== 14) return undefined
    const actual = identity({ drop, itemIds: collectionDropIds(tables, drop) })
    return sameIdentity(proof, actual) && proof.ids.includes(item.item_id) ? drop : undefined
}
export function detachedCollectionDrop(tables, entry) {
    if (entry.item.item_type !== 14) return undefined
    const drop = matchingEggDrop(tables, entry.currentProduct ?? entry.original.product, entry.eggIdentity, entry.item)
    ensure(drop, 'Sealed collection egg identity differs from current recipe', ErrorCode.GameConfig)
    return drop
}
function retainDetachedPending(tables, meta, clock, pending, now, proof, currentProduct = clock.product) {
    const egg = pending?.item_type === 14 && matchingEggDrop(tables, currentProduct, proof, pending)
    if (pending && ([3, 10].includes(pending.item_type) || egg) && currentAsset(tables, pending)) {
        ensure(meta.nextPendingId < 0xffffffff, 'Collection pending identity exhausted', ErrorCode.InvalidLogic)
        meta.sealedPending.push({
            id: meta.nextPendingId++,
            original: structuredClone(clock),
            item: pending,
            ...(egg ? { eggIdentity: structuredClone(proof) } : {}),
            ...(currentProduct !== clock.product ? { currentProduct } : {}),
            claimed: pending.item_num === 0,
        })
    } else
        meta.unidentified.push({ original: structuredClone(clock), reason: 'pending-item-identity-unproven', at: now })
}

// Writable transactions only, before any due generation or retime replacement.
// Historical identities validate ownership; all new production uses current plan streams.
export function prepareCollectionClocks(tables, job, streams, now, stock = [], stationId) {
    ensure(
        object(job) && Array.isArray(job.clocks) && typeof job.blocked === 'boolean' && positive(now),
        'Malformed collection job migration input',
        ErrorCode.GameConfig,
    )
    ensure(
        new Set(job.clocks.map((clock) => clock.product)).size === job.clocks.length,
        'Duplicate saved collection clock',
        ErrorCode.GameConfig,
    )
    job.clocks.forEach(validateClock)
    const current = new Map(streams.map((stream) => [stream.product, stream]))
    let meta = job.clockMigration
    const legacy = meta === undefined
    if (legacy) {
        meta = ledger(job, now, 'legacy-cutover')
        ensure(Array.isArray(stock), 'Malformed saved collection stock', ErrorCode.GameConfig)
        for (const item of [...stock]) {
            ensure(
                object(item) &&
                    positive(item.source_product_id) &&
                    positive(item.item_id) &&
                    [3, 10, 14].includes(item.item_type) &&
                    positive(item.item_num),
                'Malformed saved collection stock',
                ErrorCode.GameConfig,
            )
            const proof = policy.legacyCollectionAssets[item.source_product_id]
            const alias = aliasStream(stationId, item.source_product_id, proof, streams)
            if (item.item_type === 14 && alias) {
                retainDetachedPending(
                    tables,
                    meta,
                    { product: item.source_product_id, sealedStock: structuredClone(item) },
                    item,
                    now,
                    proof,
                    alias.product,
                )
                stock.splice(stock.indexOf(item), 1)
                continue
            }
            if (
                proof?.type === item.item_type &&
                proof.ids.includes(item.item_id) &&
                [3, 10].includes(item.item_type) &&
                currentAsset(tables, item)
            )
                meta.stockSeals.push({ item: structuredClone(item), claimed: false })
            else if (!(item.item_type === 14 && matchingEggDrop(tables, item.source_product_id, proof, item))) {
                // An old egg stock entry seals a count, not its as-yet unrolled pet/constraints.
                // Preserve it separately instead of rolling the current egg recipe or blocking other stock.
                meta.unidentified.push({
                    kind: 'stock',
                    original: structuredClone(item),
                    reason: item.item_type === 14 ? 'legacy-egg-constraints-unproven' : 'stock-asset-identity-unproven',
                    at: now,
                })
                stock.splice(stock.indexOf(item), 1)
            }
        }
    } else
        ensure(
            object(meta) &&
                meta.version === 1 &&
                meta.policyId === homeClockPolicyId &&
                ['current', 'legacy-cutover'].includes(meta.source) &&
                positive(meta.cutoverAt) &&
                Array.isArray(meta.archive) &&
                Array.isArray(meta.sealedPending) &&
                Array.isArray(meta.stockSeals) &&
                Array.isArray(meta.unidentified) &&
                positive(meta.nextPendingId),
            'Malformed collection migration receipt',
            ErrorCode.GameConfig,
        )
    let updated = legacy
    const kept = []
    for (const clock of job.clocks) {
        if (!legacy)
            ensure(
                validIdentity(clock.assetIdentity),
                'Malformed current collection asset identity',
                ErrorCode.GameConfig,
            )
        const proof = legacy ? policy.legacyCollectionAssets[clock.product] : clock.assetIdentity
        const direct = current.get(clock.product)
        const stream =
            legacy && (!direct || !sameIdentity(proof, identity(direct)))
                ? (aliasStream(stationId, clock.product, proof, streams) ?? direct)
                : direct
        const matches = !!stream && sameIdentity(proof, identity(stream))
        if (!legacy && matches) {
            kept.push(clock)
            continue
        }
        const pending = pendingIdentity(clock, proof)
        if (clock.pending !== undefined) {
            archive(meta, clock, 'sealed-pending-preserved', now)
            if (
                stream &&
                pending &&
                stream.product === clock.product &&
                (pending.item_type !== 14 || matches) &&
                pending.item_type === stream.drop.itemType &&
                stream.itemIds.includes(pending.item_id)
            ) {
                ensure(
                    !kept.some((row) => row.product === stream.product),
                    'Two saved collection clocks claim one current stream',
                    ErrorCode.GameConfig,
                )
                kept.push({
                    ...clock,
                    product: stream.product,
                    pending,
                    next: now,
                    seconds: stream.seconds,
                    ...(job.blocked || job.pet === '0' ? { remaining: 0 } : {}),
                    assetIdentity: identity(stream),
                })
            } else retainDetachedPending(tables, meta, clock, pending, now, proof, stream?.product ?? clock.product)
        } else {
            const fraction =
                (job.blocked || job.pet === '0') && clock.remaining !== undefined
                    ? clock.remaining
                    : (clock.next - now) / clock.seconds
            if (matches && fraction > 0) {
                archive(meta, clock, 'future-proportional', now)
                ensure(
                    !kept.some((row) => row.product === stream.product),
                    'Two saved collection clocks claim one current stream',
                    ErrorCode.GameConfig,
                )
                kept.push({
                    ...clock,
                    product: stream.product,
                    next: now + fraction * stream.seconds,
                    seconds: stream.seconds,
                    ...(job.blocked || job.pet === '0' ? { remaining: fraction } : {}),
                    assetIdentity: identity(stream),
                })
            } else archive(meta, clock, matches ? 'overdue-no-backpay' : 'unmatched-restart-current', now)
        }
        updated = true
    }
    for (const stream of streams)
        if (!kept.some((clock) => clock.product === stream.product)) {
            kept.push({
                product: stream.product,
                seconds: stream.seconds,
                next: now + stream.seconds,
                ...(job.blocked || job.pet === '0' ? { remaining: 1 } : {}),
                assetIdentity: identity(stream),
            })
            updated = true
        }
    if (updated) {
        job.clocks = kept
        job.clockMigration = meta
    }
    return updated
}

export function collectionStockSeal(tables, state, buildGuid, item) {
    const seals = state.home?.collectionProduction?.[buildGuid]?.clockMigration?.stockSeals ?? []
    ensure(Array.isArray(seals), 'Malformed collection stock seals', ErrorCode.GameConfig)
    const candidates = seals.filter((seal) => {
        ensure(
            object(seal) && object(seal.item) && typeof seal.claimed === 'boolean',
            'Malformed collection stock seal',
            ErrorCode.GameConfig,
        )
        return (
            !seal.claimed &&
            ['source_product_id', 'item_type', 'item_id', 'item_num'].every((key) => seal.item[key] === item[key])
        )
    })
    ensure(candidates.length <= 1, 'Ambiguous collection stock seal', ErrorCode.GameConfig)
    if (candidates.length)
        ensure(currentAsset(tables, item), 'Sealed collection asset is missing', ErrorCode.GameConfig)
    return candidates[0]
}

export function detachedCollectionPending(tables, state, buildGuid) {
    const meta = state.home?.collectionProduction?.[buildGuid]?.clockMigration
    if (!meta) return []
    ensure(
        meta.version === 1 && meta.policyId === homeClockPolicyId && Array.isArray(meta.sealedPending),
        'Malformed collection sealed output ledger',
        ErrorCode.GameConfig,
    )
    const seen = new Set()
    return meta.sealedPending.flatMap((entry) => {
        ensure(
            object(entry) &&
                positive(entry.id) &&
                !seen.has(entry.id) &&
                typeof entry.claimed === 'boolean' &&
                object(entry.item) &&
                [3, 10, 14].includes(entry.item.item_type) &&
                positive(entry.item.item_id) &&
                Number.isSafeInteger(entry.item.item_num) &&
                entry.item.item_num >= 0 &&
                entry.item.item_num <= 0xffffffff,
            'Malformed detached collection output',
            ErrorCode.GameConfig,
        )
        seen.add(entry.id)
        if (entry.claimed) return []
        ensure(
            currentAsset(tables, entry.item),
            'Detached collection asset definition is missing',
            ErrorCode.GameConfig,
        )
        detachedCollectionDrop(tables, entry)
        return [entry]
    })
}

const missingTalentWarnings = new Set()
const talentCatalogs = new WeakMap()
export function currentHomeTalentRows(tables, pet) {
    if (!pet) return []
    ensure(
        Array.isArray(pet.talent_id) &&
            pet.talent_id.every(positive) &&
            new Set(pet.talent_id).size === pet.talent_id.length,
        'Malformed saved home talent list',
        ErrorCode.GameConfig,
    )
    let rows = talentCatalogs.get(tables)
    if (!rows) {
        const source = tables.get('home_talent')
        ensure(
            Array.isArray(source) &&
                source.length > 0 &&
                source.every((row) => positive(row.talentId)) &&
                new Set(source.map((row) => row.talentId)).size === source.length,
            'Malformed home talent catalog',
            ErrorCode.GameConfig,
        )
        rows = new Map(source.map((row) => [row.talentId, row]))
        talentCatalogs.set(tables, rows)
    }
    return pet.talent_id.flatMap((id) => {
        const row = rows.get(id)
        if (row) return [row]
        ensure(policy.knownRetiredHomeTalents.includes(id), 'Missing collection worker talent', ErrorCode.GameConfig)
        if (!missingTalentWarnings.has(id)) {
            missingTalentWarnings.add(id)
            console.warn(
                '[home-talent]',
                JSON.stringify({ event: 'legacy-definition-has-no-current-effect', id, origin: 'LOCAL' }),
            )
        }
        return [] // Current Native TD GetData(row0) is explicitly skipped; owned raw IDs remain unchanged.
    })
}
