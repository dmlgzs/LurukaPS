import test from 'node:test'
import assert from 'node:assert/strict'
import { farmHarvestFixture } from './farm-harvest-fixture.js'
import { farmHarvestProgressValue } from '../src/farm-harvest-progress.js'
import { ErrorCode } from '../src/error-codes.js'
const value = (f, id) => farmHarvestProgressValue(f.tables, f.state(), [12062, 3, id, 10000])
const manual = (f) => farmHarvestProgressValue(f.tables, f.state(), [12005, 15, 10000])

test('6157 credits real assigned-worker products only when claimed,including unversioned pending and missing old saved build_type', () => {
    const f = farmHarvestFixture('farm-storage-real')
    try {
        f.assign()
        for (let cycle = 0; cycle < 2; cycle++) {
            f.grow(31)
            f.harvest(100, true)
        }
        assert.equal(value(f, 305901), 0)
        f.edit((s) => {
            delete s.home.builds.find((row) => row.guid === 20).build_type
        })
        const reply = f.call('GetAutoWorkCropReward', { u32: 20 }).find((row) => row.id === 6157)
        assert(
            f.protocol
                .decode(f.protocol.byId.get(6157).rsp, reply.payload)
                .reward.rewards.some((row) => row.itemid === 305901 && row.itemnum === 8),
        )
        assert.equal(value(f, 305901), 8)
        assert.equal(manual(f), 0)
        assert.deepEqual(f.state().home.farmHarvestProgress.roots, {})
        const once = f.state()
        f.call('GetAutoWorkCropReward', { u32: 20 })
        assert.deepEqual(f.state().home.farmHarvestProgress, once.home.farmHarvestProgress)
        assert.deepEqual(f.state().player, once.player)
    } finally {
        f.close()
    }
})

test('6157 excludes actual returned seed andEXP,while uncertain legacy storage awards remain payable and diagnosed once', () => {
    const f = farmHarvestFixture('farm-storage-roles'),
        warn = console.warn,
        logs = []
    console.warn = (...args) => {
        if (args[0] === '[farm-harvest-progress]') logs.push(JSON.parse(args[1]))
        else warn(...args)
    }
    try {
        f.assign()
        f.grow(31, 100, { seedReturn: true })
        f.harvest(100, true)
        f.grow(1)
        f.harvest(100, true)
        const house = f.state().home.builds.find((row) => row.guid === 20)
        assert(house.auto_info.crops.some((row) => row.itemid === 310901))
        assert(house.auto_info.crops.some((row) => row.itemtype === 10 && row.itemid === 1003))
        f.call('GetAutoWorkCropReward', { u32: 20 })
        assert.equal(value(f, 305901), 4)
        assert.equal(value(f, 400101), 4)
        assert.equal(logs.length, 0)
        for (let cycle = 0; cycle < 2; cycle++) {
            f.grow(32)
            f.harvest(100, true)
            f.edit((s) =>
                s.home.builds
                    .find((row) => row.guid === 20)
                    .auto_info.crops.push({ itemtype: 3, itemid: 300000, itemnum: 1 }),
            )
            const before = f
                .state()
                .player.sbag_infos.items.filter((row) => row.itemid === 300000)
                .reduce((n, row) => n + row.itemnum, 0)
            f.call('GetAutoWorkCropReward', { u32: 20 })
            assert.equal(
                f
                    .state()
                    .player.sbag_infos.items.filter((row) => row.itemid === 300000)
                    .reduce((n, row) => n + row.itemnum, 0) - before,
                1,
            )
        }
        assert.equal(value(f, 305902), 8)
        assert.equal(manual(f), 0)
        assert.equal(logs.filter((row) => row.item === '3:300000').length, 1)
    } finally {
        console.warn = warn
        f.close()
    }
})

test('6157 codec and actual SQLite save failures keep old pending inventory and source facts atomic,with invalid houses rejected', () => {
    const f = farmHarvestFixture('farm-storage-atomic')
    try {
        f.assign()
        f.grow(32)
        f.harvest(100, true)
        const before = f.state(),
            encode = f.protocol.encode
        assert.throws(
            () => f.call('GetAutoWorkCropReward', { u32: 100 }),
            (e) => e.code === ErrorCode.BuildPetAutoWorkInvalid,
        )
        assert.deepEqual(f.state(), before)
        let visited = false
        f.protocol.encode = function (name, payload) {
            if (name === f.protocol.byId.get(6157).rsp) {
                visited = true
                throw Error('farm-storage-codec')
            }
            return encode.call(this, name, payload)
        }
        assert.throws(() => f.call('GetAutoWorkCropReward', { u32: 20 }), /farm-storage-codec/)
        assert(visited)
        assert.deepEqual(f.state(), before)
        f.protocol.encode = encode
        f.store.db.exec(
            "CREATE TEMP TRIGGER farm_storage_fail BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT, 'farm-storage-sql'); END",
        )
        assert.throws(() => f.call('GetAutoWorkCropReward', { u32: 20 }), /farm-storage-sql/)
        assert.deepEqual(f.state(), before)
        f.store.db.exec('DROP TRIGGER farm_storage_fail')
        f.call('GetAutoWorkCropReward', { u32: 20 })
        assert.equal(value(f, 305902), 4)
        assert.equal(f.state().home.farmHarvestProgress.revision, 1)
    } finally {
        f.close()
    }
})
