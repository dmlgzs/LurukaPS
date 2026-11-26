import test from 'node:test'
import assert from 'node:assert/strict'
import { ranchBonusFixture, ranchBonusFile } from './ranch-bonus-fixture.js'
import { createPets } from '../src/pets.js'
import { grantRewards } from '../src/rewards.js'
import { ranchPetDrops, ranchSeconds, ensureRanches } from '../src/ranch.js'
import { prepareRanchSlotClocks } from '../src/home-ranch-clock.js'
import { Tables } from '../src/player.js'
import { configuration } from '../src/config.js'
import { ErrorCode } from '../src/error-codes.js'
import { selectedRanchBonuses } from '../src/ranch-bonus.js'
import policy from '../configs/home-production-clock-migration-policy.json' with { type: 'json' }

const origin = 1800000000
const ranch = (f) => f.state().home.ranches[201]
const quantity = (f, id) =>
    f
        .state()
        .player.sbag_infos.items.filter((row) => row.itemid === id)
        .reduce((n, row) => n + row.itemnum, 0)
let sequence = 1000000
function login(f) {
    const entry = f.protocol.byName.get('CSProtoEnterGame')
    return f.game.dispatch(
        {},
        { id: entry.id, seq: sequence++, payload: f.protocol.encode(entry.req, { open_id: f.name }) },
    )
}
function namedFixture(name, options) {
    return Object.assign(ranchBonusFixture(name, options), { name })
}
function unchanged(f, fn, pattern) {
    const before = f.store.load(f.session.id),
        disk = f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id)
    assert.throws(fn, pattern)
    assert.deepEqual(f.store.load(f.session.id), before)
    assert.deepEqual(
        f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
        disk,
    )
}
function installLegacy(f, configId = 500025, time = origin + 1080) {
    let worker, item
    f.edit((state) => {
        ensureRanches(f.tables, state)
        worker = createPets(f.tables, state, configId, 1)[0]
        const historicalTalents = configId === 500518 ? [30070110, 30060110, 30040110] : []
        Object.assign(worker, {
            hero_id: '0',
            roulette_pos: 0,
            work_status: 6,
            work_build: 201,
            capacity_id: 6002,
            talent_id: historicalTalents,
            satiety_val: 100,
            labor_infos:
                configId === 500518
                    ? [2, 5].map((labor_id) => ({ labor_id, labor_grade: 45, upper_labor_grade: 95, labor_exp: 0 }))
                    : [{ labor_id: 5, labor_grade: 20, upper_labor_grade: 40, labor_exp: 0 }],
        })
        state.home.stationPets = [...new Set([...(state.home.stationPets ?? []), worker.guid])]
        const saved = state.home.ranches[201],
            ids = policy.legacyRanchProfiles[configId]
        saved.product_pets = [
            { slot: 1, pet_guid: worker.guid, drop_times: ids.map((drop_id) => ({ drop_id, seconds: 360, time })) },
        ]
        item = { itemtype: 3, itemid: policy.legacyRanchAssets[ids[0]].ids[0], itemnum: 2 }
        // Three possible old successes: guid1 claimed, guid2 stored, guid3 still sealed.
        // Counts are already generated facts, never rolled from an old recipe by this test/runtime.
        saved.drops = [{ guid: 3, pet_guid: worker.guid, drop_id: ids[0], item: { ...item } }]
        saved.stores = [{ ...item }]
        saved.claimedRewardGuids = [1, 2]
        saved.eggs = []
        saved.nextDropGuid = 4
        delete saved.bonus
        grantRewards(f.tables, state, [item])
    })
    return { worker, item }
}

test('current full-spec unique equivalents preserve500025/500518 future work; cross-asset500399 and ambiguities restart without fabricated output', () => {
    const tables = new Tables(configuration().tables),
        now = origin + 900
    for (const configId of [500025, 500518, 500399]) {
        const pet = { config_id: configId },
            rows = ranchPetDrops(tables, pet),
            clocks = policy.legacyRanchProfiles[configId].map((drop_id) => ({
                drop_id,
                seconds: 360,
                time: origin + 1080,
            })),
            slot = { pet_guid: '1', slot: 1, drop_times: structuredClone(clocks) }
        prepareRanchSlotClocks(tables, pet, slot, rows, now, (row) => row.dropTime)
        assert.deepEqual(
            slot.clockMigration.archive.map((row) => row.original),
            clocks,
        )
        assert(slot.drop_times.every((clock) => rows.some((row) => row.id === clock.drop_id)))
        for (const clock of slot.drop_times)
            assert.equal(clock.time, now + clock.seconds * (configId === 500399 ? 1 : 0.5))
        assert(
            slot.clockMigration.archive.every(
                (row) => row.reason === (configId === 500399 ? 'unmatched-restart-current' : 'future-proportional'),
            ),
        )
        const before = structuredClone(slot)
        prepareRanchSlotClocks(tables, pet, slot, rows, now, (row) => row.dropTime)
        assert.deepEqual(slot, before)
    }
    const pet = { config_id: 500025 },
        original = { drop_id: 12032, seconds: 360, time: now + 180 },
        row = tables.find('home_drop', 12033),
        rows = [
            { ...row, id: 900000001 },
            { ...row, id: 900000002 },
        ],
        slot = { slot: 1, pet_guid: '1', drop_times: [{ ...original }] }
    prepareRanchSlotClocks(tables, pet, slot, rows, now, (row) => row.dropTime)
    assert.equal(slot.clockMigration.archive[0].reason, 'ambiguous-current-equivalent')
    assert.deepEqual(slot.clockMigration.archive[0].original, original)
    assert(slot.drop_times.every((clock) => clock.time === now + clock.seconds))
    assert.throws(
        () =>
            prepareRanchSlotClocks(
                tables,
                pet,
                { drop_times: [{ ...original, seconds: 0 }] },
                rows,
                now,
                (row) => row.dropTime,
            ),
        (error) => error.code === ErrorCode.GameConfig,
    )
})

test('real login→6160/6163→tick→cold reopen preserves legitimate old clocks/assets/receipts for both equivalent profiles', () => {
    for (const configId of [500025, 500518]) {
        const temp = ranchBonusFile(),
            f = namedFixture('ranch-clock-current-future-' + configId, { file: temp.file })
        try {
            const { item, worker } = installLegacy(f, configId)
            f.elapse(900)
            const raw = structuredClone(ranch(f)),
                before = quantity(f, item.itemid)
            f.setRoll(() => {
                throw Error('Future migration must not roll production')
            })
            login(f)
            const migrated = ranch(f),
                slot = migrated.product_pets[0]
            assert(slot.drop_times.every((clock) => clock.time === origin + 1260 && clock.seconds === 720))
            assert.deepEqual(
                slot.clockMigration.archive.map((row) => row.original),
                raw.product_pets[0].drop_times,
            )
            for (const key of ['drops', 'stores', 'eggs', 'claimedRewardGuids', 'nextDropGuid'])
                assert.deepEqual(migrated[key], raw[key])
            f.call('RanchPlayerGetReward', { block_id: 201, reward_guids: [3], egg_guids: [] })
            assert.equal(quantity(f, item.itemid), before + 2)
            f.call('RanchPlayerGetReward', { block_id: 201, reward_guids: [3], egg_guids: [] })
            assert.equal(quantity(f, item.itemid), before + 2)
            f.call('RanchGetStoreReward', { u32: 201 })
            assert.equal(quantity(f, item.itemid), before + 4)
            const receipt = structuredClone(ranch(f).product_pets[0].clockMigration)
            f.reopen()
            assert.deepEqual(ranch(f).product_pets[0].clockMigration, receipt)
            f.setRoll(() => 0)
            f.elapse(360)
            assert(f.tick().some((row) => row.id === 6102))
            assert.equal(ranch(f).drops.length, 2)
            assert(
                ranch(f).drops.every(
                    (drop) =>
                        drop.item.itemnum === 1 &&
                        ranch(f).product_pets[0].drop_times.some((clock) => clock.drop_id === drop.drop_id),
                ),
            )
            assert.equal(new Set(ranch(f).drops.map((row) => row.guid)).size, 2)
            assert(ranch(f).drops.every((row) => row.guid >= 4))
            assert.deepEqual(Object.values(ranch(f).clockMigrationHistory)[0].receipt, receipt)
            f.call('RanchSetPetOption', { block_id: 201, slot: 1, pet_guid: worker.guid, work_type: 1 })
            assert.equal(ranch(f).product_pets.length, 0)
            f.reopen()
            assert.deepEqual(Object.values(ranch(f).clockMigrationHistory)[0].receipt, receipt)
        } finally {
            f.close()
            temp.close()
        }
    }
})

test('actual legacy-overdue login archives original attempts without RNG/backpay and only future current production resumes', () => {
    const f = namedFixture('ranch-clock-current-overdue')
    try {
        installLegacy(f)
        f.elapse(5000)
        const raw = structuredClone(ranch(f)),
            bag = structuredClone(f.state().player.sbag_infos),
            workerGuid = raw.product_pets[0].pet_guid
        f.setRoll(() => {
            throw Error('Overdue cutover cannot roll backlog')
        })
        login(f)
        assert.deepEqual(f.state().player.sbag_infos, bag)
        assert.deepEqual(ranch(f).drops, raw.drops)
        assert.deepEqual(ranch(f).stores, raw.stores)
        assert.equal(ranch(f).nextDropGuid, raw.nextDropGuid)
        const slot = ranch(f).product_pets[0]
        assert.equal(slot.pet_guid, workerGuid)
        assert(slot.clockMigration.archive.every((row) => row.reason === 'overdue-no-backpay'))
        assert(slot.drop_times.every((clock) => clock.time === f.now() + 720))
        f.setRoll(() => 0)
        f.elapse(720)
        f.tick()
        assert.equal(ranch(f).drops.length, raw.drops.length + 2)
        assert.deepEqual(ranch(f).drops[0], raw.drops[0])
    } finally {
        f.close()
    }
})

test('actual new6162 producer carries current marker and retains ordinary offline scheduling', () => {
    const f = namedFixture('ranch-clock-current-factory')
    try {
        f.assign()
        assert.equal(ranch(f).product_pets[0].clockMigration.source, 'current')
        const before = structuredClone(ranch(f).product_pets[0].clockMigration),
            rows = ranchPetDrops(
                f.tables,
                f.state().pets.find((row) => row.guid === f.pets[0]),
            )
        const period = ranchSeconds(
            f.tables,
            f.state(),
            f.state().pets.find((row) => row.guid === f.pets[0]),
            rows[0],
        )
        f.elapse(period * 2)
        f.tick()
        assert.equal(ranch(f).drops.length, rows.length * 2)
        assert.deepEqual(ranch(f).product_pets[0].clockMigration, before)
    } finally {
        f.close()
    }
})

test('real generated bonus/floor/credit/claimed receipts survive migration codec/SQL rollback and relogin without re-roll', () => {
    const temp = ranchBonusFile(),
        f = namedFixture('ranch-clock-current-bonus', { file: temp.file })
    try {
        f.edit((state) => {
            state.player.basic_info.lv = 55
        }) // Trusted current research prerequisite, not earned play.
        f.technologies([2204801])
        f.assign()
        const pet = f.state().pets.find((row) => row.guid === f.pets[0]),
            rows = ranchPetDrops(f.tables, pet),
            period = ranchSeconds(f.tables, f.state(), pet, rows[0]),
            unitsPerCycle = rows.reduce((n, row) => n + row.minValue, 0),
            threshold = selectedRanchBonuses(f.tables, f.state()).get(3006).threshold,
            capacity = f.tables.get('home_ranch').find((row) => row.level === ranch(f).lv).petProductLimit,
            cycles = Math.ceil(capacity / rows.length)
        assert(
            rows.every(
                (row) =>
                    row.rate === 10000 &&
                    row.minValue === row.maxValue &&
                    ranchSeconds(f.tables, f.state(), pet, row) === period,
            ),
        )
        assert(Number.isSafeInteger(capacity) && capacity > threshold && unitsPerCycle > 0)
        f.elapse(period * cycles)
        f.tick() // Actual bounded offline producer fills current999 capacity; no manually inserted floor facts.
        assert.equal(ranch(f).drops.length, capacity)
        const pendingBefore = ranch(f).bonus.pendingBonus.length
        if (!pendingBefore) {
            const needed = threshold - ranch(f).bonus.families[3006].creditUnits,
                base = ranch(f).drops.filter((row) => !row.bonus_source)
            assert(base.length >= needed)
            f.call('RanchPlayerGetReward', {
                block_id: 201,
                reward_guids: base.slice(0, needed).map((row) => row.guid),
            })
            f.elapse(period * Math.ceil(needed / unitsPerCycle))
            f.tick()
        }
        assert.equal(ranch(f).drops.length, capacity)
        assert.equal(ranch(f).bonus.pendingBonus.length, 1)
        f.edit((state) => {
            const slot = state.home.ranches[201].product_pets[0]
            delete slot.clockMigration
            for (const clock of slot.drop_times) {
                delete clock.assetIdentity
                clock.time = f.now() + clock.seconds / 2
            }
        })
        const raw = structuredClone(ranch(f)),
            type = f.protocol.byName.get('CSProtoHomeSync').rsp,
            encode = f.protocol.encode
        f.setRoll(() => {
            throw Error('Sealed bonus must not re-roll')
        })
        f.protocol.encode = function (name, ...args) {
            if (name === type) throw Error('ranch migration codec')
            return encode.call(this, name, ...args)
        }
        try {
            unchanged(f, () => login(f), /ranch migration codec/)
        } finally {
            f.protocol.encode = encode
        }
        f.store.db.exec(
            "CREATE TRIGGER ranch_migration_abort BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'ranch-migration-sql'); END",
        )
        try {
            unchanged(f, () => login(f), /ranch-migration-sql/)
        } finally {
            f.store.db.exec('DROP TRIGGER ranch_migration_abort')
        }
        login(f)
        for (const key of ['drops', 'stores', 'eggs', 'bonus', 'claimedRewardGuids', 'nextDropGuid'])
            assert.deepEqual(ranch(f)[key], raw[key])
        const receipt = structuredClone(ranch(f).product_pets[0].clockMigration)
        f.reopen()
        assert.deepEqual(ranch(f).bonus, raw.bonus)
        assert.deepEqual(ranch(f).product_pets[0].clockMigration, receipt)
        const reward = raw.drops[0],
            pending = raw.bonus.pendingBonus[0],
            before = quantity(f, reward.item.itemid)
        f.call('RanchPlayerGetReward', { block_id: 201, reward_guids: [reward.guid] })
        assert.equal(quantity(f, reward.item.itemid), before + reward.item.itemnum)
        assert.equal(ranch(f).bonus.pendingBonus.length, 0)
        assert.deepEqual(ranch(f).drops.find((row) => row.guid === pending.guid).item, pending.item)
        f.call('RanchPlayerGetReward', { block_id: 201, reward_guids: [pending.guid] })
        const after = quantity(f, pending.item.itemid)
        f.call('RanchPlayerGetReward', { block_id: 201, reward_guids: [pending.guid] })
        assert.equal(quantity(f, pending.item.itemid), after)
    } finally {
        f.close()
        temp.close()
    }
})
