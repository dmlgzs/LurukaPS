import test from 'node:test'
import assert from 'node:assert/strict'
import { planProductionFeeding, applyProductionFeeding } from '../src/production-work-food.js'
import { workSerialize, workAdd, workCompare } from '../src/production-work-fractions.js'
import { ErrorCode } from '../src/error-codes.js'

// These are explicit review-policy fixtures, not claims about official eating rules.
const scores = new Map([
    [1, 1],
    [4, 4],
    [10, 10],
    [20, 20],
    [30, 30],
    [40, 40],
    [50, 50],
    [80, 80],
    [90, 90],
    [120, 120],
])
const tables = {
    find(name, id) {
        if (name === 'common_item' && scores.has(id)) return { id, type: 355 }
        if (name === 'food' && scores.has(id)) return { id, satietyScore: scores.get(id), foodType: 4 }
        if (name === 'home_building' && id === 10011) return { id, groupId: 1001, trough: 2000000000 }
    },
    get(name) {
        assert.equal(name, 'home_building_group')
        return [{ groupId: 1001, type: 6 }]
    },
}
const food = (itemid, itemnum) => ({ itemtype: 3, itemid, itemnum })
function build(guid, foods, extra = {}) {
    return {
        guid,
        build_id: 10011,
        build_type: 6,
        status: 1,
        locate: { block_id: 101, anchor: guid, direction: 0 },
        pet_canteen: {
            pets: [],
            foods,
            food_value: foods.reduce((n, f) => n + scores.get(f.itemid) * f.itemnum, 0),
            food_extra_ids: [77],
            food_extra_values: [23],
            ...extra,
        },
    }
}
const state = (...builds) => ({ player: { basic_info: { id: 1 } }, homeRevision: 12, petRevision: 7, home: { builds } })
const plan = (s, balance = 0, budget = 20, cap = 100) => planProductionFeeding(tables, s, { balance, budget, cap })
const serialized = (value) => workSerialize(value)
const rejects = (fn) => assert.throws(fn, (e) => e.code === ErrorCode.GameConfig)
function deepFreeze(value) {
    if (value && typeof value === 'object') {
        Object.freeze(value)
        for (const child of Object.values(value)) deepFreeze(child)
    }
    return value
}
function conserved(p) {
    const raw = p.transfers.reduce((n, t) => n + BigInt(t.count) * BigInt(t.score), 0n)
    assert.equal(workCompare(workAdd(p.recovery, p.waste), raw), 0)
    assert.equal(workCompare(workAdd(p.input.balance, p.recovery), p.balance), 0)
    assert.doesNotThrow(() => JSON.stringify(p))
}

test('v2 stops at the complete unit budget and never fills to cap merely because more food remains', () => {
    const s = deepFreeze(state(build(1, [food(50, 2)]))),
        before = JSON.stringify(s),
        p = plan(s)
    assert.equal(JSON.stringify(s), before)
    assert.equal(p.satisfied, true)
    assert.deepEqual(p.balance, serialized(50))
    assert.deepEqual(p.transfers, [{ buildGuid: 1, itemId: 50, count: 1, score: 50 }])
    assert.deepEqual(p.updates[0].foods, [food(50, 1)])
    assert.equal(p.updates[0].food_value, 50)
    conserved(p)
})

test('food choice uses cap space rather than budget deficit, then stable numeric building GUID and item ID ties', () => {
    const s = state(build(10, [food(50, 1)]), build(2, [food(80, 1), food(50, 1)]))
    assert.equal(plan(s, 15).transfers[0].itemId, 80)
    const p = plan(state(build(10, [food(50, 1)]), build(2, [food(50, 1)])))
    assert.equal(p.transfers[0].buildGuid, 2)
    const tieTables = {
        ...tables,
        find(name, id) {
            if (name === 'common_item' && [7, 9].includes(id)) return { id, type: 355 }
            if (name === 'food' && [7, 9].includes(id)) return { id, satietyScore: 50 }
            return tables.find(name, id)
        },
    }
    const b = build(2, [])
    b.pet_canteen.foods = [food(9, 1), food(7, 1)]
    b.pet_canteen.food_value = 100
    assert.equal(
        planProductionFeeding(tieTables, state(b), { balance: 0, budget: 20, cap: 100 }).transfers[0].itemId,
        7,
    )
    const limited = plan(state(build(1, [food(90, 1), food(10, 1)])), 15)
    assert.equal(limited.transfers[0].itemId, 10)
    assert.deepEqual(limited.balance, serialized(25))
})

test('whole-dish overflow and fractional recovery/waste remain exact and never become hidden extra value', () => {
    const s = state(build(1, [food(120, 2)])),
        p = plan(s, 10)
    assert.deepEqual(p.balance, serialized(100))
    assert.deepEqual(p.recovery, serialized(90))
    assert.deepEqual(p.waste, serialized(30))
    conserved(p)
    const fraction = plan(s, { n: '1', d: '3' })
    assert.deepEqual(fraction.recovery, { n: '299', d: '3' })
    assert.deepEqual(fraction.waste, { n: '61', d: '3' })
    conserved(fraction)
    applyProductionFeeding(s, fraction)
    assert.deepEqual(s.home.builds[0].pet_canteen.food_extra_ids, [77])
    assert.deepEqual(s.home.builds[0].pet_canteen.food_extra_values, [23])
    assert.equal(s.home.builds[0].pet_canteen.food_value, 120)
})

test('insufficient combined stock consumes nothing and sufficient retained old balance above cap remains unchanged', () => {
    const s = state(build(1, [food(4, 1)])),
        before = structuredClone(s),
        p = plan(s, 15)
    assert.equal(p.satisfied, false)
    assert.deepEqual(p.transfers, [])
    assert.deepEqual(p.updates, [])
    assert.deepEqual(p.balance, serialized(15))
    assert.equal(applyProductionFeeding(s, p), false)
    assert.deepEqual(s, before)
    const old = plan({}, 10000)
    assert.equal(old.satisfied, true)
    assert.deepEqual(old.balance, serialized(10000))
    assert.deepEqual(old.transfers, [])
    assert.equal(applyProductionFeeding({}, old), false)
    for (const empty of [p, old]) {
        const invalid = structuredClone(empty)
        invalid.satisfied = !invalid.satisfied
        rejects(() => applyProductionFeeding(s, invalid))
        assert.deepEqual(s, before)
    }
    rejects(() => plan(s, 10000, 101, 100))
    rejects(() => plan(s, -1))
    rejects(() => plan(s, 0, 0))
    rejects(() => plan(s, 0, 20, 0))
    rejects(() => plan(s, { n: '1', d: '0' }))
})

test('only this account placed usable type6 sources participate; bad source configuration is rejected without edits', () => {
    const unplaced = build(2, [food(120, 1)])
    delete unplaced.locate
    const wrongType = { ...build(3, [food(120, 1)]), build_type: 2 }
    const inactive = { ...build(4, [food(120, 1)]), status: 2 }
    const s = state(build(1, [food(10, 1)]), unplaced, wrongType, inactive)
    s.home.storedBuilds = [build(5, [food(120, 1)])]
    assert.equal(plan(s).satisfied, false)
    const missing = state({ ...build(1, [food(50, 1)]), build_id: 99 }),
        before = structuredClone(missing)
    assert.throws(
        () => plan(missing),
        (e) => e.code === ErrorCode.BuildConfNotFound,
    )
    assert.deepEqual(missing, before)
    rejects(() => plan(state(build(1, []), { ...build(1, []), build_type: 2 })))
})

test('shared0330 ledger guards reject duplicates, damaged quantities and inconsistent values without repairing unknown old meals', () => {
    for (const kind of ['duplicate', 'fraction', 'negative', 'value', 'zero-value', 'type']) {
        const s = state(build(1, [food(50, 2)])),
            c = s.home.builds[0].pet_canteen
        if (kind === 'duplicate') {
            c.foods = [food(50, 1), food(50, 1)]
        }
        if (kind === 'fraction') {
            c.foods[0].itemnum = 0.5
            c.food_value = 25
        }
        if (kind === 'negative') {
            c.foods[0].itemnum = -1
        }
        if (kind === 'value') c.food_value--
        if (kind === 'zero-value') c.food_value = 0
        if (kind === 'type') c.foods[0].itemtype = 10
        const before = structuredClone(s)
        rejects(() => plan(s))
        assert.deepEqual(s, before)
    }
    const s = state(build(1, [food(50, 2)])),
        noFood = {
            ...tables,
            find(name, id) {
                return name === 'food' ? undefined : tables.find(name, id)
            },
        }
    assert.throws(
        () => planProductionFeeding(noFood, s, { balance: 0, budget: 20, cap: 100 }),
        (e) => e.code === ErrorCode.FoodConfNotExist,
    )
})

test('all source preimages include unconsumed tables, ownership, placement and opaque fields', () => {
    for (const change of ['unconsumed', 'owner', 'placement', 'extra', 'new-source']) {
        const s = state(build(1, [food(50, 2)]), build(2, [food(1, 1)])),
            p = plan(s)
        if (change === 'unconsumed') {
            s.home.builds[1].pet_canteen.foods[0].itemnum = 2
            s.home.builds[1].pet_canteen.food_value = 2
        }
        if (change === 'owner') s.player.basic_info.id = 2
        if (change === 'placement') s.home.builds[0].locate.anchor++
        if (change === 'extra') s.home.builds[1].pet_canteen.food_extra_values.push(99)
        if (change === 'new-source') s.home.builds.push(build(3, [food(80, 1)]))
        const before = structuredClone(s)
        rejects(() => applyProductionFeeding(s, p))
        assert.deepEqual(s, before)
    }
})

test('late update mismatch validates all preimages before any writes, and a consumed plan cannot immediately replay', () => {
    const s = state(build(1, [food(40, 1)]), build(2, [food(30, 2)])),
        p = plan(s, 0, 80),
        before = structuredClone(s),
        home = s.home
    assert.equal(p.updates.length, 2)
    const stale = structuredClone(p)
    stale.updates[1].preimage = 'bad'
    rejects(() => applyProductionFeeding(s, stale))
    assert.deepEqual(s, before)
    assert.equal(s.home, home)
    const tampered = structuredClone(p)
    tampered.updates[1].foods = [food(30, 2)]
    rejects(() => applyProductionFeeding(s, tampered))
    assert.deepEqual(s, before)
    const duplicate = structuredClone(p)
    duplicate.transfers.push({ ...p.transfers[0] })
    rejects(() => applyProductionFeeding(s, duplicate))
    assert.deepEqual(s, before)
    assert.equal(applyProductionFeeding(s, JSON.parse(JSON.stringify(p))), true)
    const committed = structuredClone(s)
    rejects(() => applyProductionFeeding(s, p))
    assert.deepEqual(s, committed)
    conserved(p)
})

test('apply isolates shallow drafts and output rows without changing revisions or mutating plan/opaque old branches', () => {
    const base = deepFreeze(state(build(1, [food(50, 2)]), build(2, [food(1, 2)]))),
        before = JSON.stringify(base),
        p = plan(base),
        draft = { ...base }
    assert.equal(applyProductionFeeding(draft, p), true)
    assert.notEqual(draft.home, base.home)
    assert.notEqual(draft.home.builds, base.home.builds)
    assert.notEqual(draft.home.builds[0], base.home.builds[0])
    assert.notEqual(draft.home.builds[0].pet_canteen, base.home.builds[0].pet_canteen)
    assert.notEqual(draft.home.builds[0].pet_canteen.foods, base.home.builds[0].pet_canteen.foods)
    assert.notEqual(draft.home.builds[0].pet_canteen.foods[0], base.home.builds[0].pet_canteen.foods[0])
    assert.equal(draft.home.builds[1], base.home.builds[1])
    assert.equal(JSON.stringify(base), before)
    assert.equal(draft.homeRevision, 12)
    assert.equal(draft.petRevision, 7)
    p.updates[0].foods[0].itemnum = 99
    assert.equal(draft.home.builds[0].pet_canteen.foods[0].itemnum, 1)
})

test('fractional cap remainder consumes one final whole unit with explicit loss, while billion-count stock uses batches', () => {
    const p = plan(state(build(1, [food(1, 100)])), { n: '1', d: '3' }, 100, 100)
    assert.equal(p.transfers[0].count, 100)
    assert.deepEqual(p.recovery, { n: '299', d: '3' })
    assert.deepEqual(p.waste, { n: '1', d: '3' })
    conserved(p)
    const s = state(build(1, [food(1, 2000000000)])),
        batch = plan(s, 0, 1999999999, 2000000000)
    assert.deepEqual(batch.transfers, [{ buildGuid: 1, itemId: 1, count: 1999999999, score: 1 }])
    assert.deepEqual(batch.updates[0].foods, [food(1, 1)])
    conserved(batch)
    applyProductionFeeding(s, batch)
    assert.equal(s.home.builds[0].pet_canteen.food_value, 1)
})
