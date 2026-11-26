import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { grantRewards, parseRewards } from '../src/rewards.js'
import { validateRewardDefinitions } from '../src/reward-definitions.js'
import { vehicleDefinition, vehicleSnapshot, grantVehicle, vehicleBattleAttributes } from '../src/vehicles.js'
import { ownedMount, repairMountSelection } from '../src/mounts.js'
import { mallConditions } from '../src/mall-conditions.js'
import { ErrorCode } from '../src/error-codes.js'
import { petCosmeticsFixture } from './pet-cosmetics-fixture.js'

const tables = new Tables(configuration().tables)
const reward = parseRewards(tables.find('game_events_day_attendance', 200102).reward)[0]

test('current attendance vehicle grants a stable dedicated instance and all vehicle model/base references validate', () => {
    for (const row of tables.get('vehicle')) vehicleDefinition(tables, row.id)
    const state = { pets: [] }
    const granted = grantRewards(tables, state, [reward])
    assert.equal(granted.length, 1)
    assert.equal(granted[0].itemtype, 41)
    assert.equal(granted[0].itemid, 500930)
    assert.equal(BigInt(granted[0].guid) >> 56n, 32n)
    assert.equal(state.pets.length, 0)
    const attributes = vehicleBattleAttributes(tables, state)[0]
    assert.equal(attributes.type, 32)
    assert.equal(attributes.hero_guid, granted[0].guid)
    assert.equal(
        attributes.modules[0].sub_modules[0].attrs.attrs.find((entry) => entry.attr_id === 35).attr_val,
        '55000',
    )
    assert.equal(state.vehicles[0].conf_id, reward.itemid)
    assert.equal(vehicleSnapshot(tables, state).owned_vehicles[0].roulette_pos, 0)
    assert.deepEqual(grantRewards(tables, state, [reward]), [])
    assert.equal(state.vehicleRevision, 1)
    assert.equal(ownedMount(tables, state, granted[0].guid).vehicle, true)
    assert.deepEqual(validateRewardDefinitions(tables, [reward]), [reward])
    assert.equal(mallConditions(tables, state, `12081#41#${reward.itemid}#0`).passed, false)
    assert.equal(mallConditions(tables, state, `12081#41#${reward.itemid}#1`).passed, true)
    state.mountRideId = granted[0].guid
    state.vehicles[0].roulette_pos = 1
    assert.equal(repairMountSelection(tables, state), false)
    assert.throws(
        () => grantRewards(tables, state, [{ ...reward, itemnum: 2 }]),
        (error) => error.code === ErrorCode.GameConfig,
    )
    assert.throws(
        () => grantVehicle(tables, state, 0),
        (error) => error.code === ErrorCode.GameConfig,
    )
})

test('vehicle acquisition and 6590/6591 roulette synchronize before ACK, survive reconnect and support ride/exit', () => {
    const f = petCosmeticsFixture('obt-vehicle')
    try {
        assert.deepEqual(f.decode(f.packets, 6592).owned_vehicles, [])
        const command = Buffer.from(`give 41 ${reward.itemid} 1`).toString('base64')
        const received = f.call('GMCommand', { command })
        const vehicle = f.state().vehicles[0]
        assert.equal(f.decode(received, 6592).owned_vehicles[0].guid, vehicle.guid)
        const attributePacket = received.find(
            (packet) =>
                packet.id === 10006 &&
                f.protocol
                    .decode(f.protocol.byId.get(10006).rsp, packet.payload)
                    .heros.some((actor) => actor.type === 32),
        )
        assert(attributePacket)
        assert(received.findIndex((packet) => packet.id === 6592) < received.indexOf(attributePacket))
        assert(
            received.indexOf(attributePacket) <
                received.findIndex((packet) => packet.id === f.protocol.byName.get('CSProtoGMCommand').id),
        )
        const assigned = f.call('SetVehicleRoulettePos', { guid: vehicle.guid, pos: 2 })
        assert(assigned.findIndex((p) => p.id === 6592) < assigned.findIndex((p) => p.id === 6590))
        assert.equal(f.decode(assigned, 6592).owned_vehicles[0].roulette_pos, 2)
        assert.equal(f.state().vehicles[0].roulette_pos, 2)
        const otherDefinition = tables.get('vehicle').find((entry) => entry.id !== reward.itemid)
        f.call('GMCommand', { command: Buffer.from(`give 41 ${otherDefinition.id} 1`).toString('base64') })
        const other = f.state().vehicles.find((entry) => entry.conf_id === otherDefinition.id)
        f.call('SetVehicleRoulettePos', { guid: other.guid, pos: 2 })
        assert.equal(f.state().vehicles.find((entry) => entry.guid === vehicle.guid).roulette_pos, 0)
        assert.equal(f.state().vehicles.find((entry) => entry.guid === other.guid).roulette_pos, 2)
        f.call('SetVehicleRoulettePos', { guid: vehicle.guid, pos: 2 })
        assert.equal(f.state().vehicles.find((entry) => entry.guid === other.guid).roulette_pos, 0)
        assert.throws(
            () => f.call('SetVehicleRoulettePos', { guid: vehicle.guid, pos: 9 }),
            (error) => error.code === ErrorCode.VehicleRoulettePosLimit,
        )
        assert.throws(
            () => f.call('SetVehicleRoulettePos', { guid: '1', pos: 1 }),
            (error) => error.code === ErrorCode.VehicleNotOwned,
        )
        f.store.transact(f.session.id, 0, (state) => {
            const row = tables
                .get('world_city')
                .find(
                    (row) =>
                        row.mountAvailable > 0 && tables.get('world_borthpos').some((point) => point.cityId === row.id),
                )
            Object.assign(
                state.world,
                tables.position(tables.get('world_borthpos').find((point) => point.cityId === row.id)),
            )
        })
        const before = f.state().player.group_mgrs
        f.call('WorldMapPlayerStatus', { status: 1, arg: vehicle.guid })
        assert.equal(f.state().world.mount, vehicle.guid)
        f.call('WorldMapPlayerPlayerAction', { action: 1 })
        f.call('WorldMapPlayerStatus', { status: 0, arg: '0' })
        assert.deepEqual(f.state().player.group_mgrs, before)
        assert.equal(f.state().world.mount, '0')
        const removed = f.call('RemoveVehicleRoulettePos', { u32: 2 })
        assert(removed.findIndex((p) => p.id === 6592) < removed.findIndex((p) => p.id === 6591))
        assert.equal(f.decode(removed, 6592).owned_vehicles[0].roulette_pos, 0)
        assert.notEqual(f.state().mountRideId, vehicle.guid)
        const loggedIn = f.login({})
        assert.equal(f.decode(loggedIn, 6592).owned_vehicles[0].guid, vehicle.guid)
        assert(f.decode(loggedIn, 10006).heros.some((actor) => actor.type === 32 && actor.hero_guid === vehicle.guid))
    } finally {
        f.store.close()
    }
})

test('actual second-day attendance dispatch grants type 41 atomically and repeated claim does not duplicate it', () => {
    const f = petCosmeticsFixture('obt-vehicle-sign')
    try {
        const activity = tables.get('game_events').find((row) => row.type === 3 && row.systemId === 2001)
        assert(activity)
        f.store.transact(f.session.id, 0, (state) => {
            state.taskRecords ??= []
            for (const token of String(activity.condition).split('|').filter(Boolean)) {
                const [kind, value] = token.split('#').map(Number)
                if (kind === 2007 || kind === 12045) state.taskRecords.push({ task_id: value, count: 1 })
                if (kind === 2004) state.player.basic_info.lv = Math.max(state.player.basic_info.lv, value)
            }
            f.game.activities.snapshot(state, Math.floor(Date.now() / 1000))
            Object.assign(state.activities[activity.id].sign, { count: 2, reward_count: 1 })
        })
        const claimed = f.call('ActivityDailySign', { u32: activity.id })
        const reply = f.protocol.byName.get('CSProtoActivityDailySign')
        assert(
            claimed.findIndex((packet) => packet.id === 6592) < claimed.findIndex((packet) => packet.id === reply.id),
        )
        assert.equal(f.decode(claimed, reply.id).rewards[0].itemtype, 41)
        assert.equal(f.state().activities[activity.id].sign.reward_count, 2)
        assert.equal(f.state().vehicles.length, 1)
        assert.equal(f.decode(claimed, 6592).owned_vehicles[0].conf_id, 500930)
        f.call('ActivityDailySign', { u32: activity.id })
        assert.equal(f.state().vehicles.length, 1)
    } finally {
        f.store.close()
    }
})
