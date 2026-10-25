import { randomInt } from 'node:crypto'
import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'
import { collectionDropIds, collectionItemMatches, collectionPending } from './collection-drop.js'

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
    for (const id of pet?.talent_id ?? []) {
        const row = data.talents.get(id)
        ensure(row, 'Missing collection worker talent', ErrorCode.GameConfig)
        rows.push(row)
    }
    for (const row of data.technology)
        if (state.home?.technology?.levels?.[row.type]?.level === row.level) rows.push(row)
    return rows
}
export function collectionPlan(tables, state, build) {
    const data = catalog(tables),
        station = collectionStation(tables, build)
    ensure(station, 'Missing home collection station', ErrorCode.CollectBuildNotExist)
    const pet = state.pets?.find((p) => p.guid === String(build.station_pet_guid))
    const rows = buffRows(tables, state, station, pet),
        ids = new Set(list(station.products))
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
            !product.needLabor &&
                !product.isNeedMaster &&
                !product.technologyExp &&
                !drop.technologyExp &&
                !drop.home_exp,
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
    return { station, pet, streams, slots, stack: station.collectionlatticelimit }
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
    if (jobs) for (const id of Object.keys(jobs)) if (!builds.some((b) => String(b.guid) === id)) delete jobs[id]
    for (const build of builds) {
        if (build.build_type !== 24) continue
        if (!build.collect_build_data) {
            wire(build)
            updated = true
        }
        const plan = collectionPlan(tables, state, build)
        const active =
            build.locate &&
            [1, 4].includes(build.status) &&
            plan.pet &&
            plan.pet.work_build === build.guid &&
            [1, 2].includes(plan.pet.work_status)
        let job = state.home.collectionProduction?.[build.guid]
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
            job = { pet: plan.pet.guid, started: now, clocks, blocked: false }
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
    return Object.values(state.home?.collectionProduction || {}).some(
        (job) => job.pet !== '0' && !job.blocked && job.clocks.some((clock) => clock.next <= now),
    )
}
export function settleCollections(tables, state, now, rng = randomInt) {
    let updated = false
    for (const id of Object.keys(state.home?.collectionProduction || {}))
        if (!(state.home.builds ?? []).some((b) => String(b.guid) === id)) {
            delete state.home.collectionProduction[id]
            updated = true
        }
    for (const build of state.home?.builds ?? []) {
        const job = state.home?.collectionProduction?.[build.guid]
        if (!job || job.pet === '0' || job.blocked || !job.clocks.some((c) => c.next <= now)) continue
        const plan = collectionPlan(tables, state, build)
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
