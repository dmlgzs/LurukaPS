import { ensure } from './handlers/common.js'
import { ErrorCode } from './error-codes.js'
import policy from '../configs/farm-harvest-progress-policy.json' with { type: 'json' }

const uint = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff
const positive = (n) => uint(n) && n > 0
const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
const catalogues = new WeakMap(),
    warnings = new WeakMap()
const key = (row) => row.itemtype + ':' + row.itemid
const ids = (value) =>
    String(value ?? '')
        .split('|')
        .filter(Boolean)
        .map(Number)
function catalogue(tables) {
    if (catalogues.has(tables)) return catalogues.get(tables)
    ensure(
        policy.version === 1 &&
            policy.officiallyVerified === false &&
            policy.manualSelector === 'literal-home-building-group-type' &&
            policy.manualCountUnit === 'actually-granted-crop-product-items' &&
            policy.workerCreditOn === 'successful-storage-claim',
        'Invalid farm harvest progress policy',
        ErrorCode.GameConfig,
    )
    const plants = new Map(),
        products = new Set(),
        ignored = new Set(),
        fields = new Map(),
        fieldTypes = new Set()
    for (const row of tables.get('home_fieldtype')) {
        const build = tables.find('home_building', row.homeBuildingId),
            group = build && tables.get('home_building_group').find((r) => r.groupId === build.groupId)
        ensure(
            build && group && positive(group.type) && !fields.has(build.id),
            'Invalid farm harvest field classification',
            ErrorCode.GameConfig,
        )
        fields.set(build.id, group.type)
        fieldTypes.add(group.type)
    }
    const drops = (values) =>
        values.map((id) => {
            const matches = tables.get('home_drop').filter((row) => row.id === id),
                row = matches[0]
            ensure(
                positive(id) &&
                    matches.length === 1 &&
                    positive(row.itemType) &&
                    /^[1-9]\d*$/.test(String(row.itemId)) &&
                    positive(Number(row.itemId)),
                'Invalid farm harvest drop role',
                ErrorCode.GameConfig,
            )
            return row.itemType + ':' + Number(row.itemId)
        })
    for (const seed of tables.get('home_seeds').filter((row) => row.harvestType === 1)) {
        ensure(positive(seed.id) && !plants.has(seed.id), 'Duplicate annual crop classification', ErrorCode.GameConfig)
        const crop = new Set(
                drops(['homeDropId', 'harvestUpgrade', 'harvestSurprise'].flatMap((name) => ids(seed[name]))),
            ),
            nonCrop = new Set(drops(['homeDropSeedId', 'homeDropNextSeedId'].flatMap((name) => ids(seed[name]))))
        for (const name of ['homeDropId_exp', 'harvestSurprise_exp'])
            if (seed[name]) for (const value of drops([seed[name]])) nonCrop.add(value)
        ensure(
            crop.size > 0 && [...crop].every((value) => !nonCrop.has(value)),
            'Conflicting crop product and return roles',
            ErrorCode.GameConfig,
        )
        plants.set(seed.id, { products: crop, ignored: nonCrop })
        for (const value of crop) products.add(value)
        for (const value of nonCrop) ignored.add(value)
    }
    // Seeds remain non-products even when an old sealed outcome returned a
    // different known seed. This does not implement its planting lifecycle.
    for (const item of tables.get('common_item')) {
        if (item.type !== 310) continue
        ensure(positive(item.id), 'Invalid known seed identity', ErrorCode.GameConfig)
        ignored.add('3:' + item.id)
    }
    ensure(
        plants.size > 0 && fields.size > 0 && [...products].every((value) => !ignored.has(value)),
        'Ambiguous annual crop role mapping',
        ErrorCode.GameConfig,
    )
    const result = { plants, products, ignored, fields, fieldTypes }
    catalogues.set(tables, result)
    return result
}
function warnOnce(tables, state, source, seedId, item) {
    let seen = warnings.get(tables)
    if (!seen) warnings.set(tables, (seen = new Set()))
    const id = [state.player?.basic_info?.id ?? 0, source, seedId, item].join(':')
    if (seen.has(id)) return
    seen.add(id)
    console.warn(
        '[farm-harvest-progress]',
        JSON.stringify({
            event: 'unclassified-output',
            source,
            seedId,
            item,
            action: 'original-award-preserved-no-product-credit',
        }),
    )
}
function history(state) {
    const saved = state.home?.farmHarvestProgress
    if (saved === undefined) return { version: 1, revision: 0, roots: {}, counts: {} }
    ensure(
        object(saved) && saved.version === 1 && uint(saved.revision) && object(saved.roots) && object(saved.counts),
        'Malformed farm harvest progress ledger',
        ErrorCode.GameConfig,
    )
    for (const [selector, count] of Object.entries(saved.roots)) {
        const values = selector.split(':').map(Number)
        ensure(
            values.length === 2 && values.every(positive) && values.join(':') === selector && uint(count),
            'Malformed manual crop root count',
            ErrorCode.GameConfig,
        )
    }
    for (const [selector, count] of Object.entries(saved.counts)) {
        const [source, ...parts] = selector.split(':'),
            values = parts.map(Number)
        ensure(
            ['manual', 'worker'].includes(source) &&
                values.length === 4 &&
                values.every(uint) &&
                values[2] > 0 &&
                values[3] > 0 &&
                values.join(':') === parts.join(':') &&
                (source === 'manual' ? values[0] > 0 && values[1] > 0 : values[0] === 0 && values[1] === 0) &&
                uint(count),
            'Malformed crop product counter',
            ErrorCode.GameConfig,
        )
    }
    return saved
}
function commit(state, rows, root) {
    if (!rows.length && !root) return false
    const previous = history(state),
        next = {
            version: 1,
            revision: previous.revision + 1,
            roots: { ...previous.roots },
            counts: { ...previous.counts },
        }
    ensure(uint(next.revision), 'Farm harvest revision overflow', ErrorCode.GameConfig)
    if (root) {
        next.roots[root] = (next.roots[root] ?? 0) + 1
        ensure(uint(next.roots[root]), 'Manual crop root counter overflow', ErrorCode.GameConfig)
    }
    for (const [selector, amount] of rows) {
        const value = (next.counts[selector] ?? 0) + amount
        ensure(positive(amount) && uint(value), 'Crop product count overflow', ErrorCode.GameConfig)
        next.counts[selector] = value
    }
    state.home.farmHarvestProgress = next
    return true
}
function collect(tables, state, source, seedId, buildType, rewards, roles) {
    const result = []
    for (const row of rewards) {
        ensure(
            positive(row.itemtype) && positive(row.itemid) && positive(row.itemnum),
            'Invalid actual crop reward quantity',
            ErrorCode.GameConfig,
        )
        const item = key(row)
        if (roles.products.has(item))
            result.push([[source, buildType, seedId, row.itemtype, row.itemid].join(':'), row.itemnum])
        else if (!roles.ignored.has(item)) warnOnce(tables, state, source, seedId, item)
    }
    return result
}
export function recordManualFarmHarvest(tables, state, build, rewards) {
    const model = catalogue(tables),
        type = model.fields.get(build.build_id),
        seedId = build.crop_info?.seed_id,
        plant = model.plants.get(seedId)
    ensure(type && plant, 'Invalid owned annual harvest source', ErrorCode.GameConfig)
    return commit(
        state,
        collect(tables, state, 'manual', seedId, type, rewards, { products: plant.products, ignored: model.ignored }),
        type + ':' + seedId,
    )
}
export function recordWorkerFarmClaim(tables, state, house, rewards) {
    const config = tables.find('home_building', house.build_id),
        group = config && tables.get('home_building_group').find((row) => row.groupId === config.groupId)
    ensure(group?.type === 16, 'Invalid farm storage progress source', ErrorCode.GameConfig)
    return commit(state, collect(tables, state, 'worker', 0, 0, rewards, catalogue(tables)))
}
export function farmHarvestProgressRule(tables, tokens) {
    if (!Array.isArray(tokens) || !tokens.every(uint) || !positive(tokens.at(-1))) return false
    if (tokens[0] === 12005) return tokens.length === 3 && catalogue(tables).fieldTypes.has(tokens[1])
    if (tokens[0] === 12062) return tokens.length === 4 && catalogue(tables).products.has(tokens[1] + ':' + tokens[2])
    return false
}
export function farmHarvestProgressValue(tables, state, tokens, facts = new Map()) {
    if (!farmHarvestProgressRule(tables, tokens)) return null
    const model = catalogue(tables)
    if (!facts.has('farm-harvest:history')) facts.set('farm-harvest:history', history(state))
    let total = 0
    for (const [selector, count] of Object.entries(facts.get('farm-harvest:history').counts)) {
        if (!count) continue
        const [source, type, seed, resource, item] = selector.split(':')
        const roles = source === 'manual' ? model.plants.get(Number(seed))?.products : model.products
        if (!roles?.has(resource + ':' + item) || (source === 'manual' && !model.fieldTypes.has(Number(type)))) {
            warnOnce(tables, state, 'typed-history-' + source, Number(seed), resource + ':' + item)
            continue
        }
        if (
            tokens[0] === 12005
                ? source === 'manual' && Number(type) === tokens[1]
                : Number(resource) === tokens[1] && Number(item) === tokens[2]
        )
            total += count
    }
    ensure(
        Number.isSafeInteger(total) && total >= 0 && total <= 0xffffffff,
        'Crop harvest aggregate overflow',
        ErrorCode.GameConfig,
    )
    return Math.min(tokens.at(-1), total)
}
