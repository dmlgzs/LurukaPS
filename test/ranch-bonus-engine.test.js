import test from 'node:test'
import assert from 'node:assert/strict'
import { ranchBonusFixture } from './ranch-bonus-fixture.js'
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
        step(clear = true, seconds = 360) {
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
test('all four actual technology definitions follow committed quantity2 thresholds and descendant II overrides both I inputs', () => {
    for (const [id, kind, threshold] of [
        [2007701, 3006, 60],
        [2204801, 3006, 40],
        [2008201, 3005, 200],
        [2011301, 3005, 140],
    ]) {
        const e = engine('ranch-four-' + id, [id])
        try {
            for (let i = 0; i < threshold / 4; i++) e.step()
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
        for (let i = 0; i < 35; i++) e.step()
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
                for (let i = 0; i < 50 && !found; i++) {
                    now += 360
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
        for (let i = 0; i < 15; i++) {
            now += 360
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
    const e = engine('ranch-two-pending', [2204801, 2011301])
    try {
        for (let i = 1; i <= 70; i++) e.step(i <= 61)
        assert.equal(e.ranch.drops.length, 18)
        assert.equal(e.ranch.bonus.pendingBonus.length, 2)
        const pending = structuredClone(e.ranch.bonus.pendingBonus)
        assert(pending.every((row) => row.pet_guid === e.f.pets[0] && [1050, 1055].includes(row.drop_id)))
        e.ranch.product_pets = []
        assert.equal(ranchDue(e.f.tables, e.state, e.now), false)
        e.ranch.drops.shift()
        const before = structuredClone(e.state),
            draft = { ...e.state }
        assert.equal(ranchDue(e.f.tables, draft, e.now), true)
        const result = drainRanchPending(e.f.tables, draft, draft.home.ranches[201], e.now)
        assert.equal(result.movedGuids.length, 1)
        assert.deepEqual(e.state, before)
        assert.equal(draft.home.ranches[201].drops.at(-1).guid, pending[0].guid)
        assert.deepEqual(draft.home.ranches[201].drops.at(-1).item, pending[0].item)
        assert.equal(draft.home.ranches[201].bonus.pendingBonus[0].guid, pending[1].guid)
        assert.equal(ranchDue(e.f.tables, draft, e.now), false)
    } finally {
        e.close()
    }
})
test('legacy<=T settles without bonus before adoption; future>T and upgrade credit retain exact integer units', () => {
    const e = engine('ranch-adoption-upgrade', [2007701])
    try {
        delete e.ranch.bonus
        const cutoff = e.now + 360
        settleRanches(e.f.tables, e.state, cutoff, () => 0)
        assert.equal(e.ranch.bonus.adoptedAt, cutoff)
        assert.equal(e.ranch.bonus.families[3006].creditUnits, 0)
        assert.equal(e.ranch.drops.length, 2)
        e.ranch.drops = []
        for (let i = 1; i <= 12; i++) {
            settleRanches(e.f.tables, e.state, cutoff + i * 360, () => 0)
            e.ranch.drops = []
        }
        assert.equal(e.ranch.bonus.families[3006].creditUnits, 48)
        // Make exactly one actual stream succeed: a legal RNG control, no fact injection.
        let stream = 0
        settleRanches(e.f.tables, e.state, cutoff + 13 * 360, (max) =>
            max === 0x100000000 ? (stream++ === 0 ? 0 : max - 1) : 0,
        )
        assert.equal(e.ranch.bonus.families[3006].creditUnits, 50)
        e.ranch.drops = []
        e.state.home.technology.levels[22048] = { level: 1 }
        settleRanches(e.f.tables, e.state, cutoff + 13 * 360, () => 0)
        assert.equal(e.ranch.bonus.families[3006].creditUnits, 50)
        assert.equal(e.ranch.bonus.pendingBonus.length, 0)
        stream = 0
        settleRanches(e.f.tables, e.state, cutoff + 14 * 360, (max) =>
            max === 0x100000000 ? (stream++ === 0 ? 0 : max - 1) : 0,
        )
        assert.equal(e.ranch.bonus.families[3006].creditUnits, 12)
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
