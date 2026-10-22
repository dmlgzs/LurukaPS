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
import { gridAnchor, gridPosition } from '../src/home-grid.js'
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
test('existing upgraded fertile fields with zero new slots move atomically through old cells; opening a new field remains prohibited', () => {
    const f = fixture()
    try {
        assert.equal(
            tables
                .get('home_building_num')
                .filter((r) => r.groupId === 2033)
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
