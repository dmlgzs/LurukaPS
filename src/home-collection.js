import { randomInt } from 'node:crypto'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { collectionDropIds, collectionItemMatches, collectionPending } from './collection-drop.js'
import {
    prepareCollectionClocks,
    markCurrentCollectionJob,
    currentHomeTalentRows,
    detachedCollectionPending,
} from './home-production-clock.js'
import { compileCollectionPlans, resolveCollectionPlan } from './home-collection-plan.js'

const catalogs = new WeakMap()
const list = (value) =>
    String(value ?? '')
        .split('|')
        .filter(Boolean)
        .map(Number)
const changed = (state) => {
    state.homeRevision = (state.homeRevision || 0) + 1
}
const experience = (item) => item.item_type === 10 && item.item_id === 1003

// TODO(collection-world-home-dispatch-and-aggregate-claims): validate the
// server's full-warehouse/offline policy and satiety consumption in-game.
// Lua's floating fatigue multiplier is used here; the unreferenced recovered
// native helper instead performs integer division and cannot establish the
// official server cadence. See collection-production-20261022.md.

function catalog(tables) {
    if (!catalogs.has(tables))
        catalogs.set(tables, {
            stations: new Map(tables.get('home_building_homecollection').map((r) => [r.id, r])),
            products: new Map(tables.get('products_collection').map((r) => [r.id, r])),
            drops: new Map(tables.get('home_drop').map((r) => [r.id, r])),
            worlds: tables.get('home_collection_world'),
            buildings: tables.get('home_building_collection'),
            buffs: new Map(tables.get('home_buff_params').map((r) => [r.id, r])),
            talents: new Map(tables.get('home_talent').map((r) => [r.talentId, r])),
            technology: tables.get('home_technology'),
            constants: new Map(tables.get('game').map((r) => [r.title, Number(r.value)])),
        })
    return catalogs.get(tables)
}
export function collectionStation(tables, build) {
    return build?.build_type === 24 ? catalog(tables).stations.get(build.build_id) : undefined
}
function matches(row, station, product) {
    const terms = String(row.buffCondition || '')
        .split('|')
        .filter(Boolean)
        .map((v) => v.split('#').map(Number))
    const match = ([key, value]) => {
        if (key === 2034) return value === station.groupId
        if (key === 2012) return value === product
        ensure(false, 'Collection buff condition requires support', ErrorCode.FunctionClosed)
    }
    return row.buffConditionLogic === 2 ? !terms.length || terms.some(match) : terms.every(match)
}
function values(row, id) {
    const params = String(row.buffParams || '').split('|')
    return list(row.buffId).flatMap((key, i) => (key === id ? [Number(params[i])] : []))
}
function buffRows(tables, state, station, pet) {
    const data = catalog(tables),
        rows = []
    for (const world of data.worlds) {
        if (!list(station.collectiontype).includes(world.collectionType)) continue
        const unlocked = state.home?.worldCollections?.[world.id]
        if (!unlocked) continue
        const building = data.buildings.find((r) => r.id === unlocked.build_id && r.groupId === world.groupId)
        ensure(building, 'Saved collection point has no matching building', ErrorCode.CollectBuildNotExist)
        for (const id of list(building.buffParamsId)) {
            const row = data.buffs.get(id)
            ensure(row, 'Missing collection bonus configuration', ErrorCode.GameConfig)
            rows.push(row)
        }
    }
    rows.push(...currentHomeTalentRows(tables, pet))
    for (const row of data.technology)
        if (state.home?.technology?.levels?.[row.type]?.level === row.level) rows.push(row)
    return rows
}
export function collectionPlan(tables, state, build) {
    const data = catalog(tables),
        station = collectionStation(tables, build)
    ensure(station, 'Missing home collection station', ErrorCode.CollectBuildNotExist)
    const pet = state.pets?.find((p) => p.guid === String(build.station_pet_guid))
    const selected = resolveCollectionPlan(compileCollectionPlans(tables), build).selected
    const rows = buffRows(tables, state, station, pet),
        ids = new Set(selected.leaves.map((leaf) => leaf.product.id))
    let slots = station.collectionlimit
    for (const row of rows) {
        if (![2028, 2029, 4006].some((id) => values(row, id).length)) continue
        if (!matches(row, station, 0)) continue
        for (const id of [2028, 2029]) for (const product of values(row, id)) ids.add(product)
        for (const amount of values(row, 4006)) slots += amount
    }
    ensure(
        Number.isSafeInteger(slots) &&
            slots > 0 &&
            Number.isSafeInteger(station.collectionlatticelimit) &&
            station.collectionlatticelimit > 0,
        'Invalid collection storage limits',
        ErrorCode.GameConfig,
    )
    const labor = pet?.labor_infos?.find((r) => list(station.laborType).includes(r.labor_id) && r.labor_grade > 0)
    let speed = 0
    if (labor) {
        const efficiency = tables.find('home_labor_efficiency', labor.labor_grade)
        ensure(
            efficiency && Number.isFinite(efficiency.GatherTimeReduct),
            'Missing collection labor grade',
            ErrorCode.GameConfig,
        )
        speed = Math.max(0, efficiency.GatherTimeReduct) / 10000
        if (pet.satiety_val <= data.constants.get('PET_HOME_TIRED_SATIETY'))
            speed *= data.constants.get('HOME_LABOR_GATHER_DECREASE') / 10000
    }
    const streams = [...ids].map((id) => {
        const product = data.products.get(id),
            drop = data.drops.get(product?.homeDropId)
        ensure(product, 'Missing collection product', ErrorCode.CollectProductConfNotFound)
        ensure(drop, 'Missing collection drop', ErrorCode.CollectDropConfNotFound)
        ensure(
            !product.technologyExp && !drop.technologyExp && !drop.home_exp,
            'Collection product variant requires support',
            ErrorCode.FunctionClosed,
        )
        const itemIds = collectionDropIds(tables, drop)
        ensure(
            [drop.minValue, drop.maxValue, drop.rate, drop.dropTime].every(Number.isSafeInteger) &&
                drop.minValue > 0 &&
                drop.maxValue >= drop.minValue &&
                drop.rate >= 0 &&
                drop.rate <= 10000 &&
                drop.dropTime > 0,
            `Invalid collection drop definition (product ${id}, drop ${product.homeDropId})`,
            ErrorCode.GameConfig,
        )
        let reduction = 0
        for (const row of rows) {
            const amounts = values(row, 2001)
            if (!amounts.length || !matches(row, station, id)) continue
            for (const amount of amounts) reduction += amount / 10000
        }
        const seconds = Math.max(
            data.constants.get('HOME_PRODUCT_COLLECTION_BOTTOM_TIME'),
            drop.dropTime * (1 - reduction) * (1 - speed),
        )
        ensure(Number.isFinite(seconds) && seconds > 0, 'Invalid collection production period', ErrorCode.GameConfig)
        return { product: id, drop, itemIds, seconds }
    })
    return { station, pet, streams, slots, stack: station.collectionlatticelimit, planId: selected.id }
}
function preparePlanWire(tables, build) {
    const selection = resolveCollectionPlan(compileCollectionPlans(tables), build)
    const data = wire(build)
    if (selection.needsInitialization) {
        data.product_choose_id = selection.selected.id
        data.choose_time ??= '0'
        return true
    }
    return false
}
export function selectHomeCollectionPlan(tables, state, request, now) {
    ensure(
        [request.build_guid, request.product_choose_id].every(
            (id) => Number.isSafeInteger(id) && id > 0 && id <= 0xffffffff,
        ),
        'Invalid collection plan selection',
        ErrorCode.InvalidArgument,
    )
    const build = state.home?.builds?.find(
        (row) => row.guid === request.build_guid && row.build_type === 24 && row.locate && [1, 4].includes(row.status),
    )
    ensure(build, 'Collection building is not owned or ready', ErrorCode.CollectBuildNotExist)
    const entry = compileCollectionPlans(tables).get(build.build_id)
    ensure(entry, 'Missing home collection station', ErrorCode.GameConfig)
    ensure(
        entry.allowed.some((plan) => plan.id === request.product_choose_id),
        'Plan is not allowed for this station',
        ErrorCode.CollectProductnotMatch,
    )
    const selected = resolveCollectionPlan(compileCollectionPlans(tables), build)
    ensure(
        selected.selected.id === request.product_choose_id,
        'Changing to a different collection plan requires current multi-plan support',
        ErrorCode.FunctionClosed,
    )
    const initialized = preparePlanWire(tables, build)
    if (initialized) changed(state)
    retimeCollections(tables, state, now)
    return build
}
function requireExecutionPlan(tables, plan, build, job) {
    const bound = plan.pet && plan.pet.work_build === build.guid && [1, 2].includes(plan.pet.work_status)
    if (!bound && !job?.clocks?.length) return // Idle/unbound presentation is not an execution plan.
    const raw = plan.station.planID
    ensure(
        typeof raw === 'string' && /^\d+(\|\d+)*$/.test(raw),
        'Collection plan declaration is malformed',
        ErrorCode.GameConfig,
    )
    const ids = raw.split('|').map(Number)
    ensure(
        ids.every((id) => Number.isSafeInteger(id) && id > 0) && new Set(ids).size === ids.length,
        'Collection plan declaration has invalid identities',
        ErrorCode.GameConfig,
    )
    const saved = build.collect_build_data?.product_choose_id ?? 0
    ensure(
        Number.isSafeInteger(saved) && saved >= 0 && (!saved || ids.includes(saved)),
        'Saved collection plan is outside its declaration',
        ErrorCode.GameConfig,
    )
    ensure(saved || ids.length === 1, 'Collection plan selection is not implemented', ErrorCode.FunctionClosed)
    const selected = saved || ids[0]
    const data = catalog(tables),
        rows = tables.get('home_building_collectionplan')
    const base = []
    for (const id of ids) {
        const matches = rows.filter((row) => row.id === id)
        ensure(
            matches.length === 1 && matches[0].groupId === plan.station.groupId,
            'Declared collection plan is missing or belongs to another station',
            ErrorCode.GameConfig,
        )
        const products = matches[0].products
        ensure(
            typeof products === 'string' && (!products || /^\d+(\|\d+)*$/.test(products)),
            'Declared collection plan products are malformed',
            ErrorCode.GameConfig,
        )
        for (const productId of list(products)) {
            const product = data.products.get(productId)
            ensure(product, 'Declared collection product is missing', ErrorCode.CollectProductConfNotFound)
            ensure(
                data.drops.has(product.homeDropId),
                'Declared collection drop is missing',
                ErrorCode.CollectDropConfNotFound,
            )
            if (id === selected) base.push(productId)
        }
    }
    // Extra technology/world flows cannot stand in for unresolved basic plan outputs.
    const parsed = new Set(plan.streams.map((stream) => stream.product))
    ensure(
        base.length > 0 && base.every((id) => parsed.has(id)),
        'Current collection plan execution is not implemented',
        ErrorCode.FunctionClosed,
    )
}
function wire(build) {
    return (build.collect_build_data ??= {
        guid: build.guid,
        build_id: build.build_id,
        start_time: 0,
        pet_guid: '0',
        product_infos: [],
        items: [],
    })
}
export function ensureCollectionData(state) {
    let updated = false
    for (const build of state.home?.builds ?? [])
        if (build.build_type === 24 && !build.collect_build_data) {
            wire(build)
            updated = true
        }
    if (updated) changed(state)
    return updated
}
export function homeCollectionPresentation(tables, state, build) {
    if (build.build_type !== 24 || !build.collect_build_data) return build
    const detached = detachedCollectionPending(tables, state, build.guid)
    if (!detached.length) return build
    const items = (build.collect_build_data.items ?? []).map((item) => ({ ...item }))
    for (const entry of detached) {
        const item = entry.item
        const old = items.find((row) => row.item_id === item.item_id && row.item_type === item.item_type)
        if (old) {
            ensure(
                old.item_num + item.item_num <= 0xffffffff,
                'Collection presentation quantity overflow',
                ErrorCode.GameConfig,
            )
            old.item_num += item.item_num
        } else items.push({ ...item })
    }
    return { ...build, collect_build_data: { ...build.collect_build_data, items } }
}
export function collectionStorage(plan, items) {
    let cells = 0
    for (const item of items) {
        ensure(
            Number.isSafeInteger(item.item_num) && item.item_num > 0,
            'Invalid collection stored quantity',
            ErrorCode.GameConfig,
        )
        if (experience(item)) continue
        cells += item.item_type === 14 ? item.item_num : Math.ceil(item.item_num / plan.stack)
    }
    return cells
}
function room(plan, items, stream, itemId) {
    if (stream.drop.itemType === 10 && itemId === 1003) return 0xffffffff
    const freeCells = Math.max(0, plan.slots - collectionStorage(plan, items))
    const item = items.find((r) => collectionItemMatches(r, stream.product, stream.drop.itemType, itemId))
    const tail = item && item.item_type !== 14 ? (plan.stack - (item.item_num % plan.stack)) % plan.stack : 0
    return freeCells * (stream.drop.itemType === 14 ? 1 : plan.stack) + tail
}
const streamRoom = (plan, items, stream) => Math.max(...stream.itemIds.map((id) => room(plan, items, stream, id)))
function publish(build, job) {
    const data = wire(build)
    data.pet_guid = job?.pet ?? '0'
    data.start_time = job?.pet && job.pet !== '0' ? job.started : 0
    data.product_infos = (job?.clocks ?? []).map((clock) => ({
        product_id: clock.product,
        last_collect_time: Math.max(0, Math.floor(clock.next - clock.seconds)),
        next_collect_time: Math.ceil(clock.next),
    }))
}
export function stopCollection(build, state, now) {
    const job = state.home?.collectionProduction?.[build.guid]
    if (job) {
        for (const clock of job.clocks)
            if (job.pet !== '0' && (!job.blocked || clock.remaining === undefined))
                clock.remaining = Math.max(0, (clock.next - now) / clock.seconds)
        job.pet = '0'
        job.blocked = false
    }
    if (build.build_type === 24) {
        publish(build, null)
        if (build.status === 4) build.status = 1
    }
}
// Reconcile after ordinary mutations. Fractional work is retained when a
// worker/technology changes; integer wire timestamps never award work early.
export function retimeCollections(tables, state, now) {
    let updated = false
    const builds = state.home?.builds ?? [],
        jobs = state.home?.collectionProduction
    // Unplaced/orphaned saved work is retained, never deleted by a snapshot reconciliation.
    for (const build of builds) {
        if (build.build_type !== 24) continue
        if (preparePlanWire(tables, build)) updated = true
        const plan = collectionPlan(tables, state, build)
        let job = state.home.collectionProduction?.[build.guid]
        requireExecutionPlan(tables, plan, build, job)
        if (job && prepareCollectionClocks(tables, job, plan.streams, now, wire(build).items, build.build_id))
            updated = true
        if (!build.collect_build_data) {
            wire(build)
            updated = true
        }
        const active =
            build.locate &&
            [1, 4].includes(build.status) &&
            plan.pet &&
            plan.pet.work_build === build.guid &&
            [1, 2].includes(plan.pet.work_status)
        if (!active) {
            if ((job?.pet !== undefined && job.pet !== '0') || build.collect_build_data.start_time) {
                stopCollection(build, state, now)
                updated = true
            }
            continue
        }
        if (!job || job.pet !== plan.pet.guid) {
            const clocks = (job?.clocks ?? []).map(({ remaining, ...clock }) => ({
                ...clock,
                next: now + (remaining ?? 1) * clock.seconds,
            }))
            job = { ...job, pet: plan.pet.guid, started: now, clocks, blocked: false }
            if (!job.clockMigration) markCurrentCollectionJob(job, now)
            prepareCollectionClocks(tables, job, plan.streams, now)
            ;(state.home.collectionProduction ??= {})[build.guid] = job
            updated = true
        }
        const resume =
            job.blocked &&
            (collectionStorage(plan, wire(build).items) < plan.slots ||
                job.clocks.some((clock) => {
                    const stream = plan.streams.find((s) => s.product === clock.product)
                    if (!stream || clock.pending === undefined) return false
                    const pending = collectionPending(stream, clock.pending)
                    return pending.item_num > 0 && room(plan, wire(build).items, stream, pending.item_id) > 0
                }))
        const clocks = []
        for (const stream of plan.streams) {
            let clock = job.clocks.find((c) => c.product === stream.product)
            if (!clock) {
                clock = { product: stream.product, next: now + stream.seconds, seconds: stream.seconds }
                updated = true
            } else if (resume || clock.seconds !== stream.seconds) {
                const remaining =
                    resume || job.blocked ? (clock.remaining ?? 1) : Math.max(0, (clock.next - now) / clock.seconds)
                clock.next = now + remaining * stream.seconds
                clock.seconds = stream.seconds
                if (!job.blocked || resume) delete clock.remaining
                updated = true
            }
            collectionPending(stream, clock.pending)
            clocks.push(clock)
        }
        if (clocks.length !== job.clocks.length) updated = true
        job.clocks = clocks
        if (resume) {
            job.blocked = false
            updated = true
        }
        publish(build, job)
    }
    if (updated) changed(state)
    return updated
}
export function collectionDue(state, now) {
    return Object.entries(state.home?.collectionProduction || {}).some(
        ([id, job]) =>
            state.home.builds.some((build) => String(build.guid) === id) &&
            job.pet !== '0' &&
            !job.blocked &&
            job.clocks.some((clock) => clock.next <= now),
    )
}
export function settleCollections(tables, state, now, rng = randomInt) {
    let updated = false
    // Preserve unmatched jobs for a later owned placement/explicit migration, not an implicit deletion.
    for (const build of state.home?.builds ?? []) {
        if (build.build_type === 24 && preparePlanWire(tables, build)) updated = true
        const job = state.home?.collectionProduction?.[build.guid]
        if (!job) continue
        const plan = collectionPlan(tables, state, build)
        requireExecutionPlan(tables, plan, build, job)
        if (prepareCollectionClocks(tables, job, plan.streams, now, wire(build).items, build.build_id)) updated = true
        if (job.pet === '0' || job.blocked || !job.clocks.some((c) => c.next <= now)) continue
        if (
            !build.locate ||
            ![1, 4].includes(build.status) ||
            plan.pet?.guid !== job.pet ||
            plan.pet.work_build !== build.guid ||
            ![1, 2].includes(plan.pet.work_status)
        ) {
            stopCollection(build, state, now)
            updated = true
            continue
        }
        const items = wire(build).items
        ensure(
            job.clocks.every(
                (clock) =>
                    Number.isFinite(clock.next) &&
                    clock.next > 0 &&
                    Number.isFinite(clock.seconds) &&
                    clock.seconds > 0 &&
                    (clock.pending === undefined ||
                        (Number.isSafeInteger(clock.pending) && clock.pending >= 0) ||
                        (clock.pending && typeof clock.pending === 'object' && !Array.isArray(clock.pending))),
            ),
            'Invalid saved collection clock',
            ErrorCode.GameConfig,
        )
        const streams = new Map(plan.streams.map((s) => [s.product, s]))
        // Validate every current stream's sealed identity before producing any
        // earlier due clock. Keep retime's existing removal of obsolete flows.
        for (const clock of job.clocks) {
            const stream = streams.get(clock.product)
            if (stream) collectionPending(stream, clock.pending)
        }
        while (!job.blocked) {
            const clock = job.clocks.reduce((best, c) => (!best || c.next < best.next ? c : best), null)
            if (!clock || clock.next > now) break
            const stream = streams.get(clock.product)
            ensure(stream, 'Saved collection clock has no product', ErrorCode.CollectProductConfNotFound)
            const at = clock.next
            if (clock.pending === undefined) {
                const quantity =
                    stream.drop.rate === 10000 || (stream.drop.rate > 0 && rng(0, 10000) < stream.drop.rate)
                        ? stream.drop.minValue === stream.drop.maxValue
                            ? stream.drop.minValue
                            : rng(stream.drop.minValue, stream.drop.maxValue + 1)
                        : 0
                if (stream.itemIds.length === 1) clock.pending = quantity
                else {
                    const index = quantity > 0 ? rng(0, stream.itemIds.length) : 0
                    ensure(
                        Number.isSafeInteger(index) && index >= 0 && index < stream.itemIds.length,
                        'Collection candidate random source is out of range',
                        ErrorCode.GameConfig,
                    )
                    clock.pending = {
                        item_id: stream.itemIds[index],
                        item_type: stream.drop.itemType,
                        item_num: quantity,
                    }
                }
            }
            const pending = collectionPending(stream, clock.pending)
            const amount = Math.min(pending.item_num, room(plan, items, stream, pending.item_id))
            if (amount) {
                let item = items.find((r) =>
                    collectionItemMatches(r, stream.product, pending.item_type, pending.item_id),
                )
                if (!item) {
                    item = {
                        item_id: pending.item_id,
                        item_type: pending.item_type,
                        item_num: 0,
                        source_product_id: stream.product,
                    }
                    items.push(item)
                }
                ensure(
                    collectionItemMatches(item, stream.product, pending.item_type, pending.item_id),
                    'Stored collection item disagrees with its product',
                    ErrorCode.GameConfig,
                )
                ensure(item.item_num + amount <= 0xffffffff, 'Collection quantity overflow', ErrorCode.GameConfig)
                item.item_num += amount
                if (typeof clock.pending === 'number') clock.pending -= amount
                else clock.pending.item_num -= amount
            }
            updated = true
            if (collectionPending(stream, clock.pending).item_num > 0) {
                job.blocked = true
                for (const c of job.clocks) c.remaining = Math.max(0, (c.next - at) / c.seconds)
            } else {
                delete clock.pending
                clock.next += clock.seconds
                if (
                    collectionStorage(plan, items) >= plan.slots &&
                    plan.streams.every(
                        (s) =>
                            streamRoom(plan, items, s) === 0 ||
                            (s.drop.itemType === 10 && s.itemIds.every((id) => id === 1003)),
                    )
                ) {
                    job.blocked = true
                    for (const c of job.clocks) c.remaining = Math.max(0, (c.next - at) / c.seconds)
                }
            }
        }
        publish(build, job)
    }
    if (updated) changed(state)
    return updated
}
