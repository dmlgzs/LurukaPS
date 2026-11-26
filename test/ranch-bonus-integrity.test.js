import { readTable } from '../src/table-source.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { ranchBonusFixture, ranchProduction } from './ranch-bonus-fixture.js'
import { ranchStoreItems } from '../src/ranch-items.js'
import { ErrorCode } from '../src/error-codes.js'
import { selectedRanchBonuses } from '../src/ranch-bonus.js'
import { ranchStoredSlots } from '../src/ranch-claims.js'

test('pure typed projection keeps colliding numeric IDs separate by namespace', () => {
    // Controlled namespace collision, not an asserted current currency ID or grant.
    const tables = { find: (_name, id) => ({ id }) }
    assert.deepEqual(
        ranchStoreItems(tables, [
            { itemtype: 3, itemid: 1000008, itemnum: 2 },
            { itemtype: 10, itemid: 1000008, itemnum: 500 },
            { itemtype: 10, itemid: 1000008, itemnum: 5000 },
        ]),
        [
            { itemtype: 3, itemid: 1000008, itemnum: 2 },
            { itemtype: 10, itemid: 1000008, itemnum: 5500 },
        ],
    )
})
test('managed schema and exhausted original drop allocator reject actual production without advancing clocks or base pending references', () => {
    const f = ranchBonusFixture('ranch-managed-integrity')
    try {
        f.technologies([2007701])
        f.assign()
        const valid = f.state().home.ranches[201].bonus
        for (const mutate of [
            (ranch) => {
                ranch.bonus = null
            },
            (ranch) => {
                ranch.bonus.pendingBonus = [null]
            },
            (ranch) => {
                ranch.bonus.families[3006].creditUnits = 9999
            },
        ]) {
            f.edit((state) => {
                const ranch = state.home.ranches[201]
                ranch.bonus = structuredClone(valid)
                mutate(ranch)
            })
            const before = f.store.load(f.session.id)
            assert.throws(() => f.call('HomeTechnologyTypeInfo', { type: 1 }), { code: ErrorCode.GameConfig })
            assert.deepEqual(f.store.load(f.session.id), before)
        }
        f.edit((state) => {
            state.home.ranches[201].bonus = structuredClone(valid)
            state.home.ranches[201].nextDropGuid = 0x100000000
        })
        const old = f.store.load(f.session.id),
            pending = { state: old.state, revision: old.revision }
        f.store.pending.set(f.session.id, pending)
        const row = () => f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
            sql = row()
        f.elapse(ranchProduction(f).period)
        assert.throws(() => f.call('HomeTechnologyTypeInfo', { type: 1 }), { code: ErrorCode.InvalidLogic })
        assert.strictEqual(f.store.pending.get(f.session.id), pending)
        assert.deepEqual(f.store.load(f.session.id), old)
        assert.deepEqual(row(), sql)
    } finally {
        f.close()
    }
})
test('a real produced currency drop survives a controlled full-current-capacity warehouse rejection without being granted or removed', () => {
    const f = ranchBonusFixture('ranch-full-typed-warehouse')
    try {
        f.technologies([2008201])
        f.assign()
        f.harvestWorker()
        f.setRoll((maximum) => (maximum === 2620 ? 1000 : 0))
        const spec = ranchProduction(f),
            definition = selectedRanchBonuses(f.tables, f.state()).get(3005)
        f.elapse(spec.period * Math.ceil(definition.threshold / spec.units))
        f.tick()
        const drop = f.state().home.ranches[201].drops.find((item) => item.item.itemtype === 10)
        assert.equal(drop.drop_id, 1052)
        const definitions = readTable('common_item')
        // Import boundary for capacity only: this is a valid typed stack, not
        // a claim that the current ranch pool can earn999 distinct warehouse rows.
        const limit = f.tables
                .get('home_ranch')
                .find((row) => row.level === f.state().home.ranches[201].lv).storageLimit,
            stacked = definitions.find((item) => item.stackNum > 0),
            stores = [{ itemtype: 3, itemid: stacked.id, itemnum: stacked.stackNum * limit }]
        assert.equal(ranchStoredSlots(stores, f.tables), limit)
        f.edit((state) => {
            state.home.ranches[201].stores = stores
        })
        const before = f.store.load(f.session.id)
        assert.throws(() => f.call('RanchPetAutoGetReward', { block_id: 201, reward_guid: drop.guid }), {
            code: ErrorCode.BagItemFull,
        })
        assert.deepEqual(f.store.load(f.session.id), before)
    } finally {
        f.close()
    }
})
