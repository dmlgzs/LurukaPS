import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Tables } from '../src/player.js'
import { storyCampaignConfig, storyCampaignSnapshot } from '../src/story-campaign.js'

const cfg = configuration(),
    protocol = new Protocol(cfg.base),
    tables = new Tables(cfg.tables)

// The actual battle, partial-exit and task lifecycle now run from the normal
// account prefix in next106014-current.test.js. This pure wire case mirrors
// current DungeonPlayingManager0602c049/4a consumption, not a seeded checkpoint.
test('declared story route is present before future scenes load and survives the current wire codec', () => {
    const config = storyCampaignConfig(tables, 200, 1)
    const scenes = config.scenes.map(({ scene }) => scene.id)
    assert.deepEqual(scenes, [6200, 6201], 'existing explicit local compatibility route')
    for (const [index, map_id] of scenes.entries()) {
        const state = {
            storyCampaign: {
                dungeon_id: config.dungeon.id,
                scenes,
                map_id,
                status: 2,
                start_time: 1800000000,
                completed_scenes: scenes.slice(0, index),
                scene_objects: [{ obj_id: 1500002, active: true, complete: false }],
            },
        }
        const encoded = protocol.encode(
            protocol.byName.get('CSProtoCampaignInfoSync').rsp,
            storyCampaignSnapshot(state),
        )
        const snapshot = protocol.decode(protocol.byName.get('CSProtoCampaignInfoSync').rsp, encoded)
        const ids = snapshot.scene_datas.map((row) => row.scene_id)
        assert.deepEqual(ids, scenes)
        assert.equal(ids.indexOf(snapshot.cur_scene_id) + 1, index + 1)
        assert.equal(ids.indexOf(snapshot.cur_scene_id) === ids.length - 1, index === 1)
        assert.equal(snapshot.scene_datas[index].objs.length, 1)
        assert(snapshot.scene_datas.filter((row) => row.scene_id !== map_id).every((row) => row.objs.length === 0))
        if (index === 0) assert.equal(ids[index + 1], 6201, 'continuous story transfer9506 has its destination')
    }
})

test('campaign object snapshots omit internal claims while retaining server reward receipts', () => {
    const object = {
        obj_id: 1300001,
        active: true,
        complete: false,
        state_data: { step: 1 },
        claims: { complete: true },
    }
    const state = {
        storyCampaign: {
            dungeon_id: 10071,
            map_id: 6224,
            status: 2,
            start_time: 1800000000,
            completed_scenes: [],
            scene_objects: [object],
        },
    }
    const snapshot = storyCampaignSnapshot(state)
    assert.equal('claims' in snapshot.scene_datas[0].objs[0], false)
    assert.deepEqual(object.claims, { complete: true })
    assert.deepEqual(snapshot.scene_datas[0].objs[0].state_data, { step: 1 })
    assert.doesNotThrow(() => protocol.encode(protocol.byName.get('CSProtoCampaignInfoSync').rsp, snapshot))
})
