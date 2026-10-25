import test from 'node:test'
import assert from 'node:assert/strict'
import { farmHarvestFixture } from './farm-harvest-fixture.js'
import { farmHarvestProgressValue } from '../src/farm-harvest-progress.js'
import { ensureHomeFarmHouses } from '../src/home.js'
import { gridAnchor } from '../src/home-grid.js'
import { ErrorCode } from '../src/error-codes.js'
function pending(f) {
    f.assign()
    f.grow(31)
    f.harvest(100, true)
    f.edit((s) => {
        const original = s.home.builds.find((row) => row.guid === 20)
        s.home.builds.push({
            guid: 21,
            build_id: original.build_id,
            build_type: 16,
            status: 1,
            locate: { block_id: 101, anchor: gridAnchor(-44, -10), direction: 0 },
        })
        ensureHomeFarmHouses(f.tables, s)
    })
    f.assign(21)
    f.grow(32)
    f.harvest(100, true)
    assert(
        f
            .state()
            .home.builds.find((row) => row.guid === 20)
            .auto_info.crops.some((row) => row.itemid === 305901),
    )
    assert(
        f
            .state()
            .home.builds.find((row) => row.guid === 21)
            .auto_info.crops.some((row) => row.itemid === 305902),
    )
}
const value = (f, id) => farmHarvestProgressValue(f.tables, f.state(), [12062, 3, id, 10000])

test('6554 merges two real farm-house pending rewards after distinct actual worker assignments and credits each acquired product once', () => {
    const f = farmHarvestFixture('farm-aggregate-real')
    try {
        pending(f)
        assert.equal(value(f, 305901), 0)
        assert.equal(value(f, 305902), 0)
        const packet = f.call('GetAllBuildReward', { build_guid: [20, 21] }).find((row) => row.id === 6554)
        const response = f.protocol.decode(f.protocol.byId.get(6554).rsp, packet.payload)
        assert.equal(response.base.filter((row) => row.type === 16).length, 1)
        assert.equal(value(f, 305901), 4)
        assert.equal(value(f, 305902), 4)
        assert.equal(f.state().home.farmHarvestProgress.revision, 2)
        const once = f.state()
        f.call('GetAllBuildReward', { build_guid: [20, 21] })
        assert.deepEqual(f.state().home.farmHarvestProgress, once.home.farmHarvestProgress)
        assert.deepEqual(f.state().player, once.player)
    } finally {
        f.close()
    }
})

test('6554 invalid batches and ACK failure keep all real farm pending,rewards and typed facts atomic', () => {
    const f = farmHarvestFixture('farm-aggregate-atomic')
    try {
        pending(f)
        const before = f.state(),
            encode = f.protocol.encode
        for (const [ids, code] of [
            [[20, 20], ErrorCode.InvalidArgument],
            [[20, 0xffffffff], ErrorCode.HomeNoBuild],
        ]) {
            assert.throws(
                () => f.call('GetAllBuildReward', { build_guid: ids }),
                (e) => e.code === code,
            )
            assert.deepEqual(f.state(), before)
        }
        let visited = false
        f.protocol.encode = function (name, payload) {
            if (name === f.protocol.byId.get(6554).rsp) {
                visited = true
                throw Error('farm-aggregate-encode')
            }
            return encode.call(this, name, payload)
        }
        assert.throws(() => f.call('GetAllBuildReward', { build_guid: [20, 21] }), /farm-aggregate-encode/)
        assert(visited)
        assert.deepEqual(f.state(), before)
        f.protocol.encode = encode
        f.call('GetAllBuildReward', { build_guid: [20, 21] })
        assert.equal(value(f, 305901), 4)
        assert.equal(value(f, 305902), 4)
    } finally {
        f.close()
    }
})
