import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { Protocol } from '../src/protocol.js'
import { gridAnchor } from '../src/home-grid.js'
import { grantRewards } from '../src/rewards.js'
import { ErrorCode } from '../src/error-codes.js'

const config = configuration(),
    tables = new Tables(config.tables)
const bag = (s, id) => s.player.sbag_infos.items.filter((x) => x.itemid === id).reduce((n, x) => n + x.itemnum, 0)
function fixture(file = ':memory:', initialize = true) {
    const store = new Store(file),
        protocol = new Protocol(config.base),
        game = new Game(protocol, store, tables, { clock: () => 1800000000 }),
        session = {}
    let seq = 1
    const call = (name, data = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, data) })
            .map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    }
    call('EnterGame', { open_id: 'crop-footprint' })
    if (initialize)
        store.transact(session.id, 0, (s) => {
            s.tasks = []
            s.world.map_id = 701
            s.player.basic_info.lv = 30
            s.taskRecords = tables
                .get('task')
                .filter((r) => r.type === 1)
                .map((r) => ({ task_id: r.id, count: 1, time: 1 }))
            for (let i = 0; i < 8; i++)
                s.home.builds.push({
                    guid: 100 + i,
                    build_id: 20331,
                    build_type: 15,
                    status: 1,
                    locate: {
                        block_id: 102,
                        anchor: gridAnchor(-50 + (i % 2) * 2 + Math.floor(i / 4) * 6, 10 + (Math.floor(i / 2) % 2) * 2),
                        direction: 0,
                    },
                    crop_info: { field_type: 3, water_num: 360, water_max: 360 },
                })
            grantRewards(tables, s, [
                { itemtype: 3, itemid: 310970, itemnum: 3 },
                { itemtype: 3, itemid: 310001, itemnum: 3 },
            ])
        })
    return { store, protocol, call, session, state: () => store.load(session.id).state }
}
const tree = { seed_id: 310970, build_guid: 100, follower_build_guids: [101, 102, 103] }
test('DNA tree reserves a table-sized footprint for one seed and sends all field associations', () => {
    const f = fixture()
    try {
        const before = f.state(),
            packets = f.call('FieldPlant', { plant_info: [tree] })
        const s = f.state(),
            root = s.home.builds.find((b) => b.guid === 100)
        assert.equal(bag(s, 310970), bag(before, 310970) - 1)
        assert.equal(root.crop_info.seed_id, 83)
        assert.equal(root.crop_info.main_build_guid, 100)
        assert.deepEqual(root.crop_info.follower_build_guids, [101, 102, 103])
        for (const guid of [101, 102, 103]) {
            const c = s.home.builds.find((b) => b.guid === guid).crop_info
            assert.equal(c.main_build_guid, 100)
            assert.equal(c.seed_id, undefined)
        }
        assert(packets.some((p) => p.id === 6102))
        assert(packets.some((p) => p.id === 6115))
        assert.equal(s.home.cropOutcomes?.[100], undefined)
        assert.deepEqual(s.taskRecords, before.taskRecords)
        assert.throws(
            () => f.call('FieldPlant', { plant_info: [{ build_guid: 101, seed_id: 310001 }] }),
            (e) => e.code === ErrorCode.HomeFieldHasCrop,
        )
        assert.throws(
            () => f.call('FieldClose', { field_id: 101 }),
            (e) => e.code === ErrorCode.FieldCloseLimit,
        )
        assert.throws(
            () => f.call('FieldWater', { build_guid: 100 }),
            (e) => e.code === ErrorCode.FunctionClosed,
        )
        assert.throws(
            () => f.call('FieldReplant', { main_build: { guid: 100, locate: root.locate } }),
            (e) => e.code === ErrorCode.FunctionClosed,
        )
    } finally {
        f.store.close()
    }
})
test('all current multi-field seed rows use table subIds and planting codec failure leaves no orphan or consumed seed', () => {
    const f = fixture()
    try {
        const encode = f.protocol.encode.bind(f.protocol),
            before = f.state()
        f.protocol.encode = (type, value) => {
            if (type === f.protocol.byId.get(6102).rsp) throw Error('plant codec')
            return encode(type, value)
        }
        assert.throws(() => f.call('FieldPlant', { plant_info: [tree] }), /plant codec/)
        assert.deepEqual(f.state(), before)
        f.protocol.encode = encode
        const seeds = tables.get('home_seeds').filter((r) => r.homeItemSize !== '2|2')
        assert.equal(seeds.length, 5)
        for (const seed of seeds) {
            const item = tables.get('common_item').find((r) => r.type === 310 && r.subId === seed.id)
            f.store.transact(f.session.id, 0, (s) =>
                grantRewards(tables, s, [{ itemtype: 3, itemid: item.id, itemnum: 1 }]),
            )
            f.call('FieldPlant', { plant_info: [{ ...tree, seed_id: item.id }] })
            assert.equal(f.state().home.builds.find((b) => b.guid === 100).crop_info.seed_id, seed.id)
            f.call('FieldUnplant', { u32: 100 })
        }
    } finally {
        f.store.close()
    }
})
test('invalid, remote, duplicate and overlapping footprints fail atomically before any charge', () => {
    const f = fixture()
    try {
        const before = f.state()
        for (const rows of [
            [{ ...tree, follower_build_guids: [] }],
            [{ ...tree, follower_build_guids: [101, 102, 102] }],
            [{ ...tree, follower_build_guids: [101, 102, 105] }],
            [{ ...tree, follower_build_guids: [101, 102, 999] }],
            [tree, { seed_id: 310001, build_guid: 101 }],
            [{ seed_id: 310001, build_guid: 100, follower_build_guids: [101] }],
        ]) {
            assert.throws(() => f.call('FieldPlant', { plant_info: rows }))
            assert.deepEqual(f.state(), before)
        }
        assert.throws(
            () => f.call('FieldPlant', { is_pet: true, plant_info: [tree] }),
            (e) => e.code === ErrorCode.HomeSeedCanNotPlantByKibo,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})
test('multiple DNA roots charge once each; a late seed shortage rolls back the entire batch', () => {
    const f = fixture()
    try {
        f.store.transact(f.session.id, 0, (s) => {
            for (const i of s.player.sbag_infos.items) if (i.itemid === 310970) i.itemnum = 1
        })
        const before = f.state(),
            other = { seed_id: 310970, build_guid: 104, follower_build_guids: [105, 106, 107] }
        assert.throws(() => f.call('FieldPlant', { plant_info: [tree, other] }))
        assert.deepEqual(f.state(), before)
        f.store.transact(f.session.id, 0, (s) => grantRewards(tables, s, [{ itemtype: 3, itemid: 310970, itemnum: 1 }]))
        f.call('FieldPlant', { plant_info: [tree, other] })
        assert.equal(bag(f.state(), 310970), 0)
        assert.equal(f.state().home.builds.filter((b) => b.crop_info?.seed_id === 83).length, 2)
    } finally {
        f.store.close()
    }
})
test('tree removal returns table-configured seed and releases followers; codec failure reverts refund and links', () => {
    const f = fixture()
    try {
        f.call('FieldPlant', { plant_info: [tree] })
        const before = f.state(),
            encode = f.protocol.encode.bind(f.protocol)
        f.protocol.encode = (type, value) => {
            if (type === f.protocol.byId.get(6102).rsp) throw Error('codec refusal')
            return encode(type, value)
        }
        assert.throws(() => f.call('FieldUnplant', { u32: 100 }), /codec refusal/)
        assert.deepEqual(f.state(), before)
        f.protocol.encode = encode
        f.call('FieldUnplant', { u32: 100 })
        assert.equal(bag(f.state(), 310970), 3)
        for (const id of [100, 101, 102, 103])
            assert.deepEqual(f.state().home.builds.find((b) => b.guid === id).crop_info, {
                field_type: 3,
                water_num: 360,
                water_max: 360,
            })
        f.call('FieldPlant', { plant_info: [{ seed_id: 310001, build_guid: 101 }] })
        assert.equal(f.state().home.builds.find((b) => b.guid === 101).crop_info.seed_id, 1)
    } finally {
        f.store.close()
    }
})
test('SQLite restart keeps root/follower ownership without recharging and rejects corrupt associations on removal', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luruka-crop-footprint-')),
        file = path.join(dir, 'save.sqlite')
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()))
    let f = fixture(file)
    try {
        f.call('FieldPlant', { plant_info: [tree] })
        const before = f.state()
        f.store.close()
        f = fixture(file, false)
        assert.deepEqual(f.state().home.builds, before.home.builds)
        assert.equal(bag(f.state(), 310970), 2)
        f.store.transact(f.session.id, 0, (s) => {
            s.home.builds.find((b) => b.guid === 101).crop_info.main_build_guid = 999
        })
        const corrupt = f.state()
        assert.throws(
            () => f.call('FieldUnplant', { u32: 100 }),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), corrupt)
    } finally {
        f.store.close()
        for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(file + suffix, { force: true })
        fs.rmdirSync(dir)
    }
})
