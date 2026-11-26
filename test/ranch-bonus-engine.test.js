import test from 'node:test'
import assert from 'node:assert/strict'
import { ranchBonusFixture, ranchProduction, earnRanchPending } from './ranch-bonus-fixture.js'
import { settleRanches, ranchDue, drainRanchPending } from '../src/ranch.js'
import { validateRanchBonus } from '../src/ranch-bonus.js'
import { ErrorCode } from '../src/error-codes.js'

function engine(name, technologies) {
    const f = ranchBonusFixture(name)
    f.technologies(technologies)
    f.assign()
    let state = f.state(),
        now = f.now(),
        random = () => 0
    const produced = []
    return {
        f,
        get state() {
            return state
        },
        get ranch() {
            return state.home.ranches[201]
        },
        get now() {
            return now
        },
        produced,
        roll(fn) {
            random = fn
        },
        step(clear = true, seconds = ranchProduction(f).period) {
            now += seconds
            settleRanches(f.tables, state, now, random)
            const ranch = state.home.ranches[201]
            produced.push(...ranch.drops.filter((row) => row.bonus_source))
            if (clear) ranch.drops = [] // Pure engine free-room control, not a pickup/Game claim.
            return ranch
        },
        replace(value) {
            state = value
        },
        close() {
            f.close()
        },
    }
}
test('all four actual technology definitions follow committed current HomeDrop unit thresholds and descendant II overrides both I inputs', () => {
    for (const [id, kind, threshold] of [
        [2007701, 3006, 60],
        [2204801, 3006, 40],
        [2008201, 3005, 200],
        [2011301, 3005, 140],
    ]) {
        const e = engine('ranch-four-' + id, [id])
        try {
            for (let i = 0; i < threshold / ranchProduction(e.f).units; i++) e.step()
            assert.equal(e.produced.length, 1, String(id))
            assert.equal(e.produced[0].bonus_source.technologyId, id)
            assert.equal(e.ranch.bonus.families[kind].creditUnits, 0)
            assert.equal(e.ranch.bonus.families[kind].lastThreshold, threshold)
            assert(e.produced[0].pet_guid === e.f.pets[0])
        } finally {
            e.close()
        }
    }
    const e = engine('ranch-both-tiers', [2007701, 2204801, 2008201, 2011301])
    try {
        for (let i = 0; i < 140 / ranchProduction(e.f).units; i++) e.step()
        assert(e.produced.every((row) => [2204801, 2011301].includes(row.bonus_source.technologyId)))
        assert.equal(e.produced.filter((row) => row.bonus_source.family === 3005).length, 1)
        assert.equal(e.produced.filter((row) => row.bonus_source.family === 3006).length, 3)
    } finally {
        e.close()
    }
})
test('all nine weighted surprise outputs and original78-position material pool preserve type10 and the unmapped360005 entry', () => {
    const initial = engine('ranch-output-matrix', [])
    try {
        const starting = initial.state
        for (const [technology, maximum, picks] of [
            [
                2008201,
                2620,
                [
                    [0, 1051],
                    [1000, 1052],
                    [1500, 1053],
                    [2500, 1054],
                ],
            ],
            [
                2011301,
                2160,
                [
                    [0, 1055],
                    [1000, 1056],
                    [1500, 1057],
                    [2000, 1058],
                    [2100, 1059],
                ],
            ],
        ]) {
            for (const [pick, expected] of picks) {
                const state = structuredClone(starting),
                    row = initial.f.tables.find('home_technology', technology)
                state.home.technology.levels[row.type] = { level: 1 }
                let now = initial.now,
                    found
                for (
                    let i = 0;
                    i < (technology === 2008201 ? 200 : 140) / ranchProduction(initial.f).units && !found;
                    i++
                ) {
                    now += ranchProduction(initial.f).period
                    settleRanches(initial.f.tables, state, now, (max) => (max === maximum ? pick : 0))
                    found = state.home.ranches[201].drops.find((drop) => drop.bonus_source)
                    state.home.ranches[201].drops = []
                }
                assert.equal(found?.drop_id, expected)
                if ([1052, 1056].includes(expected))
                    assert.deepEqual(found.item, { itemtype: 10, itemid: 103, itemnum: expected === 1052 ? 500 : 5000 })
            }
        }
        const state = structuredClone(starting)
        state.home.technology.levels[20077] = { level: 1 }
        let now = initial.now,
            found
        for (let i = 0; i < 60 / ranchProduction(initial.f).units; i++) {
            now += ranchProduction(initial.f).period
            settleRanches(initial.f.tables, state, now, (max) => (max === 78 ? 16 : 0))
            found ??= state.home.ranches[201].drops.find((drop) => drop.bonus_source)
            state.home.ranches[201].drops = []
        }
        assert.equal(found.item.itemid, 360005)
        assert.equal(found.drop_id, 1050)
        assert.equal(
            initial.f.tables.get('home_item_model').some((row) => row.itemType === 3 && row.itemId === 360005),
            false,
        )
    } finally {
        initial.close()
    }
})
test('last base floor slot seals two complete pending instances; no worker still drains from real table room and shallow base stays unchanged', () => {
    const f = ranchBonusFixture('ranch-two-pending')
    try {
        const pending = earnRanchPending(f),
            state = f.state(),
            ranch = state.home.ranches[201],
            now = f.now()
        assert(pending.every((row) => row.pet_guid === f.pets[0] && [1050, 1055].includes(row.drop_id)))
        ranch.product_pets = [] // Pure drainage boundary; actual worker-removal contract is tested through6162 elsewhere.
        assert.equal(ranchDue(f.tables, state, now), false)
        ranch.drops.shift()
        const before = structuredClone(state),
            draft = { ...state }
        assert.equal(ranchDue(f.tables, draft, now), true)
        const result = drainRanchPending(f.tables, draft, draft.home.ranches[201], now)
        assert.equal(result.movedGuids.length, 1)
        assert.deepEqual(state, before)
        assert.equal(draft.home.ranches[201].drops.at(-1).guid, pending[0].guid)
        assert.deepEqual(draft.home.ranches[201].drops.at(-1).item, pending[0].item)
        assert.equal(draft.home.ranches[201].bonus.pendingBonus[0].guid, pending[1].guid)
        assert.equal(ranchDue(f.tables, draft, now), false)
    } finally {
        f.close()
    }
})

test('pre-bonus current windows settle before adoption; future units and upgrade credit retain exact integer quantities', () => {
    const e = engine('ranch-adoption-upgrade', [2007701])
    try {
        delete e.ranch.bonus
        const spec = ranchProduction(e.f),
            cutoff = e.now + spec.period
        settleRanches(e.f.tables, e.state, cutoff, () => 0)
        assert.equal(e.ranch.bonus.adoptedAt, cutoff)
        assert.equal(e.ranch.bonus.families[3006].creditUnits, 0)
        assert.equal(e.ranch.drops.length, spec.rows.length)
        e.ranch.drops = []
        const oldThreshold = 60,
            nextThreshold = 40,
            credit = (oldThreshold + nextThreshold) / 2,
            beforeCycles = credit / spec.units
        assert(Number.isInteger(beforeCycles))
        for (let i = 1; i <= beforeCycles; i++) {
            settleRanches(e.f.tables, e.state, cutoff + i * spec.period, () => 0)
            e.ranch.drops = []
        }
        assert.equal(e.ranch.bonus.families[3006].creditUnits, credit)
        e.state.home.technology.levels[22048] = { level: 1 }
        settleRanches(e.f.tables, e.state, cutoff + beforeCycles * spec.period, () => 0)
        assert.equal(e.ranch.bonus.families[3006].creditUnits, credit)
        assert.equal(e.ranch.bonus.pendingBonus.length, 0)
        settleRanches(e.f.tables, e.state, cutoff + (beforeCycles + 1) * spec.period, () => 0)
        assert.equal(e.ranch.bonus.families[3006].creditUnits, credit + spec.units - nextThreshold)
        assert.equal(e.ranch.drops.filter((row) => row.bonus_source).length, 1)
        const valid = structuredClone(e.ranch)
        for (const mutate of [
            (row) => {
                row.bonus.pendingBonus = null
            },
            (row) => {
                row.bonus.families[3006].creditUnits = 9999
            },
            (row) => {
                row.nextDropGuid = 1
            },
        ]) {
            const bad = structuredClone(valid)
            mutate(bad)
            assert.throws(() => validateRanchBonus(e.f.tables, bad), { code: ErrorCode.GameConfig })
        }
    } finally {
        e.close()
    }
})
