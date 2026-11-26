import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { grantRewards } from '../src/rewards.js'
import { validateRewardDefinitions } from '../src/reward-definitions.js'
import { grantWorldPoint } from '../src/world-point-rewards.js'
import { WorldObjectCatalog } from '../src/world-objects.js'
import { ErrorCode } from '../src/error-codes.js'
import { petCosmeticsFixture } from './pet-cosmetics-fixture.js'

const tables = new Tables(configuration().tables)

test('all actual point-drop definitions unlock the matching current birth point once without creating bag items', () => {
    const drops = tables.get('drop').filter((row) => row.type === 21)
    assert.equal(drops.length, 9)
    const state = { world: { map_id: 101, points: [] } }
    for (const drop of drops) {
        const reward = { itemtype: 21, itemid: drop.itemId, itemnum: 1 }
        assert.deepEqual(validateRewardDefinitions(tables, [reward]), [reward])
        assert.deepEqual(grantRewards(tables, state, [reward]), [])
        assert(state.world.points.includes(drop.itemId))
        assert.equal(grantWorldPoint(tables, state, drop.itemId), false)
    }
    assert.equal(state.world.points.length, 9)
    assert.equal(state.worldPointRewardRevision, 9)
    assert.equal(state.player, undefined)
    assert.throws(
        () => grantWorldPoint(tables, state, 0),
        (error) => error.code === ErrorCode.NotFoundBirthPoint,
    )
    assert.throws(
        () => grantRewards(tables, state, [{ itemtype: 21, itemid: drops[0].itemId, itemnum: 2 }]),
        (error) => error.code === ErrorCode.GameConfig,
    )
})

test('real current world-object status reward unlocks and synchronizes its point before interaction acknowledgement', () => {
    const f = petCosmeticsFixture('obt-point-reward')
    try {
        const catalog = new WorldObjectCatalog(tables)
        const { row, pos } = catalog.object(100, 1001411)
        assert.equal(row.statusReward, '1001410')
        f.store.transact(f.session.id, 0, (state) => {
            Object.assign(state.world, { map_id: row.cityId, point_id: 10040, pos, area_id: Number(row.worldAreaIds) })
            state.world.points = state.world.points.filter((id) => id !== 1001410)
            delete state.worldObjects?.['100:1001411']
        })
        const lockedSession = {}
        f.login(lockedSession)
        const lockedWorld = f.call('EnterWorldMap', { map_id: row.cityId }, lockedSession)
        assert(!f.decode(lockedWorld, 9105).u32s.includes(1001410))
        const request = { objs: [{ obj: { obj_id: row.id, complete: true, state_data: { step: 1, complete: true } } }] }
        const packets = f.call('WorldObjInteract', request, lockedSession)
        assert(f.state().world.points.includes(1001410))
        assert(packets.some((packet) => packet.id === 9105))
        assert(packets.findIndex((packet) => packet.id === 9105) < packets.findIndex((packet) => packet.id === 9133))
        assert(f.decode(packets, 9105).u32s.includes(1001410))
        assert.deepEqual(f.decode(packets, 9133).objs[0].rewards.rewards ?? [], [])
        const revision = f.state().worldPointRewardRevision
        f.call('WorldObjInteract', request, lockedSession)
        assert.equal(f.state().worldPointRewardRevision, revision)
        assert.equal(f.state().world.points.filter((id) => id === 1001410).length, 1)
        const newSession = {}
        f.login(newSession)
        const enteredWorld = f.call('EnterWorldMap', { map_id: row.cityId }, newSession)
        assert(f.decode(enteredWorld, 9105).u32s.includes(1001410))
    } finally {
        f.store.close()
    }
})
