import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { homePayload } from '../src/home.js'
import { homeHubPayload } from '../src/home-hub.js'
import { ErrorCode } from '../src/error-codes.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
function fixture(file = ':memory:') {
    const store = new Store(file),
        game = new Game(protocol, store, tables, { clock: () => 1800000000 }),
        session = {}
    let seq = 1
    const call = (name, data = {}, who = session) => {
        const e = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(who, { id: e.id, seq: seq++, payload: protocol.encode(e.req, data) })
            .map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    }
    call('EnterGame', { open_id: 'hub-order' })
    store.transact(session.id, 0, (s) => {
        s.home.builds.push(
            ...[18, 19, 20].map((guid) => ({
                guid,
                build_id: 100011,
                build_type: 10,
                status: 1,
                locate: { block_id: 101, anchor: 6750237 + guid, direction: 0 },
            })),
        )
        s.home.worldCollections = {}
        for (const [i, w] of tables.get('home_collection_world').slice(0, 3).entries()) {
            const b = tables.get('home_building_collection').find((r) => r.groupId === w.groupId && r.level === 1)
            s.home.worldCollections[w.id] = {
                guid: 80 + i,
                collect_id: w.id,
                build_id: b.id,
                product_infos: [],
                items: [],
                start_time: 0,
                pet_guid: '0',
            }
        }
    })
    return { store, session, call, state: () => store.load(session.id).state, close: () => store.close() }
}
const hub = (f) => homePayload(tables, f.state()).home_hub
const order = (f, type) =>
    hub(f)
        .pos_infos.find((r) => r.build_type === type)
        .builds.map((r) => r.build_guid)
const move = (f, type, source_pos, target_pos) => f.call('ChangeHomeHubPos', { type, source_pos, target_pos })
test('6553 reports table-derived tabs with outer owned building identities, not world collection/config IDs', () => {
    const f = fixture()
    try {
        assert.deepEqual(order(f, 1), [1, 18, 19, 20])
        assert.deepEqual(order(f, 4), [80, 81, 82])
        assert.deepEqual(
            hub(f)
                .pos_infos.find((r) => r.build_type === 4)
                .builds.map((r) => r.pos),
            [1, 2, 3],
        )
        const s = f.state()
        assert(!order(f, 4).includes(s.home.worldCollections[1].collect_id))
        assert(!order(f, 4).includes(s.home.worldCollections[1].build_id))
    } finally {
        f.close()
    }
})
test('6553 production movement is stable insertion with full intermediate shift and 6102 before ACK', () => {
    const f = fixture()
    try {
        const before = f.state(),
            packets = move(f, 1, 1, 4)
        assert.deepEqual(order(f, 1), [18, 19, 20, 1])
        assert.deepEqual(order(f, 4), [80, 81, 82])
        const si = packets.findIndex((p) => p.id === 6102),
            ack = packets.findIndex((p) => p.id === 6553)
        assert(si >= 0 && ack >= 0 && si < ack)
        const sync = packets[si].data
        assert(sync.home_builds.length > 0, 'client HomeSync receiver needs a building row')
        assert.deepEqual(
            sync.home_hub.pos_infos.find((r) => r.build_type === 1).builds.map((r) => r.build_guid),
            [18, 19, 20, 1],
        )
        const after = f.state()
        assert.deepEqual(after.home.builds, before.home.builds)
        assert.deepEqual(after.player, before.player)
        assert.deepEqual(after.pets, before.pets)
        assert.deepEqual(after.world, before.world)
        move(f, 1, 4, 2)
        assert.deepEqual(order(f, 1), [18, 1, 19, 20])
    } finally {
        f.close()
    }
})
test('6553 world collection uses its actual type4 list and retains intermediate ordering', () => {
    const f = fixture()
    try {
        move(f, 4, 1, 3)
        assert.deepEqual(order(f, 4), [81, 82, 80])
        move(f, 4, 3, 1)
        assert.deepEqual(order(f, 4), [80, 81, 82])
        const before = f.state()
        move(f, 4, 2, 2)
        assert.deepEqual(f.state(), before)
    } finally {
        f.close()
    }
})
test('6553 rejects unknown tab, absent/currently foreign position, empty tab and stale removal atomically', () => {
    const f = fixture()
    try {
        for (const [type, source, target] of [
            [0, 1, 2],
            [5, 1, 2],
            [1, 0, 1],
            [1, 1, 5],
            [4, 1, 4],
            [2, 1, 2],
        ]) {
            const before = f.store.load(f.session.id)
            assert.throws(
                () => move(f, type, source, target),
                (e) => e.code === ErrorCode.HomeHubPosErr,
            )
            assert.deepEqual(f.store.load(f.session.id), before)
        }
        f.store.transact(f.session.id, 0, (s) => {
            s.home.builds = s.home.builds.filter((b) => b.guid !== 20)
        })
        const before = f.store.load(f.session.id)
        assert.throws(
            () => move(f, 1, 4, 1),
            (e) => e.code === ErrorCode.HomeHubPosErr,
        )
        assert.deepEqual(f.store.load(f.session.id), before)
    } finally {
        f.close()
    }
})
test('6553 validates saved order, reconciles removed buildings, appends newly owned entries and keeps tab isolation', () => {
    const f = fixture()
    try {
        move(f, 1, 1, 4)
        f.store.transact(f.session.id, 0, (s) => {
            s.home.builds = s.home.builds.filter((b) => b.guid !== 19)
            s.home.builds.push({
                guid: 21,
                build_id: 100011,
                build_type: 10,
                status: 1,
                locate: { block_id: 101, anchor: 6750258, direction: 0 },
            })
        })
        assert.deepEqual(order(f, 1), [18, 20, 1, 21])
        assert.deepEqual(order(f, 4), [80, 81, 82])
        const s = f.state()
        s.home.hubOrders[1] = [18, 18]
        assert.throws(
            () => homeHubPayload(tables, s, s.home.builds),
            (e) => e.code === ErrorCode.GameConfig,
        )
    } finally {
        f.close()
    }
})
test('6553 preserves worker membership and rolls back order on real sync/ack encoding failure', () => {
    const f = fixture()
    try {
        f.call('PetStationInHomeHub', { pet_guid: f.state().pets[0].guid, type: 0 })
        const resident = f.state().home.stationPets
        for (const response of [protocol.byId.get(6102).rsp, protocol.byName.get('CSProtoChangeHomeHubPos').rsp]) {
            const before = f.store.load(f.session.id),
                encode = protocol.encode
            protocol.encode = function (type, data) {
                if (type === response) throw Error('hub codec failure')
                return encode.call(this, type, data)
            }
            try {
                assert.throws(() => move(f, 1, 1, 3), /hub codec failure/)
            } finally {
                protocol.encode = encode
            }
            assert.deepEqual(f.store.load(f.session.id), before)
        }
        const out = move(f, 1, 1, 3).find((p) => p.id === 6102).data
        assert.deepEqual(out.home_hub.station_pets, resident)
    } finally {
        f.close()
    }
})
test('6553 tab categories 2/3 use the same enum and do not confuse ranch identity with block ID', () => {
    const s = { home: { stationPets: [] } },
        builds = [
            { guid: 9, build_type: 16 },
            { guid: 8, build_type: 16 },
            { guid: 23, build_type: 53 },
        ]
    const h = homeHubPayload(tables, s, builds)
    assert.deepEqual(h.pos_infos.find((r) => r.build_type === 2).builds, [
        { pos: 1, build_guid: 8 },
        { pos: 2, build_guid: 9 },
    ])
    assert.deepEqual(h.pos_infos.find((r) => r.build_type === 3).builds, [{ pos: 1, build_guid: 23 }])
})
test('6553 genuine SQLite restart/login restores persisted ordering separately for each tab', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-hub-order-')),
        file = path.join(dir, 'state.sqlite')
    let f = fixture(file),
        store = f.store
    try {
        move(f, 1, 1, 4)
        move(f, 4, 1, 3)
        const id = f.session.id
        f.close()
        store = new Store(file)
        const game = new Game(protocol, store, tables, { clock: () => 1800000001 }),
            session = {},
            e = protocol.byName.get('CSProtoEnterGame')
        const packets = game.dispatch(session, {
            id: e.id,
            seq: 1,
            payload: protocol.encode(e.req, { open_id: 'hub-order' }),
        })
        assert.equal(session.id, id)
        const sync = protocol.decode('SCHomeSync', packets.find((p) => p.id === 6102).payload).home_hub
        assert.deepEqual(
            sync.pos_infos.find((r) => r.build_type === 1).builds.map((r) => r.build_guid),
            [18, 19, 20, 1],
        )
        assert.deepEqual(
            sync.pos_infos.find((r) => r.build_type === 4).builds.map((r) => r.build_guid),
            [81, 82, 80],
        )
    } finally {
        store.close()
        assert.equal(path.dirname(dir), os.tmpdir())
        assert(path.basename(dir).startsWith('lurukaps-hub-order-'))
        fs.rmSync(dir, { recursive: true })
    }
})
