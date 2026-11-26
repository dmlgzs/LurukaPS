import test from 'node:test'
import assert from 'node:assert/strict'
import { Tables } from '../src/player.js'
import { configuration } from '../src/config.js'
import { ErrorCode } from '../src/error-codes.js'
import {
    ranchBonusCatalog,
    adoptRanchBonus,
    validateRanchBonus,
    recordRanchBaseCommit,
    reserveRanchDropGuid,
} from '../src/ranch-bonus.js'
import { ensureRanches } from '../src/ranch.js'
import { ranchFixture } from './ranch-fixture.js'

const tables = new Tables(configuration().tables)
const data = ranchBonusCatalog(tables)
function fixture() {
    const state = { home: { technology: { levels: { 20077: { level: 1 } } } } }
    const historical = data.baseDrops.get(12033)
    const ranch = {
        nextDropGuid: 2,
        drops: [
            {
                guid: 1,
                pet_guid: '1',
                drop_id: 12033,
                item: { itemtype: historical.itemType, itemid: Number(historical.itemId), itemnum: 2 },
            },
        ],
        claimedRewardGuids: [],
    }
    adoptRanchBonus(tables, state, ranch, 100)
    return { state, ranch }
}
function fact(ranch, row, itemnum = row.minValue) {
    const base = {
        guid: reserveRanchDropGuid(ranch),
        pet_guid: '1',
        drop_id: row.id,
        item: { itemtype: row.itemType, itemid: Number(row.itemId), itemnum },
    }
    ranch.drops.push(base)
    return base
}

test('all 58 current base streams derive their quantities from current HomeDrop min/max', () => {
    assert.equal(data.baseDrops.size, 58)
    assert.equal(data.maximumBaseQuantity, 3)
    assert.deepEqual([...new Set([...data.baseDrops.values()].map((row) => row.minValue))].sort(), [1, 3])
    for (const row of data.baseDrops.values()) {
        const { state, ranch } = fixture()
        const oldDrop = structuredClone(ranch.drops[0])
        assert.equal(
            recordRanchBaseCommit(tables, state, ranch, fact(ranch, row), 101, () => 0),
            true,
        )
        assert.equal(ranch.bonus.families[3006].creditUnits, row.minValue)
        assert.deepEqual(ranch.drops[0], oldDrop)
        assert.equal(validateRanchBonus(tables, ranch), ranch.bonus)
    }
})

test('existing credits cross thresholds using actual item units and sealed pending bonuses remain intact', () => {
    const row = [...data.baseDrops.values()].find((entry) => entry.minValue === 3)
    const { state, ranch } = fixture()
    ranch.bonus.families[3006].creditUnits = 58
    ranch.bonus.families[3006].lastThreshold = 60
    recordRanchBaseCommit(tables, state, ranch, fact(ranch, row), 101, () => 0)
    assert.equal(ranch.bonus.families[3006].creditUnits, 1)
    assert.equal(ranch.bonus.pendingBonus.length, 1)
    const before = structuredClone(ranch)
    validateRanchBonus(tables, ranch)
    assert.deepEqual(ranch, before)
    const loaded = JSON.parse(JSON.stringify(ranch))
    validateRanchBonus(tables, loaded)
    assert.deepEqual(loaded.bonus.pendingBonus, before.bonus.pendingBonus)
})

test('committed amounts and item identities must agree with their actual base drop source', () => {
    const row = [...data.baseDrops.values()].find((entry) => entry.minValue === 3)
    for (const change of [
        (base) => {
            base.item.itemnum = 2
        },
        (base) => {
            base.item.itemnum = 0
        },
        (base) => {
            base.item.itemid = 0
        },
        (base) => {
            base.drop_id = 99999999
        },
    ]) {
        const { state, ranch } = fixture(),
            base = fact(ranch, row)
        change(base)
        assert.throws(
            () => recordRanchBaseCommit(tables, state, ranch, base, 101, () => 0),
            (error) => error.code === ErrorCode.GameConfig,
        )
    }
})

test('real6162 current clocks preserve sealed historical quantity2 and labor while earning only current new output units', () => {
    const f = ranchFixture('ranch-current-base-quantity')
    let oldDrop
    try {
        f.store.transact(f.session.id, 0, (state) => {
            ensureRanches(f.tables, state)
            const ranch = state.home.ranches[201],
                row = data.baseDrops.get(12033),
                worker = state.pets.find((pet) => pet.guid === f.pets[0]),
                technology = tables.find('home_technology', 2007701)
            assert.equal(ranch.bonus, undefined)
            state.player.basic_info.lv = 55 // Trusted saved research prerequisite, not claimed earned play.
            state.home.technology.levels[technology.type] = { level: technology.level, lastTime: 0, isOpened: true }
            worker.labor_infos = [{ labor_id: 3, labor_grade: 20, upper_labor_grade: 40, labor_exp: 0 }]
            oldDrop = {
                guid: ranch.nextDropGuid++,
                pet_guid: worker.guid,
                drop_id: row.id,
                item: { itemtype: row.itemType, itemid: Number(row.itemId), itemnum: 2 },
            }
            ranch.drops.push(structuredClone(oldDrop)) // Explicit historical sealed fact; no old recipe/RNG executes.
        })
        const labor = structuredClone(f.state().pets.find((pet) => pet.guid === f.pets[0]).labor_infos)
        f.assign() // Actual current6162 factory, not a hand-written or manually marked current clock.
        const clocks = structuredClone(f.state().home.ranches[201].product_pets[0].drop_times)
        assert.equal(f.state().home.ranches[201].product_pets[0].clockMigration.source, 'current')
        f.elapse(f.productionPeriod())
        f.tick()
        const after = f.state().home.ranches[201],
            produced = after.drops.filter((drop) => drop.guid !== oldDrop.guid)
        assert.deepEqual(
            after.drops.find((drop) => drop.guid === oldDrop.guid),
            oldDrop,
        )
        assert.equal(produced.length, clocks.length)
        for (const drop of produced) assert.equal(drop.item.itemnum, tables.find('home_drop', drop.drop_id).minValue)
        assert.equal(
            after.bonus.families[3006].creditUnits,
            produced.reduce((n, drop) => n + drop.item.itemnum, 0),
        )
        assert(after.product_pets[0].drop_times.every((clock) => clock.time > f.now()))
        assert.deepEqual(f.state().pets.find((pet) => pet.guid === f.pets[0]).labor_infos, labor)
    } finally {
        f.close()
    }
})
