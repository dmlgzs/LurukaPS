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
import { settleRanches } from '../src/ranch.js'

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

test('settlement preserves saved pending clocks, old quantity-two drops and labor while producing the current table quantity', () => {
    const source = {
        get: (name) => (name === 'home_block' ? [] : tables.get(name)),
        find: (name, id) => tables.find(name, id),
    }
    const row = data.baseDrops.get(12033)
    const { state, ranch } = fixture()
    Object.assign(ranch, {
        guid: 9,
        block_id: 201,
        lv: 1,
        harvest_pet: '0',
        eggs: [],
        stores: [],
        product_pets: [{ slot: 1, pet_guid: '1', drop_times: [{ drop_id: row.id, time: 101, seconds: row.dropTime }] }],
    })
    state.home.ranches = { 201: ranch }
    state.pets = [
        {
            guid: '1',
            config_id: 500001,
            work_status: 6,
            work_build: 201,
            satiety_val: 60,
            labor_infos: [{ labor_id: 3, labor_grade: 20, upper_labor_grade: 20, labor_exp: 0 }],
        },
    ]
    const labor = structuredClone(state.pets[0].labor_infos),
        oldDrop = structuredClone(ranch.drops[0])
    settleRanches(source, state, 101, () => 0)
    const after = state.home.ranches[201]
    assert.deepEqual(after.drops[0], oldDrop)
    assert.equal(after.drops[1].item.itemnum, row.minValue)
    assert.equal(after.bonus.families[3006].creditUnits, row.minValue)
    assert.equal(after.product_pets[0].drop_times[0].time, 101 + row.dropTime)
    assert.deepEqual(state.pets[0].labor_infos, labor)
})
