import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture, tables, protocol } from './home-collection-fixture.js'
import { ErrorCode } from '../src/error-codes.js'

const building = (f, guid) => f.state().home.builds.find((b) => b.guid === guid)
function remoteFixture() {
    const f = fixture()
    f.edit((s) => {
        s.world.map_id = 101
        for (const [guid, build_id, build_type] of [
            [200, 20201, 2],
            [201, 20241, 8],
            [202, 100011, 10],
            [203, 30231, 12],
        ])
            s.home.builds.push({
                guid,
                build_id,
                build_type,
                status: 1,
                locate: { block_id: 101, anchor: 6750400 + guid, direction: 0 },
            })
    })
    const worker = (guid) => {
        const b = building(f, guid),
            station = tables.find(
                b.build_type === 24 ? 'home_building_homecollection' : 'home_building_production',
                b.build_id,
            )
        return f
            .state()
            .pets.find(
                (p) =>
                    p.guid !== f.worker &&
                    p.labor_infos.some(
                        (l) =>
                            l.labor_grade > 0 && String(station.laborType).split('|').map(Number).includes(l.labor_id),
                    ) &&
                    String(station.petSize)
                        .split('|')
                        .map(Number)
                        .includes(tables.find('pet_home_talent', p.config_id)?.sizeType),
            )?.guid
    }
    return {
        ...f,
        workerFor: worker,
        station: (pet_guid, build_guid, extra = {}) =>
            f.call('PetStationed', { pet_guid, build_guid, build_type: 1, ...extra }),
    }
}

test('HomeCenter can dispatch and unload actual qualified workers at all supported owned station types while outside HOME_ID', () => {
    const f = remoteFixture()
    try {
        const pos = structuredClone(f.state().world.pos)
        assert.equal(building(f, 1).build_type, 2)
        for (const guid of [1, 200, 201, 202, 203, 100]) {
            const worker = f.workerFor(guid)
            assert(worker, 'actual tables must contain a qualified owned worker for ' + guid)
            const packets = f.station(worker, guid),
                ack = packets.findIndex((p) => p.id === 6532)
            assert(ack >= 0)
            for (const id of [6102, 6517])
                assert(packets.findIndex((p) => p.id === id) >= 0 && packets.findIndex((p) => p.id === id) < ack)
            assert.equal(building(f, guid).station_pet_guid, worker)
            assert.equal(f.state().pets.find((p) => p.guid === worker).work_build, guid)
            f.station(worker, guid, { out_hub: true })
            assert.equal(building(f, guid).station_pet_guid, '0')
        }
        assert.equal(f.state().world.map_id, 101)
        assert.deepEqual(f.state().world.pos, pos)
    } finally {
        f.close()
    }
})

test('remote collection retains actual production clock, source validation and codec rollback when moving the worker', () => {
    const f = remoteFixture(),
        encode = protocol.encode.bind(protocol)
    try {
        const worker = f.workerFor(101)
        f.station(worker, 101)
        f.advance(360)
        const stored = structuredClone(building(f, 101).collect_build_data.items)
        assert(stored.length > 0)
        const before = f.state()
        assert.throws(() => f.station(worker, 102, { source_build: 999 }), /source building/)
        assert.deepEqual(f.state(), before)
        protocol.encode = (name, data) => {
            if (name === protocol.byId.get(6532).rsp) throw Error('remote station codec failure')
            return encode(name, data)
        }
        assert.throws(() => f.station(worker, 102, { source_build: 101 }), /remote station codec failure/)
        assert.deepEqual(f.state(), before)
        protocol.encode = encode
        f.station(worker, 102, { source_build: 101 })
        assert.equal(building(f, 101).station_pet_guid, '0')
        assert.deepEqual(building(f, 101).collect_build_data.items, stored)
        assert.equal(building(f, 102).station_pet_guid, worker)
    } finally {
        protocol.encode = encode
        f.close()
    }
})

test('remote dispatch still rejects unknown, unplaced and unfinished facilities before changing workers', () => {
    const f = remoteFixture()
    try {
        const worker = f.workerFor(100)
        f.station(worker, 100)
        let before = f.state()
        assert.throws(() => f.station(worker, 999999), /not owned or ready/)
        assert.deepEqual(f.state(), before)
        for (const change of [
            (b) => delete b.locate,
            (b) => {
                b.status = 2
            },
        ]) {
            f.edit((s) => change(s.home.builds.find((b) => b.guid === 101)))
            before = f.state()
            assert.throws(() => f.station(worker, 101, { source_build: 100 }), /not owned or ready/)
            assert.deepEqual(f.state(), before)
        }
    } finally {
        f.close()
    }
})

test('remote production page keeps the client battle prohibition while collection keeps its own data-only entry contract', () => {
    const f = remoteFixture()
    try {
        f.edit((s) => {
            const id = String(s.player.basic_info.id)
            s.combat = {
                map_id: s.world.map_id,
                hatred: {
                    players: { [id]: { id, target_obj_ids: ['216172782113783809'], player_obj_ids: [] } },
                    objects: {},
                },
            }
        })
        const before = f.state()
        assert.throws(
            () => f.station(f.workerFor(202), 202),
            (e) => e.code === ErrorCode.PlayerInFight,
        )
        assert.deepEqual(f.state(), before)
        assert.equal(tables.find('home_building_production', building(f, 201).build_id).groupId, 21)
        const artisan = f.workerFor(201)
        f.station(artisan, 201)
        assert.equal(building(f, 201).station_pet_guid, artisan)
        const worker = f.workerFor(100)
        f.station(worker, 100)
        assert.equal(building(f, 100).station_pet_guid, worker)
    } finally {
        f.close()
    }
})
