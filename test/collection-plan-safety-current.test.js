import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture, legacy, oldPeriods, extraSource, unchanged } from './helpers/collection-current-fixture.js'
import { collectionPlan } from '../src/home-collection.js'
import { ErrorCode } from '../src/error-codes.js'

test('current declared basic plan is executed by fresh6532 with selected plan on6102', () => {
    const f = fixture('collection-plan-safety-fresh')
    try {
        const packets = f.assign(),
            state = f.state(),
            job = state.home.collectionProduction[f.build.guid]
        assert.equal(job.clocks.length, 6)
        assert(oldPeriods.every(([id]) => job.clocks.some((clock) => clock.product === id)))
        assert.equal(job.clockMigration.source, 'current')
        assert.equal(
            state.home.builds.find((row) => row.guid === f.build.guid).collect_build_data.product_choose_id,
            13001101,
        )
        const packet = packets.find((row) => row.id === 6102)
        assert(packet)
        const wire = f.protocol.decode(f.protocol.byName.get('CSProtoHomeSync').rsp, packet.payload)
        assert.equal(
            wire.home_builds.find((row) => row.guid === f.build.guid).collect_build_data.product_choose_id,
            13001101,
        )
    } finally {
        f.close()
    }
})

test('actual technology/world extras accompany every basic stream and preserve old blocked pending', () => {
    for (const kind of ['technology', 'world-point']) {
        const f = fixture('collection-plan-safety-extra-' + kind)
        try {
            const extras = extraSource(f, kind)
            legacy(f, true, extras)
            const original = structuredClone(f.state().home.collectionProduction[f.build.guid])
            f.call('EnterGame', { open_id: f.name }, {})
            const state = f.state(),
                build = state.home.builds.find((row) => row.guid === f.build.guid),
                plan = collectionPlan(f.tables, state, build),
                job = state.home.collectionProduction[f.build.guid]
            assert(oldPeriods.every(([id]) => plan.streams.some((row) => row.product === id)))
            assert(extras.every(([id]) => plan.streams.some((row) => row.product === id)))
            assert.equal(job.clocks.length, oldPeriods.length + extras.length)
            assert.equal(job.clocks.find((row) => row.product === original.clocks[0].product).pending.item_num, 1)
            assert.equal(build.collect_build_data.items[0].item_num, plan.slots * 2000)
            assert(job.clockMigration.archive.some((row) => row.reason === 'sealed-pending-preserved'))
        } finally {
            f.close()
        }
    }
})

test('declared missing plan stays strict configuration failure and all state rolls back', () => {
    const f = fixture('collection-plan-safety-damaged')
    try {
        const originalGet = f.tables.get.bind(f.tables),
            rows = originalGet('home_building_collectionplan')
        const broken = {
            get: (name) =>
                name === 'home_building_collectionplan' ? rows.filter((row) => row.id !== 13001101) : originalGet(name),
        }
        assert.throws(
            () => collectionPlan(broken, f.state(), f.build),
            (error) => error.code === ErrorCode.GameConfig,
        )
        legacy(f)
        f.store.transact(f.session.id, 0, (s) => {
            s.home.collectionProduction[f.build.guid].clocks[0].seconds = 0
        })
        unchanged(f, () => f.call('EnterGame', { open_id: f.name }, {}))
    } finally {
        f.close()
    }
})

test('migration and worker assignment are inside real home codec and SQL transactions', () => {
    const f = fixture('collection-plan-safety-boundaries')
    try {
        legacy(f)
        const homeType = f.protocol.byName.get('CSProtoHomeSync').rsp,
            encode = f.protocol.encode
        f.protocol.encode = function (name, ...args) {
            if (name === homeType) throw Error('collection safety codec failure')
            return encode.call(this, name, ...args)
        }
        try {
            unchanged(
                f,
                () => f.call('EnterGame', { open_id: f.name }, {}),
                (error) => /codec failure/.test(error.message),
            )
        } finally {
            f.protocol.encode = encode
        }
        f.store.db.exec(
            "CREATE TRIGGER collection_safety_abort BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'collection-safety-sql'); END",
        )
        try {
            unchanged(
                f,
                () => f.call('EnterGame', { open_id: f.name }, {}),
                (error) => /collection-safety-sql/.test(error.message),
            )
        } finally {
            f.store.db.exec('DROP TRIGGER collection_safety_abort')
        }
        f.call('EnterGame', { open_id: f.name }, {})
        assert.equal(f.state().home.collectionProduction[f.build.guid].clockMigration.source, 'legacy-cutover')
        const original = structuredClone(f.state().home.collectionProduction[f.build.guid].clockMigration)
        f.call('EnterGame', { open_id: f.name }, {})
        assert.deepEqual(f.state().home.collectionProduction[f.build.guid].clockMigration, original)
    } finally {
        f.close()
    }
})
