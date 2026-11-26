import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { grantRewards, parseRewards } from '../src/rewards.js'
import { productionMaterials } from '../src/production-materials.js'
import { gridAnchor, gridPosition, validatePlacement } from '../src/home-grid.js'
import { ErrorCode } from '../src/error-codes.js'

const config = configuration(),
    tables = new Tables(config.tables)
const recipe = tables.find('products', 710000),
    buildingId = parseRewards(recipe.rewardId)[0].itemid
assert.deepEqual(parseRewards(recipe.rewardId), [{ itemtype: 13, itemid: 10000, itemnum: 1 }])

// Current HomeStore.OnSCHome_6102 / SyncHomeBuild / HomeBuildData.Populate projection;
// ordinary workbench rendering uses TDHomeBuilding.objId -> TDHomeObject.objResouce.
class HomeConsumer {
    bag = new Map()
    world = new Map()
    constructor(protocol) {
        this.protocol = protocol
    }
    consume(packets) {
        for (const packet of packets) {
            if (packet.id === 6102) {
                const data = this.protocol.decode('cs.SCHomeSync', packet.payload)
                for (const row of data.builds ?? [])
                    this.bag.set(row.build_id, {
                        total: row.total_num ?? 0,
                        used: row.used_num ?? 0,
                        unlock: row.unlock ?? false,
                    })
                for (const guid of data.del_builds ?? []) this.world.delete(guid)
                for (const row of data.home_builds ?? []) {
                    if (!row.build_id || [53, 55].includes(row.build_type)) continue
                    const building = tables.find('home_building', row.build_id)
                    const group = tables.get('home_building_group').find((item) => item.groupId === building.groupId)
                    const object = tables.find('home_object', building.objId)
                    assert.equal(row.build_type, group.type)
                    assert(object?.objResouce)
                    assert(row.locate && tables.find('home_block', row.locate.block_id))
                    const position = gridPosition(row.locate.anchor)
                    this.world.set(row.guid, {
                        guid: row.guid,
                        id: row.build_id,
                        type: row.build_type,
                        status: row.status,
                        locate: structuredClone(row.locate),
                        objectId: object.id,
                        resource: object.objResouce,
                        position: { x: position.x, y: 0, z: position.y },
                    })
                }
            } else if (packet.id === 6105) {
                const placed = this.protocol.decode('cs.WorldMapHomeBuild', packet.payload)
                assert(this.world.has(placed.guid), '6102 must populate the building before placement ACK')
                assert.deepEqual(this.world.get(placed.guid).locate, placed.locate)
            }
        }
    }
}

function open(account, filename, start = 1800000000) {
    const protocol = new Protocol(config.base),
        store = new Store(filename)
    let now = start,
        sequence = 1
    const game = new Game(protocol, store, tables, { clock: () => now }),
        session = {},
        consumer = new HomeConsumer(protocol)
    const call = (name, value = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        const packets = game.dispatch(session, {
            id: entry.id,
            seq: sequence++,
            payload: entry.req ? protocol.encode(entry.req, value) : Buffer.alloc(0),
        })
        consumer.consume(packets)
        return packets
    }
    call('EnterGame', { open_id: account })
    return {
        protocol,
        store,
        game,
        session,
        consumer,
        call,
        state: () => store.load(session.id).state,
        fingerprint: () =>
            createHash('sha256')
                .update(JSON.stringify(store.load(session.id)))
                .digest('hex'),
        edit: (fn) => store.transact(session.id, 0, fn),
        setTime: (value) => {
            now = value
        },
        close: () => {
            if (store.db.open) store.close()
        },
    }
}

function location(f, ignoreGuid = 0) {
    const state = f.state(),
        block = tables.find('home_block', 101)
    const start = block.blockStartPos.split('|').map(Number),
        end = block.blockEndPos.split('|').map(Number)
    const previous = state.home.builds.find((row) => row.guid === ignoreGuid)?.locate
    for (let x = Math.min(start[0], end[0]); x < Math.max(start[0], end[0]); x++)
        for (let y = Math.min(start[1], end[1]); y < Math.max(start[1], end[1]); y++) {
            const locate = {
                block_id: block.id,
                anchor: gridAnchor(x, y),
                direction: 0,
                position: { x, y: 0, z: y },
                rotation: { x: 0, y: 0, z: 0 },
                scale: { x: 1, y: 1, z: 1 },
                center: { x: 0, y: 0, z: 0 },
            }
            if (previous?.anchor === locate.anchor) continue
            try {
                // Geometry planning only. The actual6105 still enforces the unmodified table capacity.
                validatePlacement(tables, state, buildingId, locate, ignoreGuid, { checkLimit: false })
                return locate
            } catch (error) {
                if (error.code !== ErrorCode.InvalidArgument || !/overlaps|outside home block/.test(error.message))
                    throw error
            }
        }
    throw Error('No current legal workbench footprint fits block101')
}

function failCodec(f, type, run) {
    const original = f.protocol.encode,
        before = f.fingerprint()
    f.protocol.encode = function (name, ...args) {
        if (name.replace(/^cs\./, '') === type) throw Error(`injected ${type} codec failure`)
        return original.call(this, name, ...args)
    }
    try {
        assert.throws(run, /codec failure/)
    } finally {
        f.protocol.encode = original
    }
    assert.equal(f.fingerprint(), before, 'failed encoding must roll back inventory, jobs, instances and allocator')
}

function produce(f, codec = false) {
    assert.equal(f.state().home.builds.filter((row) => row.build_id === buildingId).length, 1)
    const source = f.state().home.builds.find((row) => row.build_id === buildingId)
    const costs = productionMaterials(tables, recipe, [])
    f.edit((state) => grantRewards(tables, state, costs))
    const initial = structuredClone(f.state().home.inventory.find((row) => row.build_id === buildingId))
    f.call('ProductStart', { build_guid: source.guid, product_id: recipe.id, count: 1 })
    const job = f.state().home.productionJobs[source.guid][0]
    assert.equal(job.productId, recipe.id)
    f.setTime(job.start + job.seconds)
    const request = { guid: source.guid, product_guids: [job.guid] }
    if (codec) failCodec(f, 'SCProductFinish', () => f.call('ProductFinish', request))
    const packets = f.call('ProductFinish', request)
    const receipt = f.protocol.decode('cs.SCProductFinish', packets.find((packet) => packet.id === 6111).payload)
    assert.deepEqual(
        receipt.reward.rewards.map(({ itemtype, itemid, itemnum }) => ({ itemtype, itemid, itemnum })),
        parseRewards(recipe.rewardId),
    )
    const bag = f.consumer.bag.get(buildingId)
    assert.equal(bag.total, initial.total_num + 1)
    assert.equal(bag.used, initial.used_num)
    assert.equal(bag.unlock, true)
    const before = f.fingerprint()
    assert.throws(
        () => f.call('ProductFinish', request),
        (error) => error.code === ErrorCode.InvalidArgument,
    )
    assert.equal(f.fingerprint(), before, 'duplicate claim cannot grant another building')
    return { source, initial }
}

function place(f, guid = 0) {
    const request = { guid, build_id: buildingId, build_level: 0, locate: location(f, guid) }
    const packets = f.call('BuildLocate', request)
    const syncIndex = packets.findIndex((packet) => packet.id === 6102),
        ackIndex = packets.findIndex((packet) => packet.id === 6105)
    assert(syncIndex >= 0 && syncIndex < ackIndex)
    const placed = f.protocol.decode('cs.WorldMapHomeBuild', packets[ackIndex].payload)
    assert.equal(placed.status, 1)
    assert.equal(
        f.consumer.world.get(placed.guid).resource,
        tables.find('home_object', tables.find('home_building', buildingId).objId).objResouce,
    )
    assert.deepEqual(f.consumer.world.get(placed.guid).position, {
        x: request.locate.position.x,
        y: 0,
        z: request.locate.position.z,
    })
    return placed
}

async function temporary(run) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-home-building-'))
    try {
        await run(path.join(directory, 'state.sqlite'))
    } finally {
        assert(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep + 'lurukaps-home-building-'))
        for (const name of fs.readdirSync(directory)) {
            assert(['state.sqlite', 'state.sqlite-journal'].includes(name))
            fs.unlinkSync(path.join(directory, name))
        }
        fs.rmdirSync(directory)
    }
}

test('current fresh type13 production respects one-slot cap and reuses the stored workbench GUID without losing owned stock', async () => {
    await temporary(async (file) => {
        let f = open('home-building-fresh', file)
        try {
            f.call('EnterHome')
            const { source, initial } = produce(f)
            const before = f.fingerprint()
            assert.throws(
                () => f.call('BuildLocate', { build_id: buildingId, locate: location(f) }),
                /Building group limit reached/,
            )
            assert.equal(f.fingerprint(), before)
            const unlocated = f.call('BuildUnlocate', { guid: source.guid })
            assert(
                f.protocol
                    .decode('cs.SCHomeSync', unlocated.find((packet) => packet.id === 6102).payload)
                    .del_builds.includes(source.guid),
            )
            assert.equal(f.consumer.world.has(source.guid), false)
            const restored = place(f)
            assert.equal(restored.guid, source.guid)
            assert.equal(f.state().home.builds.filter((row) => row.build_id === buildingId).length, 1)
            assert.equal(f.consumer.bag.get(buildingId).total, initial.total_num + 1)
            assert.equal(f.consumer.bag.get(buildingId).used, 1)
            const saved = structuredClone(f.state().home)
            f.close()
            f = open('home-building-fresh', file, 1800000010)
            assert.deepEqual(f.state().home.builds, saved.builds)
            assert.deepEqual(f.state().home.inventory, saved.inventory)
            assert(f.consumer.world.has(source.guid))
            assert.equal(f.consumer.bag.get(buildingId).total - f.consumer.bag.get(buildingId).used, 1)
        } finally {
            f.close()
        }
    })
})

test('current qualified level15 creates a new instance from produced stock with codec rollback, stable movement and cold relogin', async () => {
    await temporary(async (file) => {
        let f = open('home-building-new-instance', file)
        try {
            // Trusted progression baseline: current EXP curve through level14, paid via the ordinary1003 reward model.
            const total = tables
                .get('home_level')
                .filter((row) => row.id < 15)
                .reduce((sum, row) => sum + row.exp, 0)
            f.edit((state) =>
                grantRewards(tables, state, [
                    { itemtype: 10, itemid: 1003, itemnum: total - Number(state.home.experienceTotal) },
                ]),
            )
            assert.equal(f.state().home.level, 15)
            assert.equal(f.state().home.experienceTotal, String(total))
            f.call('EnterHome')
            const originalLayout = f
                .state()
                .home.builds.map(({ guid, build_id, locate }) => ({ guid, build_id, locate }))
            const { initial } = produce(f, true)
            assert.deepEqual(
                f.state().home.builds.map(({ guid, build_id, locate }) => ({ guid, build_id, locate })),
                originalLayout,
            )
            // Production legitimately normalizes its own completed queue to product:[]. Freeze the placement boundary.
            const originalBuilds = structuredClone(f.state().home.builds)
            const request = { build_id: buildingId, locate: location(f) }
            for (const type of ['SCHomeSync', 'WorldMapHomeBuild'])
                failCodec(f, type, () => f.call('BuildLocate', request))
            const placed = place(f)
            assert(!originalBuilds.some((row) => row.guid === placed.guid))
            assert.equal(new Set(f.state().home.builds.map((row) => row.guid)).size, f.state().home.builds.length)
            for (const prior of originalBuilds)
                assert.deepEqual(
                    f.state().home.builds.find((row) => row.guid === prior.guid),
                    prior,
                )
            assert.equal(f.consumer.bag.get(buildingId).total, initial.total_num + 1)
            assert.equal(f.consumer.bag.get(buildingId).used, initial.used_num + 1)
            const allocator = f.state().home.nextBuildGuid,
                beforeMove = f.consumer.bag.get(buildingId)
            const moved = place(f, placed.guid)
            assert.equal(moved.guid, placed.guid)
            assert.notEqual(moved.locate.anchor, placed.locate.anchor)
            assert.equal(f.state().home.nextBuildGuid, allocator)
            assert.deepEqual(f.consumer.bag.get(buildingId), beforeMove)
            const saved = structuredClone(f.state().home)
            f.close()
            f = open('home-building-new-instance', file, 1800000010)
            assert.equal(f.state().home.level, 15)
            assert.deepEqual(f.state().home.builds, saved.builds)
            assert.deepEqual(f.state().home.inventory, saved.inventory)
            assert.equal(f.state().home.nextBuildGuid, allocator)
            assert(f.consumer.world.has(placed.guid))
            assert.equal(f.consumer.world.get(placed.guid).resource, 'FieldItem/Home/pre_home_build_workbench')
        } finally {
            f.close()
        }
    })
})
