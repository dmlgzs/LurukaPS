import test from 'node:test'
import assert from 'node:assert/strict'
import { ranchFixture } from './ranch-fixture.js'
import { ranchPetDrops, ranchSeconds, ranchWorkerLimit } from '../src/ranch.js'
import { ErrorCode } from '../src/error-codes.js'

test('6162 assigns current role/slot and removes battle and mount bindings before home/pet sync', () => {
    const f = ranchFixture('ranch-assign')
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.player.heros_info.heros[0].pet_id = f.pets[0]
            s.pets.find((p) => p.guid === f.pets[0]).hero_id = s.player.heros_info.heros[0].guid
            s.world.mount = f.pets[0]
            s.world.status = 1
            s.world.mount_status = 1
        })
        const out = f.assign(),
            s = f.state(),
            worker = s.pets.find((p) => p.guid === f.pets[0])
        assert.equal(out.at(-1).id, 6162)
        assert(out.some((p) => p.id === 6102))
        assert(out.some((p) => p.id === 6517))
        assert.equal(worker.work_status, 6)
        assert.equal(worker.work_build, 201)
        assert.equal(worker.capacity_id, 6002)
        assert.equal(worker.hero_id, '0')
        assert.equal(s.player.heros_info.heros[0].pet_id, '0')
        assert.equal(s.world.mount, '0')
        const wire = f.protocol
            .decode('SCHomeSync', out.find((p) => p.id === 6102).payload)
            .home_builds.find((b) => b.build_type === 53)
        assert.equal(wire.ranch_pet_work_info.block_id, 201)
        assert.equal(wire.ranch_pet_work_info.product_pets[0].slot, 1)
        assert(wire.ranch_pet_work_info.product_pets[0].drop_times.every((c) => c.time === f.now() + 360))
        const before = f.state()
        f.assign()
        assert.deepEqual(f.state(), before)
    } finally {
        f.close()
    }
})

test('all current pet farmProducts rows use their real drops and the native capacity exceeds old petLimit=2', () => {
    const f = ranchFixture('ranch-capacity', { pets: 6 })
    try {
        const seen = new Set()
        for (const row of f.tables.get('pet_home_talent'))
            for (const drop of ranchPetDrops(f.tables, { config_id: row.id })) seen.add(drop.id)
        assert.equal(seen.size, 57)
        assert.equal(ranchWorkerLimit(f.tables, f.state()), 5)
        for (let i = 0; i < 5; i++) f.assign(f.pets[i], i + 1)
        assert.equal(f.state().home.ranches[201].product_pets.length, 5)
        const before = f.store.load(f.session.id)
        assert.throws(
            () => f.assign(f.pets[5], 6),
            (e) => e.code === ErrorCode.HomeRanchLvPosLimit,
        )
        assert.deepEqual(f.store.load(f.session.id), before)
    } finally {
        f.close()
    }
})

test('ranch production is due only on its actual period, creates configured loot and caps visible drops', () => {
    const f = ranchFixture('ranch-production')
    try {
        f.assign()
        const sql = () => f.store.db.prepare('select total_changes() as n').get().n
        const before = sql()
        f.elapse(359)
        assert.deepEqual(f.tick(), [])
        assert.equal(sql(), before)
        f.elapse(1)
        const packets = f.tick()
        assert(packets.some((p) => p.id === 6102))
        const ranch = f.state().home.ranches[201],
            expected = ranchPetDrops(f.tables, { config_id: 500001 })
        assert.equal(ranch.drops.length, expected.length)
        for (const drop of ranch.drops) {
            const row = expected.find((r) => r.id === drop.drop_id)
            assert.equal(drop.pet_guid, f.pets[0])
            assert.equal(drop.item.itemid, Number(row.itemId))
            assert.equal(drop.item.itemnum, row.minValue)
        }
        assert.equal(
            f.state().player.sbag_infos.items.filter((i) => expected.some((r) => Number(r.itemId) === i.itemid)).length,
            0,
        )
        let calls = 0
        f.setRoll(() => {
            calls++
            return 0
        })
        f.elapse(1000000000)
        f.tick()
        const full = f.state().home.ranches[201]
        assert.equal(full.drops.length, f.tables.get('home_ranch')[0].petProductLimit)
        assert.equal(new Set(full.drops.map((d) => d.guid)).size, full.drops.length)
        assert(calls <= 40, 'catch-up work is bounded by capacity, not elapsed intervals')
        calls = 0
        f.elapse(360)
        f.tick()
        assert.equal(calls, 0)
    } finally {
        f.close()
    }
})

test('failed rolls produce no fake loot; labor and current technology determine the configured period', () => {
    const f = ranchFixture('ranch-probability')
    try {
        f.setRoll((max) => max - 1)
        f.assign()
        f.elapse(360)
        f.tick()
        assert.deepEqual(f.state().home.ranches[201].drops, [])
        const s = f.state(),
            pet = s.pets.find((p) => p.guid === f.pets[0]),
            row = ranchPetDrops(f.tables, pet)[0]
        pet.labor_infos = [{ labor_id: 9, labor_grade: 20 }]
        const reduction = f.tables.find('home_labor_efficiency', 20).PastureTimeReduct
        assert.equal(ranchSeconds(f.tables, s, pet, row), Math.floor(row.dropTime * (1 - reduction / 10000)))
        s.home.technology.levels[20087] = { level: 1 }
        assert.equal(
            ranchSeconds(f.tables, s, pet, row),
            Math.floor(row.dropTime * (1 - 909 / 10000) * (1 - reduction / 10000)),
        )
        pet.satiety_val = 0
        const fatigue = Number(f.tables.get('game').find((r) => r.title === 'HOME_LABOR_PASTURE_DECREASE').value)
        assert.equal(
            ranchSeconds(f.tables, s, pet, row),
            Math.floor(row.dropTime * (1 - 909 / 10000) * (1 - ((reduction / 10000) * fatigue) / 10000)),
        )
    } finally {
        f.close()
    }
})

test('the actual drop rate boundary is in ten-thousandths and failed periods do not accrue a fake reward', () => {
    const f = ranchFixture('ranch-rate-boundary')
    try {
        f.assign()
        const row = ranchPetDrops(f.tables, { config_id: 500001 }).sort((a, b) => b.rate - a.rate)[0]
        const below = Math.floor((row.rate / 10000) * 0x100000000 - 0.5)
        f.setRoll(() => below)
        f.elapse(360)
        f.tick()
        const drops = f.state().home.ranches[201].drops.filter((drop) => drop.drop_id === row.id)
        assert.equal(drops.length, 1)
        f.setRoll(() => below + 1)
        f.elapse(360)
        f.tick()
        assert.equal(f.state().home.ranches[201].drops.filter((drop) => drop.drop_id === row.id).length, 1)
    } finally {
        f.close()
    }
})

test('changing the current technology period retains fractional progress rather than restarting production', () => {
    const f = ranchFixture('ranch-retiming')
    try {
        f.assign()
        f.elapse(90)
        f.store.transact(f.session.id, 0, (s) => {
            s.home.technology.levels[20087] = { level: 1 }
        })
        f.call('HomeTechnologyTypeInfo', { type: 2 })
        const clock = f.state().home.ranches[201].product_pets[0].drop_times[0]
        assert.equal(clock.seconds, 327)
        assert.equal(clock.time, f.now() + Math.ceil((270 / 360) * 327))
        f.elapse(clock.time - f.now() - 1)
        assert.deepEqual(f.tick(), [])
        f.elapse(1)
        f.tick()
        assert(f.state().home.ranches[201].drops.length > 0)
    } finally {
        f.close()
    }
})

test('moving roles and returning from the home hub removes old clocks and preserves unrelated workers', () => {
    const f = ranchFixture('ranch-release')
    try {
        f.assign()
        f.store.transact(f.session.id, 0, (s) => {
            s.pets.find((p) => p.guid === f.pets[0]).labor_infos = [{ labor_id: 9, labor_grade: 1 }]
        })
        f.assign(f.pets[0], 0, 2)
        assert.deepEqual(f.state().home.ranches[201].product_pets, [])
        assert.equal(f.state().home.ranches[201].harvest_pet, f.pets[0])
        f.assign(f.pets[1], 1)
        f.call('PetStationInHomeHub', { pet_guid: f.pets[0], type: 1 })
        assert.equal(f.state().home.ranches[201].harvest_pet, '0')
        assert.equal(f.state().home.ranches[201].product_pets[0].pet_guid, f.pets[1])
        assert.equal(f.state().pets.find((p) => p.guid === f.pets[0]).work_status, 0)
        assert(!f.state().home.stationPets.includes(f.pets[0]))
        f.call('RanchSetPetOption', { block_id: 201, slot: 1, pet_guid: '0', work_type: 1, out_hub: true })
        f.elapse(1000)
        assert.deepEqual(f.tick(), [])
    } finally {
        f.close()
    }
})

test('locked ranch, foreign pets, bad roles and encoding failure leave worker and clock state unchanged', () => {
    const f = ranchFixture('ranch-invalid', { level: 1 })
    try {
        let before = f.store.load(f.session.id)
        assert.throws(
            () => f.assign(),
            (e) => e.code === ErrorCode.HomeRanchSysLock,
        )
        assert.deepEqual(f.store.load(f.session.id), before)
        f.store.transact(f.session.id, 0, (s) => {
            s.player.basic_info.lv = 6
        })
        for (const req of [
            { block_id: 999, slot: 1, pet_guid: f.pets[0], work_type: 1 },
            { block_id: 201, slot: 1, pet_guid: '144115188075855871', work_type: 1 },
            { block_id: 201, slot: 1, pet_guid: f.pets[0], work_type: 3 },
        ]) {
            before = f.store.load(f.session.id)
            assert.throws(() => f.call('RanchSetPetOption', req))
            assert.deepEqual(f.store.load(f.session.id), before)
        }
        const packet = f.game.packet
        before = f.store.load(f.session.id)
        f.game.packet = function (name, ...args) {
            if (name === 'CSProtoHomeSync') throw Error('ranch encoding failed')
            return packet.call(this, name, ...args)
        }
        assert.throws(() => f.assign(), /ranch encoding failed/)
        assert.deepEqual(f.store.load(f.session.id), before)
        f.game.packet = packet
        f.assign()
        f.elapse(360)
        before = f.store.load(f.session.id)
        f.game.packet = function (name, ...args) {
            if (name === 'CSProtoHomeSync') throw Error('ranch tick failed')
            return packet.call(this, name, ...args)
        }
        assert.throws(() => f.tick(), /ranch tick failed/)
        assert.deepEqual(f.store.load(f.session.id), before)
        f.game.packet = packet
        f.tick()
        assert(f.state().home.ranches[201].drops.length > 0)
        const saved = f.state().home.ranches[201]
        const login = f.call('EnterGame', { open_id: 'ranch-invalid' }, {})
        assert.equal(
            f.protocol
                .decode('SCHomeSync', login.find((p) => p.id === 6102).payload)
                .home_builds.find((p) => p.build_type === 53).ranch_pet_work_info.drops.length,
            saved.drops.length,
        )
        assert.deepEqual(f.state().home.ranches[201], saved)
    } finally {
        f.close()
    }
})
