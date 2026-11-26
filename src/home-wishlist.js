import { preparedSystemAccess } from './system-access.js'
import { createHash } from 'node:crypto'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { productionMaterialRows } from './production-materials.js'
import { homeCondition } from './home-grid.js'
import { TaskGraphs } from './tasks.js'
import policy from '../configs/home-wishlist-identity-policy.json' with { type: 'json' }

const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const uint = (v) => Number.isSafeInteger(v) && v >= 0 && v <= 0xffffffff
const positive = (v) => uint(v) && v > 0
const digest = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
const valid = (v, message) => ensure(v, message, ErrorCode.GameConfig)
const retired = new Set(policy.source.retiredProductIds)
valid(
    policy.version === 1 &&
        policy.origin === 'LOCAL' &&
        policy.policyId === 'home-wishlist-uid-1.0.0-v1' &&
        policy.targetVersion === '1.0.0' &&
        policy.packageVersion === '3217420' &&
        digest(policy.source.retiredProductIds) === policy.source.retiredProductIdsSha256,
    'Wishlist migration policy is malformed',
)
const catalogs = new WeakMap()
const accessRules = new WeakMap()
export function requireHomeWishlistAccess(tables, state) {
    const prepared = preparedSystemAccess(tables, state, 1504)
    if (prepared !== undefined) {
        ensure(prepared, 'Wishlist system is locked', ErrorCode.SystemLock)
        return
    }

    let rule = accessRules.get(tables)
    if (rule === undefined) {
        const system = tables.find('system_unlock', 1504)
        valid(
            system && typeof system.unlockCondi === 'string' && system.unlockCondi.length > 0,
            'Wishlist system configuration is missing',
        )
        rule = system.unlockCondi
        for (const part of rule.split('|')) {
            const values = part.split('#').map(Number)
            ensure(
                values[0] === 12045,
                'Current wishlist unlock condition is not implemented',
                ErrorCode.FunctionClosed,
            )
            valid(
                values.length === 3 && values.slice(1).every(positive),
                'Wishlist task unlock parameters are malformed',
            )
            valid(
                tables.find('task', values[1]) && new TaskGraphs(tables).get(values[1]).nodes.has(values[2]),
                'Wishlist task unlock source is missing',
            )
        }
        accessRules.set(tables, rule)
    }
    // LOCAL server admission mirrors the configured current1504 UI gate.
    // Migration/read projection intentionally remain independent of access.
    ensure(homeCondition(rule, state), 'Wishlist system is locked', ErrorCode.SystemLock)
}
function catalog(tables) {
    if (catalogs.has(tables)) return catalogs.get(tables)
    const products = tables.get('products'),
        ids = products.map((r) => r.id)
    valid(ids.every(positive) && new Set(ids).size === ids.length, 'Current wishlist product directory is malformed')
    const quality = new Map()
    for (const row of tables.get('products_multi_quality')) {
        valid(positive(row.id) && typeof row.productId === 'string', 'Wishlist cooking output directory is malformed')
        for (const entry of row.productId.split('|')) {
            const values = entry.split('#').map(Number)
            valid(
                values.length === 2 &&
                    Number.isSafeInteger(values[0]) &&
                    positive(values[1]) &&
                    !quality.has(values[1]),
                'Wishlist cooking output identity is ambiguous',
            )
            quality.set(values[1], row)
        }
    }
    const result = {
        products: new Map(products.map((r) => [r.id, r])),
        quality,
        idsSha256: digest(ids.sort((a, b) => a - b)),
    }
    catalogs.set(tables, result)
    return result
}
function limit(tables) {
    const value = Number(tables.get('game').find((r) => r.title === 'HOME_WISHLIST_LIMIT')?.value)
    valid(positive(value), 'Current wishlist limit is malformed')
    return value
}
function inspectRow(row) {
    valid(
        object(row) &&
            positive(row.uid) &&
            positive(row.product_id) &&
            positive(row.count) &&
            (row.trace === undefined || typeof row.trace === 'boolean') &&
            (row.selects === undefined || (Array.isArray(row.selects) && row.selects.every(uint))),
        'Saved wishlist row is malformed',
    )
}
export function validateWishlistSelections(tables, product, selects = []) {
    ensure(
        Array.isArray(selects) && selects.every(uint),
        'Invalid wishlist material selection',
        ErrorCode.ProductSelectMaterialFail,
    )
    // Current WishItem.get_IsFoodType060068ff gates this route by groups.
    const food = String(product.group)
        .split('|')
        .map(Number)
        .some((id) => [9, 24, 14].includes(id))
    const quality = food ? catalog(tables).quality.get(product.id) : undefined
    if (!quality) {
        const groups = String(product.materialSelect ?? '')
            .split('|')
            .filter(Boolean)
        ensure(
            !(groups.length && (selects.length === 0 || (selects.length === groups.length && selects.includes(0)))),
            'Native unresolved wishlist material defaults are not enabled by this local migration policy',
            ErrorCode.FunctionClosed,
        )
        productionMaterialRows(tables, product, selects)
        return
    }
    const requirements = []
    // Current GetAllNeedMaterial060242eb preserves calculate then uncalculate order.
    for (const field of ['calculateNeedMaterial', 'uncalculateNeedMaterial']) {
        valid(typeof quality[field] === 'string', 'Wishlist food material requirements are malformed')
        for (const part of quality[field].split('|').filter(Boolean)) {
            const values = part.split('#').map(Number)
            valid(values.length === 2 && values.every(positive), 'Wishlist food material slot is malformed')
            const group = tables.find('food_material_group', values[0])
            valid(group && typeof group.includeItems === 'string', 'Wishlist food material group is missing')
            const allowed = group.includeItems.split('|').map((token) => {
                const pair = token.split('#').map(Number)
                valid(
                    pair.length === 2 && pair.every(positive) && tables.find('common_item', pair[0]),
                    'Wishlist food choice definition is malformed',
                )
                return pair[0]
            })
            requirements.push(new Set(allowed))
        }
    }
    ensure(
        !(
            requirements.length &&
            (selects.length === 0 || (selects.length === requirements.length && selects.includes(0)))
        ),
        'Native unresolved wishlist food defaults are not enabled by this local migration policy',
        ErrorCode.FunctionClosed,
    )
    ensure(
        selects.length === requirements.length && selects.every((id, i) => requirements[i].has(id)),
        'Wishlist food choice is outside its configured slot',
        ErrorCode.ProductSelectMaterialFail,
    )
}
function rowIssue(tables, row) {
    const product = catalog(tables).products.get(row.product_id)
    if (!product) return 'missing-current-product'
    valid(
        Number.isSafeInteger(product.wishlistLimit) && product.wishlistLimit >= 0,
        'Current wishlist quantity limit is malformed',
    )
    if (!product.wishlistLimit || row.count > product.wishlistLimit) return 'current-quantity-limit'
    try {
        validateWishlistSelections(tables, product, row.selects ?? [])
    } catch (error) {
        if (error.code === ErrorCode.ProductSelectMaterialFail) return 'invalid-current-selections'
        if (error.code === ErrorCode.FunctionClosed) return 'unresolved-native-default'
        throw error
    }
    return null
}
function inspectLedger(state) {
    const ledger = state.homeWishlistIdentity
    if (ledger === undefined) return undefined
    valid(
        object(ledger) && ledger.version === 1 && ledger.policyId === policy.policyId,
        'Wishlist identity component is malformed',
    )
    if (ledger.archive !== undefined) {
        const a = ledger.archive
        valid(
            object(a) &&
                Array.isArray(a.rows) &&
                object(a.nextWishUid) &&
                typeof a.nextWishUid.present === 'boolean' &&
                Array.isArray(a.reasons) &&
                Array.isArray(a.oldUids) &&
                a.oldUids.every(positive) &&
                new Set(a.oldUids).size === a.oldUids.length &&
                digest({ rows: a.rows, nextWishUid: a.nextWishUid }) === a.preimageSha256,
            'Original wishlist archive is damaged',
        )
        valid(
            digest({ preimageSha256: a.preimageSha256, reasons: a.reasons, oldUids: a.oldUids }) === a.metadataSha256,
            'Wishlist migration archive metadata is damaged',
        )
        a.rows.forEach(inspectRow)
        valid(
            a.reasons.every(
                (r) =>
                    object(r) &&
                    Number.isSafeInteger(r.index) &&
                    r.index >= 0 &&
                    r.index < a.rows.length &&
                    [
                        'uid-canonicalized',
                        'missing-current-product',
                        'duplicate-product',
                        'invalid-current-selections',
                        'current-quantity-limit',
                        'unresolved-native-default',
                    ].includes(r.reason),
            ),
            'Wishlist migration reason index is malformed',
        )
        const indices = a.reasons.map((r) => r.index)
        valid(new Set(indices).size === indices.length, 'Wishlist migration reason index is duplicated')
        valid(
            digest([...new Set(indices.map((i) => a.rows[i].uid))].sort((a, b) => a - b)) ===
                digest([...a.oldUids].sort((a, b) => a - b)),
            'Wishlist migration tombstones do not match archived identities',
        )
    }
    return ledger
}
function activeRows(tables, state) {
    valid(state.home === undefined || object(state.home), 'Wishlist home context is malformed')
    const rows = state.home?.wishlist ?? []
    valid(Array.isArray(rows), 'Wishlist storage is malformed')
    const ids = new Set()
    for (const row of rows) {
        inspectRow(row)
        valid(row.uid === row.product_id && !ids.has(row.uid), 'Current wishlist canonical identity is damaged')
        valid(!rowIssue(tables, row), 'Current wishlist row no longer matches its configuration')
        ids.add(row.uid)
    }
    valid(rows.length <= limit(tables), 'Current wishlist exceeds configured capacity')
    return rows
}
export function bootstrapHomeWishlistIdentity(tables, state) {
    if (inspectLedger(state)) {
        activeRows(tables, state)
        return { changed: false, migrated: 0, quarantined: 0 }
    }
    const rows = state.home?.wishlist ?? []
    valid(Array.isArray(rows) && rows.length <= limit(tables), 'Historical wishlist storage is malformed')
    const byProduct = new Map(),
        uids = new Set()
    for (const row of rows) {
        inspectRow(row)
        valid(
            catalog(tables).products.has(row.product_id) || retired.has(row.product_id),
            'Unknown missing historical wishlist product',
        )
        valid(!uids.has(row.uid), 'Historical wishlist UID is duplicated')
        uids.add(row.uid)
        if (!byProduct.has(row.product_id)) byProduct.set(row.product_id, [])
        byProduct.get(row.product_id).push(row)
    }
    const next = { present: Object.hasOwn(state.home ?? {}, 'nextWishUid') }
    if (next.present) next.value = structuredClone(state.home.nextWishUid)
    const active = [],
        reasons = [],
        oldUids = [],
        data = catalog(tables)
    let migrated = 0,
        quarantined = 0
    rows.forEach((row, index) => {
        if (row.uid !== row.product_id)
            valid(
                next.present && Number.isSafeInteger(next.value) && next.value > row.uid && next.value <= 0x100000000,
                'Historical wishlist allocation counter is not a valid source witness',
            )
        let reason = byProduct.get(row.product_id).length > 1 ? 'duplicate-product' : rowIssue(tables, row)
        if (reason === 'missing-current-product')
            valid(retired.has(row.product_id), 'Unknown missing historical wishlist product')
        if (reason) {
            quarantined++
            reasons.push({ index, reason })
            oldUids.push(row.uid)
            return
        }
        if (row.uid !== row.product_id) {
            migrated++
            reasons.push({ index, reason: 'uid-canonicalized' })
            oldUids.push(row.uid)
            active.push({ ...row, uid: row.product_id })
        } else active.push(row)
    })
    const ledger = { version: 1, policyId: policy.policyId }
    if (reasons.length) {
        valid(
            data.idsSha256 === policy.target.productIdsSha256,
            'Wishlist migration requires the verified current product identity catalog',
        )
        ledger.archive = {
            rows: structuredClone(rows),
            nextWishUid: next,
            preimageSha256: digest({ rows, nextWishUid: next }),
            reasons,
            oldUids: [...new Set(oldUids)],
        }
        ledger.archive.metadataSha256 = digest({
            preimageSha256: ledger.archive.preimageSha256,
            reasons: ledger.archive.reasons,
            oldUids: ledger.archive.oldUids,
        })
        state.home.wishlist = active
    }
    state.homeWishlistIdentity = ledger
    activeRows(tables, state)
    return { changed: true, migrated, quarantined }
}
export function homeWishlistPresentation(tables, state) {
    inspectLedger(state)
    const wishlist = activeRows(tables, state),
        live = new Set(wishlist.map((r) => r.uid))
    const del_wishlist = (state.homeWishlistIdentity?.archive?.oldUids ?? []).filter((id) => !live.has(id))
    return { wishlist, ...(del_wishlist.length ? { del_wishlist } : {}) }
}
export function upsertHomeWishlist(tables, state, request) {
    requireHomeWishlistAccess(tables, state)
    bootstrapHomeWishlistIdentity(tables, state)
    ensure(
        positive(request.uid) && request.uid === request.product_id,
        'Current wishlist UID must equal its product identity',
        ErrorCode.InvalidArgument,
    )
    const product = catalog(tables).products.get(request.product_id)
    ensure(product, 'Wishlist product configuration is missing', ErrorCode.HomeMaterialWishlistConfInvalid)
    ensure(positive(request.count), 'Invalid wishlist quantity', ErrorCode.InvalidArgument)
    valid(
        Number.isSafeInteger(product.wishlistLimit) && product.wishlistLimit >= 0,
        'Current wishlist quantity limit is malformed',
    )
    ensure(
        request.count <= product.wishlistLimit,
        'Wishlist product quantity limit reached',
        ErrorCode.HomeMaterialWishlistNumLimit,
    )
    ensure(
        request.trace === undefined || typeof request.trace === 'boolean',
        'Invalid wishlist trace flag',
        ErrorCode.InvalidArgument,
    )
    validateWishlistSelections(tables, product, request.selects ?? [])
    const rows = activeRows(tables, state),
        index = rows.findIndex((r) => r.uid === request.uid)
    ensure(index >= 0 || rows.length < limit(tables), 'Wishlist is full', ErrorCode.HomeMaterialWishlistNumLimit)
    const row = { ...request, uid: request.product_id }
    state.home.wishlist = index < 0 ? [...rows, row] : rows.map((value, i) => (i === index ? row : value))
    return row
}
export function deleteHomeWishlist(tables, state, uid) {
    requireHomeWishlistAccess(tables, state)
    bootstrapHomeWishlistIdentity(tables, state)
    ensure(
        positive(uid) && activeRows(tables, state).some((r) => r.uid === uid),
        'Wishlist entry is not owned',
        ErrorCode.HomeMaterialWishlistNotExsit,
    )
    state.home.wishlist = state.home.wishlist.filter((r) => r.uid !== uid)
}
export function traceHomeWishlist(tables, state, uid, trace) {
    requireHomeWishlistAccess(tables, state)
    bootstrapHomeWishlistIdentity(tables, state)
    const row = activeRows(tables, state).find((r) => r.uid === uid)
    ensure(positive(uid) && row, 'Wishlist entry is not owned', ErrorCode.HomeMaterialWishlistNotExsit)
    ensure(typeof trace === 'boolean', 'Invalid wishlist trace request', ErrorCode.InvalidArgument)
    state.home.wishlist = state.home.wishlist.map((r) => (r.uid === uid ? { ...r, trace } : r))
}
