import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import policy from '../configs/production-work-policy-review.json' with { type: 'json' }
import { productionTables } from '../src/production-tables.js'
import { productionSeconds } from '../src/production-time.js'
import { settleProductionWork, reconcileProductionWork, productionWorkDue } from '../src/production-work.js'
import { workCompare, workSerialize, workFraction, workSub } from '../src/production-work-fractions.js'
import { ErrorCode } from '../src/error-codes.js'
import { productionWorkGameFixture } from './production-work-game-fixture.js'

const tables = new Tables(configuration().tables),
    recipes = productionTables(tables)
const T = 1000
function fixture({ balance = 60, count = 3, worker = true, builds = 1 } = {}) {
    const state = { pets: [], home: { level: 1, technology: { levels: {} }, builds: [], productionJobs: {} } }
    for (let i = 1; i <= builds; i++) {
        const pet = {
            guid: String(100 + i),
            config_id: 500001,
            satiety_val: balance,
            work_status: 2,
            work_build: i,
            capacity_id: 4001,
            labor_infos: [{ labor_id: 2, labor_grade: 1 }],
            talent_id: [],
        }
        const build = {
            guid: i,
            build_id: 10000,
            build_type: 10,
            status: 4,
            locate: {},
            station_pet_guid: worker ? pet.guid : '0',
        }
        state.pets.push(pet)
        state.home.builds.push(build)
        const recipe = recipes.find('products', 710031)
        state.home.productionJobs[i] = [
            {
                guid: i,
                productId: recipe.id,
                count,
                claimed: 0,
                start: T,
                seconds: productionSeconds(recipes, state, build, recipe),
                costs: [],
                rewards: [],
            },
        ]
    }
    return state
}
function food(state, count = 1, id = 9000101) {
    const score = tables.find('food', id).satietyScore
    const old = state.home.builds.find((build) => build.guid === 90)
    const build = {
        guid: 90,
        build_id: 10011,
        build_type: 6,
        status: 1,
        locate: { block_id: 101, anchor: 1, direction: 0 },
        pet_canteen: {
            pets: [],
            foods: count ? [{ itemtype: 3, itemid: id, itemnum: count }] : [],
            food_value: count * score,
            food_extra_ids: [],
            food_extra_values: [],
        },
    }
    if (old) state.home.builds[state.home.builds.indexOf(old)] = build
    else state.home.builds.push(build)
}
const job = (state, building = 1) => state.home.productionJobs[building][0]
const entry = (state, building = 1) => state.home.productionWork.jobs[job(state, building).workEpoch]
const balance = (state, pet = '101') => state.home.productionWork.pets[pet].balance
const eq = (actual, expected) => assert.equal(workCompare(actual, expected), 0)

test('explicit review policy only: pure due and disabled calls do not adopt or mutate a shallow parent', () => {
    const parent = fixture(),
        state = { ...parent },
        snapshot = structuredClone(parent)
    assert.equal(productionWorkDue(tables, state, T), false)
    assert.deepEqual(settleProductionWork(tables, state, T), {
        changed: false,
        homeChanged: false,
        petChanged: false,
        nextAt: null,
    })
    assert.deepEqual(parent, snapshot)
    assert.equal(productionWorkDue(tables, state, T, policy), true)
    assert.deepEqual(parent, snapshot)
    settleProductionWork(tables, state, T, policy)
    assert.deepEqual(parent, snapshot)
    assert.notStrictEqual(state.home, parent.home)
    assert.notStrictEqual(state.pets, parent.pets)
})

test('legacy half-unit adoption has no backcharge, requires a full future-segment budget and new food cannot backfill pause', () => {
    const state = fixture({ balance: 1, count: 1 }),
        seconds = job(state).seconds,
        elapsed = Math.floor(seconds / 2),
        adopted = workFraction(elapsed, seconds)
    settleProductionWork(tables, state, T + elapsed, policy)
    eq(entry(state).progress, adopted)
    eq(balance(state), 1)
    assert.equal(job(state).workPaused, true)
    assert.equal(job(state).workProjection.finish_time, 0)
    const frozen = structuredClone(state)
    assert.equal(productionWorkDue(tables, state, T + 10000, policy), false)
    assert.equal(settleProductionWork(tables, state, T + 10000, policy).changed, false)
    assert.deepEqual(state, frozen)
    food(state, 1)
    reconcileProductionWork(tables, state, T + 10000, policy)
    eq(entry(state).progress, adopted)
    eq(balance(state), 21)
    const resumed = job(state).workProjection.total_finish_time
    assert(resumed > T + 10000)
    settleProductionWork(tables, state, resumed, policy)
    eq(entry(state).progress, 1)
    const futureFee = workFraction(20 * (seconds - elapsed), seconds)
    eq(balance(state), workSub(21, futureFee))
    eq(state.home.productionWork.stats.spent, futureFee)
})

test('half-unit worker changes split actual cost, while an unmanned remainder charges no former worker', () => {
    const state = fixture({ count: 1 }),
        seconds = job(state).seconds
    settleProductionWork(tables, state, T, policy)
    settleProductionWork(tables, state, T + seconds / 2, policy)
    eq(balance(state), 50)
    const second = { ...state.pets[0], guid: '102', satiety_val: 60 }
    state.pets.push(second)
    state.home.builds[0].station_pet_guid = second.guid
    reconcileProductionWork(tables, state, T + seconds / 2, policy)
    settleProductionWork(tables, state, job(state).workProjection.total_finish_time, policy)
    eq(balance(state, '101'), 50)
    eq(balance(state, '102'), 50)
    eq(state.home.productionWork.stats.spent, 20)
    const unmanned = fixture({ count: 1 }),
        duration = job(unmanned).seconds
    settleProductionWork(tables, unmanned, T, policy)
    settleProductionWork(tables, unmanned, T + duration / 2, policy)
    unmanned.home.builds[0].station_pet_guid = '0'
    reconcileProductionWork(tables, unmanned, T + duration / 2, policy)
    settleProductionWork(tables, unmanned, job(unmanned).workProjection.total_finish_time, policy)
    eq(balance(unmanned), 50)
    eq(unmanned.home.productionWork.stats.spent, 10)
})

test('fractional balance above10 keeps healthy speed despite wire floor10, then crosses the exact threshold once', () => {
    const state = fixture({ balance: 21, count: 1 }),
        healthy = job(state).seconds
    settleProductionWork(tables, state, T, policy)
    const when = T + Math.floor(healthy * 0.53)
    settleProductionWork(tables, state, when, policy)
    assert.equal(state.pets[0].satiety_val, 10)
    assert(workCompare(balance(state), 10) > 0)
    assert.equal(entry(state).seconds, healthy)
    settleProductionWork(tables, state, T + Math.ceil((healthy * 11) / 20) + 1, policy)
    assert(workCompare(balance(state), 10) <= 0)
    assert(entry(state).seconds > healthy)
})

test('global contention and offline batching are independent of build array order and observation cadence', () => {
    const offline = fixture({ balance: 0, count: 2, builds: 2 })
    offline.home.builds.reverse()
    food(offline, 1)
    const online = structuredClone(offline)
    settleProductionWork(tables, offline, T, policy)
    settleProductionWork(tables, online, T, policy)
    assert.equal(entry(offline, 1).paused, false)
    assert.equal(entry(offline, 2).paused, true)
    eq(balance(offline, '101'), 20)
    eq(balance(offline, '102'), 0)
    settleProductionWork(tables, offline, T + 1000, policy)
    for (let at = T + 1; at <= T + 1000; at++) settleProductionWork(tables, online, at, policy)
    assert.deepEqual(offline, online)
    eq(stateTotals(offline), 0)
})
function stateTotals(state) {
    const ledger = state.home.productionWork
    const current = Object.values(ledger.pets).reduce(
        (total, pet) =>
            workFraction(
                total.n * BigInt(pet.balance.d) + BigInt(pet.balance.n) * total.d,
                total.d * BigInt(pet.balance.d),
            ),
        workFraction(0),
    )
    return workSub(current, workSub(ledger.stats.recovery, ledger.stats.spent))
}

test('insufficient food is not partially eaten, whole-food overflow is waste and cancelling the last paused job clears only owned pause', () => {
    const state = fixture({ balance: 0, count: 1 })
    const small = tables
        .get('food')
        .find(
            (row) => row.satietyScore > 0 && row.satietyScore < 20 && tables.find('common_item', row.id)?.type === 355,
        )
    assert(small)
    food(state, 1, small.id)
    settleProductionWork(tables, state, T, policy)
    assert.equal(state.home.builds.find((build) => build.guid === 90).pet_canteen.food_value, small.satietyScore)
    assert.equal(job(state).workPaused, true)
    state.home.productionJobs[1] = []
    reconcileProductionWork(tables, state, T, policy)
    assert.equal(state.pets[0].work_pause, false)
    const overflow = fixture({ balance: 0, count: 1 })
    const large = tables
        .get('food')
        .find((row) => row.satietyScore === 120 && tables.find('common_item', row.id)?.type === 355)
    food(overflow, 1, large.id)
    settleProductionWork(tables, overflow, T, policy)
    eq(balance(overflow), 100)
    eq(overflow.home.productionWork.stats.recovery, 100)
    eq(overflow.home.productionWork.stats.waste, 20)
})

test('completed projections stay sealed; job GUID reuse gets a new epoch, no old unit is manufactured', () => {
    const state = fixture({ count: 1 }),
        seconds = job(state).seconds
    settleProductionWork(tables, state, T + seconds, policy)
    eq(entry(state).progress, 1)
    eq(state.home.productionWork.stats.spent, 0)
    const projection = structuredClone(job(state).workProjection),
        oldEpoch = job(state).workEpoch
    settleProductionWork(tables, state, T + seconds + 100, policy)
    assert.deepEqual(job(state).workProjection, projection)
    state.home.productionJobs[1] = [
        { guid: 1, productId: 710031, count: 1, claimed: 0, start: T + seconds + 100, seconds, costs: [], rewards: [] },
    ]
    reconcileProductionWork(tables, state, T + seconds + 100, policy)
    assert(job(state).workEpoch > oldEpoch)
    assert.equal(job(state).workCompleted, 0)
})

test('legacy10000 is preserved and stable unmanned million-unit interval is advanced in one event', () => {
    const state = fixture({ balance: 10000, count: 1 })
    settleProductionWork(tables, state, T, policy)
    eq(balance(state), 10000)
    const end = job(state).workProjection.total_finish_time
    settleProductionWork(tables, state, end, policy)
    eq(balance(state), 9980)
    const big = fixture({ worker: false, count: 1000000 }),
        seconds = job(big).seconds
    settleProductionWork(tables, big, T, policy)
    settleProductionWork(tables, big, T + seconds * 1000000, policy)
    assert.equal(job(big).workCompleted, 1000000)
    eq(big.home.productionWork.stats.spent, 0)
})

test('budget/cap and malformed food failures do not mutate shallow input; foreign feeding pause is not cleared', () => {
    const state = fixture(),
        original = structuredClone(state)
    assert.throws(
        () => settleProductionWork(tables, state, T, { ...policy, unitBudgetMultiplier: 6 }),
        (error) => error.code === ErrorCode.GameConfig,
    )
    assert.deepEqual(state, original)
    const bad = fixture({ balance: 0 }),
        parent = structuredClone(bad)
    food(bad, 1)
    bad.home.builds.find((build) => build.guid === 90).pet_canteen.food_value = 1
    const invalid = structuredClone(bad),
        shallow = { ...bad }
    assert.throws(() => settleProductionWork(tables, shallow, T, policy))
    assert.deepEqual(bad, invalid)
    assert.deepEqual(shallow, invalid)
    assert.equal(parent.home.productionWork, undefined)
    const foreign = fixture()
    foreign.pets[0].work_pause = true
    foreign.pets[0].canteen_id = 90
    settleProductionWork(tables, foreign, T, policy)
    settleProductionWork(tables, foreign, T + 1000, policy)
    assert.equal(foreign.pets[0].work_pause, true)
    assert.equal(foreign.pets[0].canteen_id, 90)
    eq(entry(foreign).progress, 0)
})

test('unpriced legacy work preserves unknown feeding pause and pure due rejects damaged typed state without mutation', () => {
    const state = fixture({ count: 1 })
    job(state).productId = 0xffffffff
    state.pets[0].work_pause = true
    state.pets[0].canteen_id = 90
    settleProductionWork(tables, state, T, policy)
    assert.equal(entry(state).legacyUnpriced, true)
    assert.equal(entry(state).pauseReason, 'foreign-pause')
    settleProductionWork(tables, state, T + 1000, policy)
    eq(entry(state).progress, 0)
    assert.equal(state.pets[0].work_pause, true)
    const damaged = structuredClone(state)
    delete damaged.home.productionWork.nextAt
    const before = structuredClone(damaged)
    assert.throws(
        () => productionWorkDue(tables, damaged, T + 1000, policy),
        (error) => error.code === ErrorCode.GameConfig,
    )
    assert.deepEqual(damaged, before)
    assert.equal(productionWorkDue(tables, state, T - 1, policy), false)
})

test('queued epochs do not advance or eat before their turn, and policy changes do not reprice accepted jobs', () => {
    const state = fixture({ balance: 60, count: 1 }),
        seconds = job(state).seconds
    state.home.productionJobs[1].push({ ...structuredClone(job(state)), guid: 2, start: T + seconds })
    settleProductionWork(tables, state, T, policy)
    const second = state.home.productionJobs[1][1]
    const epoch = second.workEpoch
    eq(state.home.productionWork.jobs[epoch].progress, 0)
    reconcileProductionWork(tables, state, T, { ...policy, policyId: 'review-next', unitBudgetMultiplier: 2 })
    assert.equal(state.home.productionWork.jobs[epoch].budget, 20)
    settleProductionWork(tables, state, T + seconds, policy)
    eq(state.home.productionWork.jobs[epoch].progress, 0)
    settleProductionWork(tables, state, T + seconds * 2, policy)
    assert.equal(state.home.productionJobs[1][1].workCompleted, 1)
    eq(state.home.productionWork.stats.spent, 40)
})

test('excluded hatch blocks its mixed queue without a fee or rewritten hatch progress', () => {
    const state = fixture({ balance: 60, count: 1 })
    const hatch = { guid: 7, productId: 0, count: 1, claimed: 0, kind: 'hatch', start: T, seconds: 50 }
    job(state).start = T + 50
    state.home.productionJobs[1].unshift(hatch)
    settleProductionWork(tables, state, T, policy)
    settleProductionWork(tables, state, T + 49, policy)
    const ordinary = state.home.productionJobs[1][1]
    eq(state.home.productionWork.jobs[ordinary.workEpoch].progress, 0)
    assert.deepEqual(state.home.productionJobs[1][0], hatch)
    eq(state.home.productionWork.stats.spent, 0)
    settleProductionWork(tables, state, T + 50, policy)
    eq(state.home.productionWork.jobs[ordinary.workEpoch].progress, 0)
    assert.equal(state.home.productionJobs[1][0].workEpoch, undefined)
})

test('unknown policy semantics fail closed, malformed shape is configuration failure, and narrower scope retains old epochs', () => {
    const variants = {
        feeBasis: 'on-claim',
        eligibility: 'remaining-piece',
        refillTarget: 'full-cap',
        recoveryCap: 'global-max',
        foodSelection: 'random',
        overflow: 'refund',
        insufficientFood: 'eat-anyway',
        history: 'backcharge',
        feedingDurationSeconds: 2,
        newFoodRetroactive: true,
        foodTieBreak: ['item-id', 'canteen-guid'],
        scope: ['farm'],
    }
    for (const [key, value] of Object.entries(variants)) {
        const state = fixture(),
            snapshot = structuredClone(state)
        assert.throws(
            () => settleProductionWork(tables, state, T, { ...policy, [key]: value }),
            (error) => error.code === ErrorCode.FunctionClosed,
            key,
        )
        assert.deepEqual(state, snapshot)
    }
    for (const invalid of [
        { foodSelection: null },
        { foodTieBreak: null },
        { newFoodRetroactive: 1 },
        { feedingDurationSeconds: -1 },
    ]) {
        const state = fixture(),
            snapshot = structuredClone(state)
        assert.throws(
            () => productionWorkDue(tables, state, T, { ...policy, ...invalid }),
            (error) => error.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(state, snapshot)
    }
    const state = fixture({ count: 1 }),
        seconds = job(state).seconds
    settleProductionWork(tables, state, T, policy)
    const epoch = job(state).workEpoch,
        narrowed = { ...policy, scope: ['cook'] }
    reconcileProductionWork(tables, state, T, narrowed)
    assert.equal(job(state).workEpoch, epoch)
    assert.equal(productionWorkDue(tables, state, T + seconds, narrowed), true)
    settleProductionWork(tables, state, T + seconds, narrowed)
    assert.equal(job(state).workCompleted, 1)
    eq(state.home.productionWork.stats.spent, 20)
})

test('scheduler due wakes each visible unit and the strictly next wire-satiety floor without reducing offline arithmetic horizons', () => {
    const state = fixture({ balance: 60, count: 3 }),
        seconds = job(state).seconds
    settleProductionWork(tables, state, T, policy)
    assert.equal(state.home.productionWork.nextAt, T + 1)
    assert.equal(productionWorkDue(tables, state, T, policy), false)
    assert.equal(productionWorkDue(tables, state, T + 1, policy), true)
    settleProductionWork(tables, state, T + 1, policy)
    const nextDrop = T + Math.floor(seconds / 20) + 1
    assert.equal(state.home.productionWork.nextAt, nextDrop)
    assert.equal(productionWorkDue(tables, state, nextDrop - 1, policy), false)
    assert.equal(productionWorkDue(tables, state, nextDrop, policy), true)
    const unmanned = fixture({ worker: false, count: 3 }),
        one = job(unmanned).seconds
    settleProductionWork(tables, unmanned, T, policy)
    assert.equal(unmanned.home.productionWork.nextAt, T + one)
    // One settlement still crosses all three unit boundaries in a batch.
    settleProductionWork(tables, unmanned, T + one * 3, policy)
    assert.equal(job(unmanned).workCompleted, 3)
})

test('real Game.tick observes half-unit wire balance and the next completed unit through pure productionWorkDue', () => {
    const f = productionWorkGameFixture('work-engine-visible-tick', { satiety: 2 })
    try {
        f.start(2)
        assert.equal(f.job().seconds, 2)
        assert.equal(productionWorkDue(f.tables, f.state(), f.now(), f.policy), false)
        assert.equal(productionWorkDue(f.tables, f.state(), f.now() + 1, f.policy), true)
        const first = f.advance(1)
        assert.equal(f.pet().satiety_val, 1)
        assert(first.some((packet) => packet.id === 6517))
        assert.equal(f.job().workCompleted, 0)
        f.advance(1)
        assert.equal(f.job().workCompleted, 1)
    } finally {
        f.close()
    }
})
