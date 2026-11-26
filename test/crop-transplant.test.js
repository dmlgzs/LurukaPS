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
import { gridAnchor, gridPosition, homeCondition } from '../src/home-grid.js'
import { grantRewards } from '../src/rewards.js'
import { ErrorCode } from '../src/error-codes.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables)
function fixture(file = ':memory:', initialize = true) {
    const store = new Store(file),
        protocol = new Protocol(cfg.base),
        session = {},
        game = new Game(protocol, store, tables, { clock: () => 1800000000 })
    let seq = 1
    const call = (name, data = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, data) })
            .map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    }
    call('EnterGame', { open_id: 'crop-transplant' })
    if (initialize) {
        store.transact(session.id, 0, (s) => {
            s.tasks = []
            s.world.map_id = 701
            s.player.basic_info.lv = 30
            s.taskRecords = tables
                .get('task')
                .filter((r) => r.type === 1)
                .map((r) => ({ task_id: r.id, count: 1, time: 1 }))
            for (let i = 0; i < 4; i++)
                s.home.builds.push({
                    guid: 100 + i,
                    build_id: 20331,
                    build_type: 15,
                    status: 1,
                    locate: {
                        block_id: 102,
                        anchor: gridAnchor(-50 + (i % 2) * 2, 10 + Math.floor(i / 2) * 2),
                        direction: 0,
                    },
                    crop_info: { field_type: 3, water_num: 360, water_max: 360 },
                })
            grantRewards(tables, s, [{ itemtype: 3, itemid: 310970, itemnum: 1 }])
        })
        call('FieldPlant', {
            plant_info: [{ seed_id: 310970, build_guid: 100, follower_build_guids: [101, 102, 103] }],
        })
    }
    return { store, session, protocol, call, state: () => store.load(session.id).state }
}
function request(state, dx = 0, dy = 2, turn = 0) {
    const fields = state.home.builds.filter((b) => b.guid >= 100),
        root = gridPosition(fields[0].locate.anchor)
    const rows = fields.map((b) => {
        const p = gridPosition(b.locate.anchor)
        let x = p.x - root.x,
            y = p.y - root.y
        for (let i = 0; i < turn; i++) [x, y] = [-y, x]
        return {
            guid: b.guid,
            locate: { ...b.locate, anchor: gridAnchor(root.x + dx + x, root.y + dy + y), direction: turn },
        }
    })
    return { main_build: rows[0], follower_builds: rows.slice(1) }
}
test('existing upgraded fertile fields move before new-field quota unlocks; opening a new field remains prohibited', () => {
    const f = fixture()
    try {
        assert.equal(
            tables
                .get('home_building_num')
                .filter((r) => r.groupId === 2033 && homeCondition(r.unlockCondition, f.state()))
                .reduce((n, r) => n + r.addNum, 0),
            0,
        )
        const before = f.state(),
            r = request(before),
            packets = f.call('FieldReplant', r),
            s = f.state()
        for (const row of [r.main_build, ...r.follower_builds])
            assert.deepEqual(s.home.builds.find((b) => b.guid === row.guid).locate, row.locate)
        for (const b of before.home.builds.filter((b) => b.guid >= 100))
            assert.deepEqual(s.home.builds.find((x) => x.guid === b.guid).crop_info, b.crop_info)
        assert.deepEqual(s.home.cropOutcomes, before.home.cropOutcomes)
        assert.deepEqual(s.player.sbag_infos, before.player.sbag_infos)
        assert(packets.some((p) => p.id === 6079))
        assert(packets.some((p) => p.id === 6102))
        assert.throws(
            () => f.call('FieldOpen', { field_type: 3, locate: { block_id: 102, anchor: gridAnchor(-40, 10) } }),
            /limit/,
        )
    } finally {
        f.store.close()
    }
})
test('all linked fields rotate together while malformed, partial and individual follower moves fail without changes', () => {
    const f = fixture()
    try {
        f.call('FieldReplant', request(f.state(), 0, 4, 1))
        const before = f.state(),
            r = request(before)
        for (const bad of [
            { ...r, follower_builds: r.follower_builds.slice(0, 2) },
            { ...r, follower_builds: [r.follower_builds[0], r.follower_builds[0], r.follower_builds[2]] },
            { main_build: r.follower_builds[0] },
            { ...r, follower_builds: r.follower_builds.map((b, i) => (i === 0 ? { ...b, guid: 999 } : b)) },
            {
                ...r,
                follower_builds: [
                    { ...r.follower_builds[0], locate: r.follower_builds[1].locate },
                    { ...r.follower_builds[1], locate: r.follower_builds[0].locate },
                    r.follower_builds[2],
                ],
            },
        ]) {
            assert.throws(() => f.call('FieldReplant', bad))
            assert.deepEqual(f.state(), before)
        }
    } finally {
        f.store.close()
    }
})
test('fixed fields, out-of-bounds and external building collisions remain protected', () => {
    const f = fixture()
    try {
        let before = f.state()
        assert.throws(() => f.call('FieldReplant', request(before, 2000, 0)))
        assert.deepEqual(f.state(), before)
        f.store.transact(f.session.id, 0, (s) => {
            s.home.builds.find((b) => b.guid === 102).crop_info.is_fixed = true
        })
        before = f.state()
        assert.throws(
            () => f.call('FieldReplant', request(before)),
            (e) => e.code === ErrorCode.FixedFieldCanNotMove,
        )
        assert.deepEqual(f.state(), before)
        f.store.transact(f.session.id, 0, (s) => {
            delete s.home.builds.find((b) => b.guid === 102).crop_info.is_fixed
            s.home.builds.push({
                guid: 200,
                build_id: 20161,
                build_type: 15,
                status: 1,
                locate: { block_id: 102, anchor: gridAnchor(-50, 14), direction: 0 },
                crop_info: { field_type: 1, water_num: 360, water_max: 360 },
            })
        })
        before = f.state()
        const r = request(before)
        r.follower_builds = r.follower_builds.filter((b) => b.guid !== 200)
        assert.throws(() => f.call('FieldReplant', r), /overlaps/)
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})
test('real HomeSync codec failure rolls back every location; SQLite relogin retains the committed arrangement', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luruka-crop-transplant-')),
        file = path.join(dir, 'save.sqlite')
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()))
    let f = fixture(file)
    try {
        const before = f.state(),
            encode = f.protocol.encode.bind(f.protocol),
            r = request(before)
        f.protocol.encode = (type, value) => {
            if (type === f.protocol.byId.get(6102).rsp) throw Error('transplant codec')
            return encode(type, value)
        }
        assert.throws(() => f.call('FieldReplant', r), /transplant codec/)
        assert.deepEqual(f.state(), before)
        f.protocol.encode = encode
        f.call('FieldReplant', r)
        const committed = f.state()
        f.store.close()
        f = fixture(file, false)
        assert.deepEqual(f.state().home.builds, committed.home.builds)
        f.call('FieldUnplant', { u32: 100 })
        assert.equal(f.state().home.builds.filter((b) => b.crop_info?.main_build_guid).length, 0)
    } finally {
        f.store.close()
        for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(file + suffix, { force: true })
        fs.rmdirSync(dir)
    }
})

test('current fertile FieldOpen enforces home levels17/18 and21/22, synchronizes actual slots and preserves assets on retries or failures', () => {
    const f = fixture(':memory:', false),
        fieldType = tables.find('home_fieldtype', 3),
        building = tables.find('home_building', fieldType.homeBuildingId)
    const setLevel = (level) =>
        f.store.transact(f.session.id, 0, (state) => {
            state.tasks = []
            state.world.map_id = Number(tables.get('game').find((row) => row.title === 'HOME_ID').value)
            const total = tables
                .get('home_level')
                .filter((row) => row.id < level)
                .reduce((sum, row) => sum + row.exp, 0)
            Object.assign(state.home, {
                level,
                exp: 0,
                experienceVersion: 1,
                experienceTotal: String(total),
                levelRewardedThrough: level,
            })
            let attr = state.player.attr_infos.attrs.find((row) => row.attr_id === 1003)
            if (!attr) state.player.attr_infos.attrs.push((attr = { attr_id: 1003 }))
            attr.attr_val = String(total)
        })
    const fields = () => f.state().home.builds.filter((build) => build.build_id === building.id)
    const quota = () =>
        tables
            .get('home_building_num')
            .filter((row) => row.groupId === building.groupId && homeCondition(row.unlockCondition, f.state()))
            .reduce((sum, row) => sum + row.addNum, 0)
    const open = (index) => ({
        field_type: fieldType.id,
        locate: { block_id: 102, anchor: gridAnchor(-60 + index * 3, 10), direction: 0 },
    })
    const assets = (state) => ({
        bag: state.player.sbag_infos,
        gold: state.player.basic_info.gold,
        diamond: state.player.basic_info.diamond,
        inventory: state.home.inventory,
    })
    try {
        assert.equal(building.material, '', 'current direct field placement has no material cost')
        assert.equal(building.time, 0)
        setLevel(17)
        assert.equal(quota(), 0)
        let before = f.state()
        assert.throws(() => f.call('FieldOpen', open(0)), /limit/)
        assert.deepEqual(f.state(), before)
        setLevel(18)
        assert.equal(quota(), 4)
        const initialAssets = assets(f.state()),
            guids = []
        for (let i = 0; i < quota(); i++) {
            const packets = f.call('FieldOpen', open(i)),
                field = packets.find((packet) => packet.id === 6113)?.data
            const sync = packets.find((packet) => packet.id === 6102)?.data
            assert.equal(field.build_id, building.id)
            assert.equal(field.status, 1)
            assert.equal(field.crop_info.field_type, fieldType.id)
            assert.equal(field.crop_info.water_max, fieldType.waterMax)
            assert(sync.home_builds.some((build) => build.guid === field.guid && build.build_id === building.id))
            assert.equal(
                sync.home_level_new_base.level,
                18,
                'client receives the cultivation level that selects its field quota',
            )
            assert(
                packets.findIndex((packet) => packet.id === 6102) < packets.findIndex((packet) => packet.id === 6113),
            )
            guids.push(field.guid)
            assert.equal(fields().length, i + 1)
            assert.deepEqual(assets(f.state()), initialAssets)
        }
        assert.equal(new Set(guids).size, 4)
        before = f.state()
        const retry = f.call('FieldOpen', open(0)).find((packet) => packet.id === 6113).data
        assert.equal(retry.guid, guids[0], 'same-location retry keeps its accepted field')
        assert.deepEqual(f.state(), before)
        assert.throws(() => f.call('FieldOpen', open(4)), /limit/)
        assert.deepEqual(f.state(), before, 'full quota cannot allocate a GUID, lose a building or charge resources')
        setLevel(21)
        assert.equal(quota(), 4)
        before = f.state()
        assert.throws(() => f.call('FieldOpen', open(4)), /limit/)
        assert.deepEqual(f.state(), before)
        setLevel(22)
        assert.equal(quota(), 8)
        before = f.state()
        const encode = f.protocol.encode.bind(f.protocol)
        f.protocol.encode = (type, value) => {
            if (type === f.protocol.byId.get(6102).rsp) throw Error('field-open codec')
            return encode(type, value)
        }
        assert.throws(() => f.call('FieldOpen', open(4)), /field-open codec/)
        assert.deepEqual(
            f.state(),
            before,
            'sync encoding failure rolls back new field, allocator, assets and reclamation counter',
        )
        f.protocol.encode = encode
        const upgradedPackets = f.call('FieldOpen', open(4)),
            field = upgradedPackets.find((packet) => packet.id === 6113).data
        assert.equal(upgradedPackets.find((packet) => packet.id === 6102).data.home_level_new_base.level, 22)
        assert.equal(fields().length, 5)
        assert(field.guid > Math.max(...guids))
        assert.deepEqual(assets(f.state()), assets(before))
        assert.equal(f.state().home.reclamationProgress.countsByType[3], 5)
    } finally {
        f.store.close()
    }
})
