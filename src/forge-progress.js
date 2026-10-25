import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { productionTables } from './production-tables.js'
import { accessoryProductionChoices } from './accessory-production.js'
import policy from '../configs/forge-progress-policy.json' with { type: 'json' }

const uint = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
const positive = (value) => uint(value) && value > 0
const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
const warned = new WeakMap()
const poolCaches = new WeakMap()
ensure(
    policy.version === 1 &&
        policy.namespace === 'accessory_product' &&
        policy.catalogue === 'CBT3-2451868-accessory-v1' &&
        typeof policy.directedOnly === 'boolean' &&
        policy.unit === 'successfully-claimed-items' &&
        policy.creditOn === 'successful-output-claim' &&
        policy.officiallyVerified === false &&
        Array.isArray(policy.legacyRecipes),
    'Invalid forge progress policy',
    ErrorCode.GameConfig,
)
const recipes = new Map()
for (const row of policy.legacyRecipes) {
    ensure(
        object(row) &&
            positive(row.productId) &&
            positive(row.difficulty) &&
            positive(row.dropId) &&
            positive(row.group) &&
            !recipes.has(row.productId),
        'Invalid forge progress recipe registry',
        ErrorCode.GameConfig,
    )
    recipes.set(row.productId, row)
}
const difficulties = new Set([...recipes.values()].map((row) => row.difficulty))

function warnOnce(external, state, namespace, productId, reason) {
    const tables = productionTables(external)
    let keys = warned.get(tables)
    if (!keys) warned.set(tables, (keys = new Set()))
    const accountId = state.player?.basic_info?.id ?? 0
    const key = accountId + ':' + String(namespace) + ':' + String(productId)
    if (keys.has(key)) return
    keys.add(key)
    console.warn(
        '[forge-progress]',
        JSON.stringify({
            event: 'unclassified-source',
            accountId,
            namespace,
            productId,
            reason,
            action: 'award-preserved-no-progress',
        }),
    )
}
const matchesRecipe = (current, saved) =>
    current &&
    current.id === saved.productId &&
    current.difficulty === saved.difficulty &&
    current.dropId === saved.dropId &&
    String(current.group) === String(saved.group)
function outputRow(job) {
    const rows = job.rewards
    return Array.isArray(rows) &&
        rows.length === 1 &&
        rows[0]?.itemtype === 33 &&
        positive(rows[0].itemid) &&
        positive(rows[0].itemnum)
        ? rows[0]
        : null
}
function designation(job) {
    const target = job.designatedItemId ?? 0
    return uint(target) ? target : null
}
export function sealForgeProgressSource(tables, state, recipe, target, rewards) {
    const row = recipes.get(recipe.id),
        output = outputRow({ rewards })
    if (!row || !matchesRecipe(recipe, row) || !uint(target) || !output || (target && output.itemid !== target)) {
        warnOnce(tables, state, policy.namespace, recipe.id, 'unmapped-accept-source')
        return { version: 0, namespace: policy.namespace, productId: recipe.id }
    }
    return {
        version: 1,
        catalogue: policy.catalogue,
        namespace: policy.namespace,
        productId: recipe.id,
        difficulty: recipe.difficulty,
        isDirected: target > 0,
        outputItemId: output.itemid,
        outputItemNum: output.itemnum,
    }
}
function classifiedSource(external, state, job) {
    const tables = productionTables(external),
        source = job.forgeProgressSource
    if (job.kind !== 'accessory' && source === undefined) return null
    const output = outputRow(job),
        target = designation(job),
        row = recipes.get(job.productId)
    const fail = (reason) => {
        warnOnce(tables, state, source?.namespace ?? policy.namespace, source?.productId ?? job.productId, reason)
        return null
    }
    if (job.kind !== 'accessory' || !row || !output || target === null || (target > 0 && output.itemid !== target))
        return fail('unmapped-job-source')
    if (source !== undefined) {
        if (
            !object(source) ||
            source.version !== 1 ||
            source.catalogue !== policy.catalogue ||
            source.namespace !== policy.namespace ||
            source.productId !== job.productId ||
            source.difficulty !== row.difficulty ||
            typeof source.isDirected !== 'boolean' ||
            source.isDirected !== target > 0 ||
            source.outputItemId !== output.itemid ||
            source.outputItemNum !== output.itemnum
        )
            return fail('unknown-or-inconsistent-sealed-source')
        return source
    }
    //0035 already sealed actual rewards and designation per accessory job. Its
    //17 complete recipe rows match this registry; original paid costs may be
    //discounted and are deliberately neither reconstructed nor compared here.
    if (!matchesRecipe(tables.find('accessory_product', job.productId), row))
        return fail('legacy-recipe-not-in-stable-registry')
    let pools = poolCaches.get(tables)
    if (!pools) poolCaches.set(tables, (pools = new Map()))
    try {
        if (!pools.has(row.productId)) pools.set(row.productId, accessoryProductionChoices(tables, row.dropId).leaves)
        if (!pools.get(row.productId).has(output.itemid)) return fail('legacy-output-not-in-known-pool')
    } catch {
        return fail('legacy-progress-pool-unavailable')
    }
    return {
        version: 1,
        catalogue: policy.catalogue,
        namespace: policy.namespace,
        productId: row.productId,
        difficulty: row.difficulty,
        isDirected: target > 0,
        outputItemId: output.itemid,
        outputItemNum: output.itemnum,
    }
}
function history(state) {
    const ledger = state.home?.forgeProgress
    if (ledger === undefined) return { version: 1, revision: 0, counts: {} }
    ensure(
        object(ledger) && ledger.version === 1 && uint(ledger.revision) && object(ledger.counts),
        'Malformed forge progress ledger',
        ErrorCode.GameConfig,
    )
    for (const [key, count] of Object.entries(ledger.counts)) {
        const [namespace, id, difficulty, directed, ...rest] = key.split(':')
        const numbers = [id, difficulty, directed].map(Number)
        ensure(
            !rest.length &&
                /^[a-z][a-z0-9_]*$/.test(namespace) &&
                positive(numbers[0]) &&
                positive(numbers[1]) &&
                [0, 1].includes(numbers[2]) &&
                namespace + ':' + numbers.join(':') === key &&
                uint(count),
            'Malformed forge progress counter',
            ErrorCode.GameConfig,
        )
    }
    return ledger
}
//Called after successful grantRewards and before job.claimed/deletion in the
//same existing transaction. Unknown provenance never replaces/refuses awards.
export function recordForgeProgressClaim(tables, state, job, output) {
    const source = classifiedSource(tables, state, job)
    if (!source) return false
    const quantity = output
        .filter((row) => row.itemtype === 33 && row.itemid === source.outputItemId)
        .reduce((n, row) => n + row.itemnum, 0)
    ensure(positive(quantity), 'Invalid forge claimed quantity', ErrorCode.GameConfig)
    const previous = history(state),
        counts = { ...previous.counts }
    const key = [source.namespace, source.productId, source.difficulty, source.isDirected ? 1 : 0].join(':')
    const next = (counts[key] ?? 0) + quantity,
        revision = previous.revision + 1
    ensure(uint(next) && uint(revision), 'Forge progress counter overflow', ErrorCode.GameConfig)
    counts[key] = next
    state.home.forgeProgress = { version: 1, revision, counts }
    return true
}
export function forgeProgressRevision(state) {
    return history(state).revision
}
export function forgeProgressRule(tables, tokens) {
    return (
        Array.isArray(tokens) &&
        tokens.length === 3 &&
        tokens[0] === 15072 &&
        tokens.every(uint) &&
        tokens[2] > 0 &&
        (tokens[1] === 0 || difficulties.has(tokens[1]))
    )
}
export function forgeProgressValue(tables, state, tokens, facts = new Map()) {
    if (!forgeProgressRule(tables, tokens)) return null
    const key = 'forge-progress:' + tokens[1] + ':' + policy.directedOnly
    if (facts.has(key)) return facts.get(key)
    const ledger = facts.get('forge-progress:history') ?? history(state)
    facts.set('forge-progress:history', ledger)
    let total = 0,
        classifiedTotal = 0
    for (const [selector, count] of Object.entries(ledger.counts)) {
        const [namespace, id, difficulty, directed] = selector.split(':')
        const recipe = recipes.get(Number(id))
        if (namespace !== policy.namespace || !recipe || recipe.difficulty !== Number(difficulty)) {
            warnOnce(tables, state, namespace, Number(id), 'unmapped-typed-history')
            continue
        }
        classifiedTotal += count
        if ((!policy.directedOnly || directed === '1') && (tokens[1] === 0 || Number(difficulty) === tokens[1]))
            total += count
    }
    const untypedTotal = Object.entries(state.home?.productionProgress?.counts ?? {})
        .filter(([key, value]) => key.startsWith('8:33:') && Number.isSafeInteger(value) && value > 0)
        .reduce((sum, [, value]) => sum + value, 0)
    if (untypedTotal > classifiedTotal)
        warnOnce(tables, state, 'untyped-history', 0, 'old-mixed-output-history-not-reconstructed')
    ensure(
        Number.isSafeInteger(total) && total >= 0 && total <= 0xffffffff,
        'Forge progress total overflow',
        ErrorCode.GameConfig,
    )
    facts.set(key, total)
    return total
}
