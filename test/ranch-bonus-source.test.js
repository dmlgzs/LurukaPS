import test from 'node:test'
import assert from 'node:assert/strict'
import { ranchBonusFixture, ranchBonusFile } from './ranch-bonus-fixture.js'
import { readHomeCurrencyAcquisition } from '../src/home-currency-acquisition.js'
import { ErrorCode } from '../src/error-codes.js'

const ranch = (f) => f.state().home.ranches[201]
const coins = (f) => BigInt(f.state().player.attr_infos.attrs.find((row) => row.attr_id === 103)?.attr_val ?? '0')
// Real ordinary dispatch pre-settlement, independently of the pending-only tick hook.
const produce = (f) => f.call('ActivityGet')
function collect(f, keepCurrency = false) {
    const observed = []
    for (let i = 0; i < 4; i++) {
        const drops = ranch(f).drops.filter((row) => !keepCurrency || row.item.itemtype !== 10)
        if (!drops.length) return observed
        observed.push(...drops)
        f.call('RanchPlayerGetReward', { block_id: 201, reward_guids: drops.map((row) => row.guid) })
    }
    throw Error('Unexpected unbounded post-pickup production')
}
function cycles(f, count, keepCurrency = false) {
    const observed = []
    for (let i = 0; i < count; i++) {
        f.elapse(360)
        produce(f)
        observed.push(...collect(f, keepCurrency))
    }
    return observed
}
function earnTwoPending(f) {
    f.technologies([2204801, 2011301])
    f.assign()
    for (let i = 1; i <= 70; i++) {
        f.elapse(360)
        produce(f)
        if (i <= 61) collect(f)
    }
    assert.equal(ranch(f).drops.length, 18)
    assert.equal(ranch(f).bonus.pendingBonus.length, 2)
    return structuredClone(ranch(f).bonus.pendingBonus)
}

test('real6162 and ordinary Game settlement support all four current technologies and I+II through actual6160 claims', () => {
    for (const [ids, periodCount, expected] of [
        [[2007701], 15, [[3006, 2007701, 1]]],
        [[2204801], 10, [[3006, 2204801, 1]]],
        [[2008201], 50, [[3005, 2008201, 1]]],
        [[2011301], 35, [[3005, 2011301, 1]]],
        [
            [2007701, 2204801, 2008201, 2011301],
            35,
            [
                [3005, 2011301, 1],
                [3006, 2204801, 3],
            ],
        ],
    ]) {
        const f = ranchBonusFixture('ranch-real-family-' + ids.join('-'))
        try {
            f.technologies(ids)
            f.assign()
            const observed = cycles(f, periodCount),
                base = observed.filter((row) => !row.bonus_source),
                bonus = observed.filter((row) => row.bonus_source)
            assert.equal(base.length, periodCount * 2)
            assert(base.every((row) => row.item.itemnum === 2))
            for (const [kind, technologyId, count] of expected)
                assert.equal(
                    bonus.filter(
                        (row) => row.bonus_source.family === kind && row.bonus_source.technologyId === technologyId,
                    ).length,
                    count,
                )
            assert.equal(
                bonus.length,
                expected.reduce((sum, row) => sum + row[2], 0),
            )
            assert.equal(new Set(observed.map((row) => row.guid)).size, observed.length)
        } finally {
            f.close()
        }
    }
})
test('actual1052/1056 production stores500/5000 without credit, then6163 grants currency and normal acquisition exactly once', () => {
    for (const [technology, maximum, periods, dropId, amount] of [
        [2008201, 2620, 50, 1052, 500],
        [2011301, 2160, 35, 1056, 5000],
    ]) {
        const f = ranchBonusFixture('ranch-real-currency-' + dropId)
        try {
            f.technologies([technology])
            f.assign()
            f.harvestWorker()
            const before = coins(f),
                acquired = readHomeCurrencyAcquisition(f.state())
            f.setRoll((max) => (max === maximum ? 1000 : 0))
            cycles(f, periods, true)
            const drop = ranch(f).drops.find((row) => row.bonus_source)
            assert.equal(drop.drop_id, dropId)
            assert.deepEqual(drop.item, { itemtype: 10, itemid: 103, itemnum: amount })
            assert.equal(coins(f), before)
            assert.equal(readHomeCurrencyAcquisition(f.state()), acquired)
            f.call('RanchPetAutoGetReward', { block_id: 201, reward_guid: drop.guid })
            f.call('RanchPetAutoGetReward', { block_id: 201, reward_guid: drop.guid })
            assert.equal(coins(f), before)
            assert.equal(readHomeCurrencyAcquisition(f.state()), acquired)
            assert.deepEqual(ranch(f).stores, [{ itemtype: 10, itemid: 103, itemnum: amount }])
            const packets = f.call('RanchGetStoreReward', { u32: 201 })
            assert.equal(coins(f), before + BigInt(amount))
            assert.equal(readHomeCurrencyAcquisition(f.state()), acquired + BigInt(amount))
            const ack = f.protocol.decode('Rewards', packets.find((row) => row.id === 6163).payload)
            assert(ack.rewards.some((row) => row.itemtype === 10 && row.itemid === 103 && row.itemnum === amount))
            assert.throws(() => f.call('RanchGetStoreReward', { u32: 201 }), { code: ErrorCode.HomeRanchStoreIsNull })
        } finally {
            f.close()
        }
    }
})
test('full last slot seals two bonuses; real worker removal and6160 release drain exact sources in the same transaction', () => {
    const temp = ranchBonusFile(),
        f = ranchBonusFixture('ranch-real-pending', { file: temp.file })
    try {
        const pending = earnTwoPending(f)
        assert(pending.every((row) => row.pet_guid === f.pets[0]))
        f.call('RanchSetPetOption', { block_id: 201, slot: 1, pet_guid: '0', work_type: 1, out_hub: true })
        assert.deepEqual(ranch(f).product_pets, [])
        f.reopen()
        assert.deepEqual(ranch(f).bonus.pendingBonus, pending)
        f.setRoll(() => {
            throw Error('A sealed reward must never reroll')
        })
        const guid = ranch(f).drops[0].guid
        const packets = f.call('RanchPlayerGetReward', { block_id: 201, reward_guids: [guid] })
        assert.equal(ranch(f).drops.length, 18)
        assert.equal(ranch(f).bonus.pendingBonus.length, 1)
        const published = ranch(f).drops.find((row) => row.guid === pending[0].guid)
        assert.deepEqual(
            { guid: published.guid, pet_guid: published.pet_guid, drop_id: published.drop_id, item: published.item },
            {
                guid: pending[0].guid,
                pet_guid: pending[0].pet_guid,
                drop_id: pending[0].drop_id,
                item: pending[0].item,
            },
        )
        assert(packets.findIndex((row) => row.id === 6102) < packets.findIndex((row) => row.id === 6160))
        f.call('RanchPlayerGetReward', { block_id: 201, reward_guids: [guid] })
        assert.equal(ranch(f).bonus.pendingBonus.length, 1)
        f.reopen()
        assert.equal(ranch(f).bonus.pendingBonus[0].guid, pending[1].guid)
    } finally {
        try {
            f.close()
        } finally {
            temp.close()
        }
    }
})
test('source generation and post-pickup drain rollback pending references and SQLite on codec or save failure, then commit once', () => {
    const temp = ranchBonusFile(),
        f = ranchBonusFixture('ranch-real-atomic', { file: temp.file })
    let encode
    try {
        const sealed = earnTwoPending(f)
        const oldState = f.state(),
            pending = { state: oldState, revision: f.store.load(f.session.id).revision }
        f.store.pending.set(f.session.id, pending)
        const beforeSql = f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
            baseHome = oldState.home,
            baseBonus = oldState.home.ranches[201].bonus
        const request = () =>
            f.call('RanchPlayerGetReward', { block_id: 201, reward_guids: [oldState.home.ranches[201].drops[0].guid] })
        encode = f.protocol.encode
        f.protocol.encode = function (type, ...args) {
            if (type === f.protocol.byId.get(6102).rsp) throw Error('ranch-bonus-codec')
            return encode.call(this, type, ...args)
        }
        assert.throws(request, /ranch-bonus-codec/)
        assert.strictEqual(f.store.pending.get(f.session.id), pending)
        assert.strictEqual(pending.state.home, baseHome)
        assert.strictEqual(pending.state.home.ranches[201].bonus, baseBonus)
        assert.deepEqual(baseBonus.pendingBonus, sealed)
        assert.deepEqual(
            f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
            beforeSql,
        )
        f.protocol.encode = encode
        f.store.db.exec(
            "CREATE TRIGGER ranch_bonus_abort BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'ranch-bonus-sql'); END",
        )
        assert.throws(request, /ranch-bonus-sql/)
        assert.strictEqual(f.store.pending.get(f.session.id), pending)
        assert.deepEqual(
            f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
            beforeSql,
        )
        f.store.db.exec('DROP TRIGGER ranch_bonus_abort')
        request()
        assert.equal(ranch(f).bonus.pendingBonus.length, 1)
        assert.equal(ranch(f).drops.filter((row) => row.guid === sealed[0].guid).length, 1)
    } finally {
        if (encode) f.protocol.encode = encode
        f.store.db.exec('DROP TRIGGER IF EXISTS ranch_bonus_abort')
        try {
            f.close()
        } finally {
            temp.close()
        }
    }
})
test('legacy overdue windows receive no bonus history and long offline sampling stays bounded; failures never add committed units', () => {
    const f = ranchBonusFixture('ranch-real-legacy-offline')
    try {
        f.technologies([2007701])
        f.assign()
        f.edit((state) => {
            delete state.home.ranches[201].bonus
        })
        f.elapse(360)
        produce(f)
        assert.equal(ranch(f).bonus.adoptedAt, f.now())
        assert.equal(ranch(f).bonus.families[3006].creditUnits, 0)
        collect(f)
        f.setRoll((max) => max - 1)
        f.elapse(360)
        produce(f)
        assert.equal(ranch(f).bonus.families[3006].creditUnits, 0)
        assert.equal(ranch(f).drops.length, 0)
        let samples = 0
        f.setRoll(() => {
            samples++
            return 0
        })
        f.elapse(10 * 365 * 86400)
        produce(f)
        assert(samples < 100)
        assert(
            ranch(f).drops.length <=
                f.tables.get('home_ranch').find((row) => row.level === ranch(f).lv).petProductLimit,
        )
        assert(ranch(f).bonus.pendingBonus.length <= 2)
        assert(ranch(f).product_pets.every((row) => row.drop_times.every((clock) => clock.time > f.now())))
    } finally {
        f.close()
    }
})
