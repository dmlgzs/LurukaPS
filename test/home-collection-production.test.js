import test from 'node:test'
import assert from 'node:assert/strict'
import {
    collectionPlan,
    collectionStorage,
    retimeCollections,
    settleCollections,
    collectionDue,
} from '../src/home-collection.js'
import { assertSyncBefore } from './exchange-sync-assertions.js'
import { fixture, tables, protocol } from './home-collection-fixture.js'

const buildAt = (state, guid = 100) => state.home.builds.find((b) => b.guid === guid)
const station = (f, guid = 100, extra = {}) =>
    f.call('PetStationed', { build_guid: guid, build_type: 1, pet_guid: f.worker, ...extra })

test('all five current stations dispatch through 6532, expose the correct capacity and pre-ack home/pet sync', () => {
    const f = fixture()
    try {
        for (let i = 0; i < 5; i++) {
            const guid = 100 + i,
                old = i ? guid - 1 : 0
            const packets = station(f, guid, { source_build: old })
            const homes = assertSyncBefore(protocol, packets, 'CSProtoHomeSync', 6532)
            const pets = assertSyncBefore(protocol, packets, 'CSProtoPetInfoSync', 6532)
            const state = f.state(),
                build = buildAt(state, guid),
                config = tables.find('home_building_homecollection', build.build_id)
            const snapshot = homes.at(-1).data.home_builds.find((b) => b.guid === guid)
            assert.equal(snapshot.collect_build_data.pet_guid, f.worker)
            assert.equal(snapshot.collect_build_data.start_time, f.now())
            assert.equal(snapshot.collect_build_data.product_infos.length, config.products.split('|').length)
            assert.equal(
                pets.at(-1).data.pet_infos.pets.find((p) => p.guid === f.worker).capacity_id,
                config.petCapacity,
            )
            if (old) {
                assert.equal(buildAt(state, old).station_pet_guid, '0')
                assert.equal(buildAt(state, old).collect_build_data.start_time, 0)
                assert.equal(state.home.collectionProduction[old].pet, '0')
            }
        }
    } finally {
        f.close()
    }
})

test('the clock produces actual current drops and home XP stock, never deposits notification-only inventory', () => {
    const f = fixture()
    try {
        station(f)
        const state = f.state(),
            build = buildAt(state),
            plan = collectionPlan(tables, state, build)
        const stream = plan.streams.find((s) => s.product === 131000101)
        assert.equal(stream.seconds, 36 * 0.99)
        assert.equal(
            f.advance(35).some((p) => p.id === 6102),
            false,
        )
        const before = structuredClone(f.state().player.sbag_infos)
        f.advance(1)
        let data = buildAt(f.state()).collect_build_data
        assert.equal(data.items.find((i) => i.source_product_id === 131000101).item_num, 1)
        assert.equal(data.items.find((i) => i.source_product_id === 131000201).item_id, 317001)
        assert.deepEqual(f.state().player.sbag_infos, before)
        f.advance(324)
        data = buildAt(f.state()).collect_build_data
        assert.equal(data.items.find((i) => i.source_product_id === 1300511450).item_num, 6)
        const snapshot = structuredClone(data.items)
        assert.equal(
            settleCollections(tables, f.state(), f.now(), () => {
                throw Error('No reroll')
            }),
            false,
        )
        assert.deepEqual(buildAt(f.state()).collect_build_data.items, snapshot)
    } finally {
        f.close()
    }
})

test('world repairs add their configured streams and cells only to related home stations', () => {
    const f = fixture()
    try {
        const state = f.state(),
            build = buildAt(state),
            base = collectionPlan(tables, state, build)
        assert.equal(base.slots, 20)
        assert.equal(base.streams.length, 6)
        const world = tables.find('home_collection_world', 1)
        const config = tables.get('home_building_collection').find((r) => r.groupId === world.groupId && r.level === 1)
        state.home.worldCollections = { 1: { collect_id: 1, guid: 999, build_id: config.id } }
        const plan = collectionPlan(tables, state, build)
        assert.equal(plan.slots, 21)
        assert(plan.streams.some((s) => s.product === 131010101 && s.seconds === 720))
        assert.equal(collectionPlan(tables, state, buildAt(state, 101)).streams.length, 3)
        for (const w of tables.get('home_collection_world')) {
            const b = tables.get('home_building_collection').find((r) => r.groupId === w.groupId && r.level === 1)
            state.home.worldCollections[w.id] = { collect_id: w.id, guid: 1000 + w.id, build_id: b.id }
        }
        for (let i = 0; i < 5; i++) assert(collectionPlan(tables, state, buildAt(state, 100 + i)).streams.length > 3)
    } finally {
        f.close()
    }
})

test('withdrawal settles earned stock, pauses fractional work, and prevents offline ghost production', () => {
    const f = fixture()
    try {
        station(f)
        f.advance(50, false)
        station(f) // Same pet toggles off; settlement happens before removal.
        const stopped = buildAt(f.state()).collect_build_data
        assert.equal(stopped.pet_guid, '0')
        assert.equal(stopped.start_time, 0)
        assert.equal(stopped.items.find((i) => i.source_product_id === 131000101).item_num, 1)
        const items = structuredClone(stopped.items)
        f.advance(86400)
        assert.deepEqual(buildAt(f.state()).collect_build_data.items, items)
        station(f)
        f.advance(21)
        assert.equal(
            buildAt(f.state()).collect_build_data.items.find((i) => i.source_product_id === 131000101).item_num,
            1,
        )
        f.advance(1)
        assert.equal(
            buildAt(f.state()).collect_build_data.items.find((i) => i.source_product_id === 131000101).item_num,
            2,
        )
        f.call('PetStationInHomeHub', { pet_guid: f.worker, type: 1 })
        assert.equal(buildAt(f.state()).collect_build_data.pet_guid, '0')
        assert.equal(collectionDue(f.state(), f.now() + 86400), false)
    } finally {
        f.close()
    }
})

test('probability, quantity, egg cells, capacity, blocked clocks and no-reroll pending drops', () => {
    const f = fixture()
    try {
        station(f, 104)
        const state = f.state(),
            build = buildAt(state, 104),
            plan = collectionPlan(tables, state, build)
        assert.equal(
            collectionStorage(plan, [
                { item_type: 14, item_id: 20101001, item_num: 3 },
                { item_type: 10, item_id: 1003, item_num: 600 },
                { item_type: 3, item_id: 308000, item_num: 1001 },
            ]),
            5,
        )
        const stream = plan.streams.find((s) => s.drop.itemType === 14)
        const job = state.home.collectionProduction[104]
        job.clocks = [{ product: stream.product, next: f.now(), seconds: stream.seconds, pending: 2 }]
        build.collect_build_data.items = [
            { item_type: 14, item_id: 20101001, source_product_id: stream.product, item_num: plan.slots - 1 },
        ]
        settleCollections(tables, state, f.now(), () => {
            throw Error('Pending reward must not be rerolled')
        })
        assert.equal(collectionStorage(plan, build.collect_build_data.items), plan.slots)
        assert.equal(job.clocks[0].pending, 1)
        assert.equal(job.blocked, true)
        assert.equal(collectionDue(state, f.now() + 86400), false)
        build.collect_build_data.items = []
        retimeCollections(tables, state, f.now() + 86400)
        settleCollections(tables, state, f.now() + 86400, () => {
            throw Error('No reroll')
        })
        assert.equal(build.collect_build_data.items[0].item_num, 1)
        assert.equal(job.blocked, false)
        // Use a real rare egg stream; random 2500 must miss rate2500, 2499 hits.
        const w = tables.get('home_collection_world').find((w) => w.id === 31)
        assert(w)
        for (const world of tables.get('home_collection_world')) {
            const b = tables.get('home_building_collection').find((b) => b.groupId === world.groupId && b.level === 1)
            ;(state.home.worldCollections ??= {})[world.id] = {
                collect_id: world.id,
                guid: 2000 + world.id,
                build_id: b.id,
            }
        }
        const rare = collectionPlan(tables, state, build).streams.find((s) => s.drop.rate === 2500)
        assert(rare)
        build.collect_build_data.items = []
        job.clocks = [{ product: rare.product, next: f.now(), seconds: rare.seconds }]
        settleCollections(tables, state, f.now(), () => 2500)
        assert.equal(build.collect_build_data.items.length, 0)
        settleCollections(tables, state, f.now() + rare.seconds, () => 2499)
        assert.equal(build.collect_build_data.items[0].item_num, rare.drop.minValue)
    } finally {
        f.close()
    }
})

test('invalid operation, stale source and incompatible labor fail without modifying saved work', () => {
    const f = fixture()
    try {
        assert.throws(() => station(f, 100, { build_type: 2 }), /HOME_REST/)
        assert.throws(() => station(f, 100, { source_build: 77 }), /source building/)
        f.edit((state) => {
            state.pets[0].labor_infos = [{ labor_id: 1, labor_grade: 100 }]
        })
        const before = f.state()
        assert.throws(() => station(f), /required production ability/)
        assert.deepEqual(f.state(), before)
    } finally {
        f.close()
    }
})

test('offline login settles once, retimes technology without losing work and keeps fresh snapshots consistent', () => {
    const f = fixture()
    try {
        station(f)
        f.advance(100, false)
        const packets = f.call('EnterGame', { open_id: 'home-collection' }, {})
        const home = packets.find((p) => p.id === 6102).data.home_builds.find((b) => b.guid === 100)
        assert.equal(home.collect_build_data.items.find((i) => i.source_product_id === 131000101).item_num, 2)
        const state = f.state(),
            build = buildAt(state),
            job = state.home.collectionProduction[100]
        const clock = job.clocks.find((c) => c.product === 131000101)
        const fraction = (clock.next - f.now()) / clock.seconds
        state.home.technology.levels[11051] = { level: 1 }
        retimeCollections(tables, state, f.now())
        const stream = collectionPlan(tables, state, build).streams.find((s) => s.product === 131000101)
        assert.equal(stream.seconds, 36 * (1 - 476 / 10000) * 0.99)
        assert(Math.abs((clock.next - f.now()) / clock.seconds - fraction) < 1e-8)
        const before = structuredClone(build.collect_build_data)
        assert.equal(
            settleCollections(tables, state, f.now(), () => {
                throw Error('No offline reroll')
            }),
            false,
        )
        assert.deepEqual(build.collect_build_data, before)
        state.pets[0].satiety_val = 10
        retimeCollections(tables, state, f.now())
        assert.equal(collectionPlan(tables, state, build).streams[0].seconds, 36 * (1 - 476 / 10000) * (1 - 0.01 * 0.4))
    } finally {
        f.close()
    }
})

test('home snapshot encoding failure rolls back both worker assignment and due production', () => {
    const f = fixture()
    try {
        const packet = f.game.packet,
            before = f.store.load(f.session.id)
        f.game.packet = function (name, ...args) {
            if (name === 'CSProtoHomeSync') throw Error('collection snapshot failure')
            return packet.call(this, name, ...args)
        }
        assert.throws(() => station(f), /collection snapshot failure/)
        assert.deepEqual(f.store.load(f.session.id), before)
        f.game.packet = packet
        station(f)
        f.advance(40, false)
        const pending = f.store.load(f.session.id)
        f.game.packet = function (name, ...args) {
            if (name === 'CSProtoHomeSync') throw Error('collection tick failure')
            return packet.call(this, name, ...args)
        }
        assert.throws(() => f.game.tick(f.session.id), /collection tick failure/)
        assert.deepEqual(f.store.load(f.session.id), pending)
        f.game.packet = packet
        f.game.tick(f.session.id)
        assert.equal(
            buildAt(f.state()).collect_build_data.items.find((i) => i.source_product_id === 131000101).item_num,
            1,
        )
    } finally {
        f.close()
    }
})

test('due-only persistence excludes frequent movement and combat, including an overdue collection clock', () => {
    const f = fixture()
    try {
        station(f)
        const changes = () => f.store.db.prepare('select total_changes() as n').get().n
        const before = changes()
        for (let i = 0; i < 20; i++) assert.deepEqual(f.advance(1), [])
        assert.equal(changes(), before)
        f.advance(20, false)
        for (let i = 0; i < 20; i++) {
            f.call('StateUpdate', { move_msg: { map_id: f.state().world.map_id, move: [] } })
            f.call('BattleInfoReduce', { uint64_dic: [], battle_info: [], base_time: '0' })
        }
        assert.equal(changes(), before)
        assert.equal(buildAt(f.state()).collect_build_data.items.length, 0)
        f.advance(0)
        assert(changes() > before)
        assert.equal(
            buildAt(f.state()).collect_build_data.items.find((i) => i.source_product_id === 131000101).item_num,
            1,
        )
        const done = changes()
        assert.deepEqual(f.advance(0), [])
        assert.equal(changes(), done)
    } finally {
        f.close()
    }
})

test('repeated pauses use the latest remaining work instead of restoring the first pause fraction', () => {
    const f = fixture()
    try {
        station(f)
        for (let i = 0; i < 3; i++) {
            f.advance(10)
            station(f)
            f.advance(100)
            station(f)
        }
        const clock = f.state().home.collectionProduction[100].clocks.find((c) => c.product === 131000101)
        assert(Math.abs(clock.next - f.now() - 5.64) < 1e-6)
        f.advance(5)
        assert.equal(buildAt(f.state()).collect_build_data.items.length, 0)
        f.advance(1)
        assert.equal(
            buildAt(f.state()).collect_build_data.items.find((i) => i.source_product_id === 131000101).item_num,
            1,
        )
    } finally {
        f.close()
    }
})
