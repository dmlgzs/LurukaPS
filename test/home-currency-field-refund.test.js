import test from 'node:test'
import assert from 'node:assert/strict'
import { farmHarvestFixture } from './farm-harvest-fixture.js'
import { grantRewards } from '../src/rewards.js'
import { gridAnchor, gridPosition } from '../src/home-grid.js'

function plantedTree(name) {
    const f = farmHarvestFixture(name)
    const root = f.state().home.builds.find((row) => row.crop_info?.field_type === 3)
    const position = gridPosition(root.locate.anchor)
    const followers = [200, 201, 202]
    f.edit((state) => {
        for (const [index, [x, y]] of [
            [2, 0],
            [0, 2],
            [2, 2],
        ].entries())
            state.home.builds.push({
                ...structuredClone(root),
                guid: followers[index],
                locate: { ...root.locate, anchor: gridAnchor(position.x + x, position.y + y) },
            })
        grantRewards(f.tables, state, [{ itemtype: 3, itemid: 310970, itemnum: 1 }])
    })
    f.call('FieldPlant', { plant_info: [{ build_guid: root.guid, seed_id: 310970, follower_build_guids: followers }] })
    return { ...f, root: root.guid, followers }
}
const count = (state) =>
    state.player.sbag_infos.items.filter((row) => row.itemid === 310970).reduce((n, row) => n + row.itemnum, 0)
test('actual6118 returns the configured noncurrency seed and clears all linked fields; no103 refund capability is invented', () => {
    const f = plantedTree('home-currency-field-refund')
    try {
        const before = count(f.state())
        f.call('FieldUnplant', { u32: f.root })
        assert.equal(count(f.state()) - before, 1)
        for (const id of [f.root, ...f.followers]) {
            const crop = f.state().home.builds.find((row) => row.guid === id).crop_info
            assert.equal(crop.seed_id, undefined)
            assert.equal(crop.main_build_guid, undefined)
        }
        assert.equal(f.state().homeCurrencyAcquisition, undefined)
    } finally {
        f.close()
    }
})
test('actual6118 failed home packet preserves the planted tree and refund before one successful retry', () => {
    const f = plantedTree('home-currency-field-codec')
    try {
        const before = f.state(),
            encode = f.protocol.encode.bind(f.protocol)
        f.protocol.encode = (name, ...args) => {
            if (name === f.protocol.byId.get(6102).rsp) throw Error('currency-field-codec')
            return encode(name, ...args)
        }
        try {
            assert.throws(() => f.call('FieldUnplant', { u32: f.root }), /currency-field-codec/)
        } finally {
            f.protocol.encode = encode
        }
        assert.deepEqual(f.state(), before)
        f.call('FieldUnplant', { u32: f.root })
        assert.equal(count(f.state()), count(before) + 1)
        assert.equal(f.state().homeCurrencyAcquisition, undefined)
    } finally {
        f.close()
    }
})
