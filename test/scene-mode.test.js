import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { sceneModePayload } from '../src/scene-mode.js'
import { petCosmeticsFixture } from './pet-cosmetics-fixture.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
test('current home/overworld modes use current scene_mode identities rather than retired enum values', () => {
    for (const city of tables
        .get('world_city')
        .filter((row) => [1, 3, 7, 11, 20, 21, 26, 28, 29, 101].includes(row.type))) {
        const payload = sceneModePayload(tables, { world: { map_id: city.id } })
        assert(payload, `map ${city.id}`)
        assert.equal(tables.find('scene_mode', payload.mode).sceneTypeId, city.type)
        protocol.encode('cs.SceneModeChange', payload)
    }
    assert.deepEqual(sceneModePayload(tables, { world: { map_id: 701 } }), { mode: 3 })
    assert.deepEqual(sceneModePayload(tables, { world: { map_id: 100 } }), { mode: 1 })
})

test('material/weekly/entrust modes select actual dungeonType with multiple-playing authority', () => {
    const city = tables.get('world_city').find((row) => row.type === 12)
    for (const [dungeon_id, expected] of [
        [3580, 8],
        [35750, 13],
        [3590, 11],
    ]) {
        assert.deepEqual(
            sceneModePayload(tables, { world: { map_id: city.id }, entrust: { run: { map_id: city.id, dungeon_id } } }),
            { mode: expected },
        )
    }
})

test('real scene-load notification9151 sends11055 home mode without a fictitious9151 response', () => {
    const f = petCosmeticsFixture('obt-scene-mode')
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.world.map_id = 701
        })
        const packets = f.call('MapLoadFinish')
        assert.equal(
            packets.some((p) => p.id === 9151),
            false,
        )
        assert.equal(f.decode(packets, 11055).mode, 3)
        assert.equal(f.state().world.map_id, 701)
    } finally {
        f.store.close()
    }
})
