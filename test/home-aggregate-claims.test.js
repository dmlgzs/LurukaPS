import test from 'node:test'
import assert from 'node:assert/strict'
import { ErrorCode } from '../src/error-codes.js'
import { ensureHomeFarmHouses } from '../src/home.js'
import { ensureCollectionData } from '../src/home-collection.js'
import { storeFarmHarvest } from '../src/farm-storage.js'
import { grantRewards, parseRewards } from '../src/rewards.js'
import { productionTables } from '../src/production-tables.js'
import { assertSyncBefore } from './exchange-sync-assertions.js'
import { fixture as baseFixture, tables, protocol } from './home-collection-fixture.js'

const build = (state, guid) => state.home.builds.find((b) => b.guid === guid)
const stock = (state, id) =>
    state.player.sbag_infos.items.filter((i) => i.itemid === id).reduce((n, i) => n + i.itemnum, 0)
const aggregate = (f, build_guid) => f.call('GetAllBuildReward', { build_guid })
const response = (out) => out.find((p) => p.id === 6554).data
function fixture() {
    const f = baseFixture()
    f.edit((state) => {
        state.player.basic_info.lv = 45
        state.tasks = []
        state.taskRecords = tables
            .get('task')
            .filter((r) => r.type === 1)
            .map((r) => ({ task_id: r.id, count: 1, time: 1 }))
        state.home.level = 1
        for (const type of [11005, 22010, 22020]) state.home.technology.levels[type] = { level: 1, lastTime: 0 }
        for (const [guid, build_id, build_type] of [
            [6, 10000, 2],
            [18, 100011, 10],
            [20, 20171, 16],
            [21, 20171, 16],
            [30, 20241, 8],
            [40, 30231, 12],
        ])
            state.home.builds.push({
                guid,
                build_id,
                build_type,
                status: 1,
                locate: { block_id: 101, anchor: 6750000 + guid, direction: 0 },
            })
        ensureHomeFarmHouses(tables, state)
        ensureCollectionData(state)
        grantRewards(
            tables,
            state,
            [300000, 400301, 400101].map((itemid) => ({ itemtype: 3, itemid, itemnum: 1000 })),
        )
    })
    const advance = f.advance
    f.advance = (seconds, tick = true) => {
        advance(seconds, false)
        return tick
            ? f.game.tick(f.session.id, f.session).map((p) => ({
                  id: p.id,
                  data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload),
              }))
            : []
    }
    return f
}
function collection(f, guid, product, count) {
    const drop = tables.find('home_drop', tables.find('products_collection', product).homeDropId)
    f.edit((state) =>
        build(state, guid).collect_build_data.items.push({
            item_type: drop.itemType,
            item_id: Number(drop.itemId),
            item_num: count,
            source_product_id: product,
        }),
    )
}
const produce = (f, guid = 1, count = 1) => f.call('ProductStart', { build_guid: guid, product_id: 302001, count })

test('6554 claims real queued production, cooking, farm storage and collection, merging by building type before reply', () => {
    const f = fixture()
    try {
        produce(f, 1, 3)
        produce(f, 6, 1)
        f.call('CookRequest', {
            build_guid: 18,
            cook_id: 9000301,
            cook_count: 1,
            cook_material: [{ item_id: 400301, item_num: 6 }],
        })
        f.call('PetStationed', { build_guid: 100, build_type: 1, pet_guid: f.worker })
        f.edit((state) => {
            for (const [guid, count] of [
                [20, 3],
                [21, 2],
            ])
                storeFarmHarvest(build(state, guid), [
                    { itemtype: 3, itemid: 400301, itemnum: count },
                    { itemtype: 10, itemid: 1003, itemnum: 6 },
                ])
            state.home.worldCollections = {
                1: {
                    guid: 999,
                    collect_id: 1,
                    build_id: 1110101,
                    items: [{ item_type: 3, item_id: 300000, item_num: 2, source_product_id: 131010101 }],
                },
            }
        })
        collection(f, 101, 132000101, 1)
        f.advance(36)
        const before = f.state(),
            out = aggregate(f, [1, 6, 18, 20, 21, 100, 101, 999]),
            data = response(out),
            after = f.state()
        assert.deepEqual(
            data.base.map((g) => g.type).sort((a, b) => a - b),
            [2, 10, 16, 24, 55],
        )
        assert.equal(new Set(data.base.map((g) => g.type)).size, data.base.length)
        const reward = (type, id) => data.base.find((g) => g.type === type).award.rewards.find((r) => r.itemid === id)
        assert.equal(reward(2, 350000).itemnum, 4)
        assert.equal(reward(10, 9000301).itemnum, 1)
        assert.equal(reward(16, 400301).itemnum, 5)
        assert.equal(reward(16, 1003).itemnum, 12)
        assert.equal(reward(24, 300000).itemnum, 1)
        assert.equal(reward(55, 300000).itemnum, 2)
        assert.equal(data.home_exp, 12)
        assert.deepEqual(data.new_awards, [])
        assert.equal(BigInt(after.home.experienceTotal), BigInt(before.home.experienceTotal) + 12n)
        assert.equal(after.home.craftCounts[302001], 4)
        for (const id of [350000, 9000301, 400301, 300000]) {
            const count = data.base
                .flatMap((g) => g.award.rewards)
                .filter((r) => r.itemtype === 3 && r.itemid === id)
                .reduce((n, r) => n + r.itemnum, 0)
            assert.equal(stock(after, id), stock(before, id) + count)
        }
        assertSyncBefore(protocol, out, 'CSProtoSyncPlayerData', 6554)
        const homes = assertSyncBefore(protocol, out, 'CSProtoHomeSync', 6554)
        const snapshot = homes.at(-1).data.home_builds
        assert.deepEqual(snapshot.find((b) => b.guid === 100).collect_build_data.items, [])
        assert.deepEqual(snapshot.find((b) => b.guid === 20).auto_info.crops, [])
        assert.deepEqual(after.home.worldCollections[1].items, [])
        assert.equal(out.filter((p) => p.data.rewards?.length).length, 0)
        assert.deepEqual(response(aggregate(f, [1, 6, 18, 20, 21, 100, 101, 999])).base, [])
        assert.equal(stock(f.state(), 350000), stock(after, 350000))
    } finally {
        f.close()
    }
})

test('partial batches retain their queue and individual cancellation refunds only unfinished units after aggregate claim', () => {
    const f = fixture()
    try {
        produce(f, 1, 3)
        produce(f, 1, 1)
        const jobs = f.state().home.productionJobs[1],
            seconds = jobs[0].seconds
        f.advance(seconds)
        const before = f.state(),
            data = response(aggregate(f, [1, 6])),
            state = f.state()
        assert.equal(data.base[0].type, 2)
        assert.equal(data.base[0].award.rewards[0].itemnum, 1)
        assert.equal(state.home.productionJobs[1].length, 2)
        assert.equal(state.home.productionJobs[1][0].claimed, 1)
        assert.equal(state.home.productionJobs[1][0].start, jobs[0].start)
        assert.equal(state.home.productionJobs[1][1].start, jobs[1].start)
        assert.equal(state.home.craftCounts[302001], 1)
        const count = stock(state, 350000),
            wood = stock(state, 300000)
        f.call('ProductCancel', { guid: 1, is_all: true })
        const costs = parseRewards(productionTables(tables).find('products', 302001).material)
        assert.equal(stock(f.state(), 300000), wood + 3 * costs.find((r) => r.itemid === 300000).itemnum)
        assert.equal(stock(f.state(), 350000), count)
        assert.equal(stock(f.state(), 350000), stock(before, 350000) + 1)
        assert.deepEqual(f.state().home.productionJobs[1], [])
    } finally {
        f.close()
    }
})

test('accessory aggregate claim uses the sealed production result and publishes its real instance before 6554', () => {
    const f = fixture()
    try {
        f.edit((state) => {
            state.materialDungeonRecords = Object.fromEntries(
                tables
                    .get('dungeon_material')
                    .map((r) => [r.id, { material_id: r.id, material_star: 0, success_count: 1 }]),
            )
            const costs = new Map()
            for (const r of tables.get('accessory_product'))
                for (const item of [...parseRewards(r.material), ...parseRewards(r.locateCost)])
                    costs.set(item.itemtype + ':' + item.itemid, { ...item, itemnum: 10000 })
            grantRewards(tables, state, [...costs.values()])
        })
        f.call('ProductOrnamentStart', { build_guid: 30, product_id: 1, count: 1 })
        const job = f.state().home.productionJobs[30][0]
        f.advance(job.seconds)
        const out = aggregate(f, [30]),
            award = response(out).base[0].award
        assert.equal(response(out).base[0].type, 8)
        assert.equal(award.src, 37)
        assert.equal(award.rewards.length, 1)
        const item = award.rewards[0]
        assert.equal(item.itemtype, 15)
        const owned = f.state().ornaments.find((r) => String(r.guid) === item.guid)
        assert(owned)
        assert.equal(owned.id, item.itemid)
        assert.equal(tables.find('accessory_customed', job.rewards[0].itemid).accessoryId, item.itemid)
        const sync = assertSyncBefore(protocol, out, 'CSProtoUpdateOrnament', 6554)
        assert(sync.some((p) => p.data.ornaments.some((r) => String(r.guid) === item.guid)))
        assert.throws(
            () => f.call('ProductFinish', { guid: 30, is_all: true }),
            /Invalid production selection|No finished/,
        )
        assert.equal(f.state().ornaments.length, 1)
    } finally {
        f.close()
    }
})

test('explicit or stale ranch and hatch entries are skipped without consuming their stored rewards or ready egg', () => {
    const f = fixture()
    try {
        produce(f)
        f.edit((state) => {
            grantRewards(tables, state, [{ itemtype: 14, itemid: 40003007, itemnum: 1 }])
            const ranch = Object.values(state.home.ranches)[0]
            ranch.stores = [{ itemtype: 3, itemid: 300000, itemnum: 5 }]
        })
        const egg = f.state().petEggs[0]
        f.call('HatchPetEgg', { build_guid: 40, egg_guid: egg.guid })
        f.advance(tables.find('pet_egg', egg.configid).eggTime)
        const before = f.state(),
            ranch = Object.values(before.home.ranches)[0]
        const data = response(aggregate(f, [1, 40, ranch.guid]))
        assert.deepEqual(
            data.base.map((g) => g.type),
            [2],
        )
        assert.deepEqual(f.state().home.ranches, before.home.ranches)
        assert.deepEqual(f.state().petEggs, before.petEggs)
        assert.equal(f.state().pets.length, before.pets.length)
        assert.equal(f.state().home.productionJobs[40][0].claimed, 0)
        assert.deepEqual(response(aggregate(f, [40, ranch.guid])).base, [])
    } finally {
        f.close()
    }
})

test('a failed later farm reward or invalid selection rolls back earlier queued production and all counters', () => {
    const f = fixture()
    try {
        produce(f)
        f.advance(f.state().home.productionJobs[1][0].seconds)
        f.edit((state) =>
            storeFarmHarvest(build(state, 20), [
                { itemtype: 3, itemid: 400301, itemnum: 2 },
                { itemtype: 999, itemid: 1, itemnum: 1 },
            ]),
        )
        for (const ids of [[], [1, 1], [1, 999999], [1, 20]]) {
            const before = f.store.load(f.session.id)
            assert.throws(() => aggregate(f, ids))
            assert.deepEqual(f.store.load(f.session.id), before)
        }
        f.edit((state) => {
            build(state, 20).auto_info.crops.pop()
        })
        const data = response(aggregate(f, [1, 20]))
        assert.deepEqual(
            data.base.map((g) => g.type),
            [2, 16],
        )
        assert.equal(f.state().home.craftCounts[302001], 1)
    } finally {
        f.close()
    }
})

test('reply encoding and egg capacity failures roll back every warehouse, queued product and egg allocation', () => {
    const f = fixture(),
        encode = protocol.encode
    try {
        produce(f)
        f.advance(f.state().home.productionJobs[1][0].seconds)
        collection(f, 104, 138000501, 1)
        const before = f.store.load(f.session.id),
            entry = protocol.byName.get('CSProtoGetAllBuildReward')
        protocol.encode = function (type, data, ...args) {
            if (type === entry.rsp && data?.base?.length) throw Error('aggregate reply failed')
            return encode.call(this, type, data, ...args)
        }
        assert.throws(() => aggregate(f, [1, 104]), /aggregate reply failed/)
        assert.deepEqual(f.store.load(f.session.id), before)
        protocol.encode = encode
        f.edit((state) => {
            state.petEggs = Array.from(
                { length: Number(tables.get('game').find((r) => r.title === 'PET_EGG_LIMITS').value) },
                (_, i) => ({ guid: i + 1, configid: 20101001, egg_affix: [], hatch_state: 0 }),
            )
        })
        const full = f.store.load(f.session.id)
        assert.throws(
            () => aggregate(f, [1, 104]),
            (e) => e.code === ErrorCode.EggBagNumIsMax,
        )
        assert.deepEqual(f.store.load(f.session.id), full)
        f.edit((state) => {
            state.petEggs = []
        })
        const out = aggregate(f, [1, 104])
        const eggs = assertSyncBefore(protocol, out, 'CSProtoPetEggInfoSync', 6554)
        assert.equal(eggs.at(-1).data.egg_infos.eggs.length, 1)
        const after = f.state()
        assert.deepEqual(response(aggregate(f, [1, 104])).base, [])
        assert.deepEqual(f.state().petEggs, after.petEggs)
        assert.equal(stock(f.state(), 350000), stock(after, 350000))
    } finally {
        protocol.encode = encode
        f.close()
    }
})

test('aggregate claims only the requested GUIDs and leaves other ready queues and warehouses collectible', () => {
    const f = fixture()
    try {
        produce(f, 1)
        produce(f, 6)
        collection(f, 100, 131000101, 3)
        f.edit((state) => storeFarmHarvest(build(state, 20), [{ itemtype: 3, itemid: 300000, itemnum: 7 }]))
        f.advance(f.state().home.productionJobs[1][0].seconds)
        const before = f.state(),
            data = response(aggregate(f, [1])),
            state = f.state()
        assert.deepEqual(
            data.base.map((g) => g.type),
            [2],
        )
        assert.equal(state.home.productionJobs[6][0].claimed, 0)
        assert.deepEqual(build(state, 100).collect_build_data.items, build(before, 100).collect_build_data.items)
        assert.deepEqual(build(state, 20).auto_info.crops, build(before, 20).auto_info.crops)
        const rest = response(aggregate(f, [6, 100, 20]))
        assert.deepEqual(
            rest.base.map((g) => g.type).sort((a, b) => a - b),
            [2, 16, 24],
        )
        assert.equal(f.state().home.craftCounts[302001], 2)
    } finally {
        f.close()
    }
})

test('unplaced, constructing, unsupported and ambiguous building records reject the batch without paying earlier targets', () => {
    const f = fixture()
    try {
        produce(f)
        f.advance(f.state().home.productionJobs[1][0].seconds)
        const rejects = (ids, code) => {
            const before = f.store.load(f.session.id)
            assert.throws(
                () => aggregate(f, ids),
                (e) => e.code === code,
            )
            assert.deepEqual(f.store.load(f.session.id), before)
        }
        f.edit((state) => {
            delete build(state, 20).locate
        })
        rejects([1, 20], ErrorCode.HomeNoBuild)
        f.edit((state) => {
            build(state, 20).locate = build(state, 21).locate
            build(state, 20).status = 2
        })
        rejects([1, 20], ErrorCode.HomeBuildInvalidStatus)
        f.edit((state) => {
            state.home.worldCollections = { 1: { guid: 1, collect_id: 1, build_id: 1110101, items: [] } }
        })
        rejects([1], ErrorCode.GameConfig)
        const config = tables.get('home_building').find((b) => {
            const g = tables.get('home_building_group').find((g) => g.groupId === b.groupId)
            return (
                g && ![16, 24].includes(g.type) && b.groupId !== 3023 && !tables.find('home_building_production', b.id)
            )
        })
        assert(config)
        const group = tables.get('home_building_group').find((g) => g.groupId === config.groupId)
        f.edit((state) => {
            state.home.worldCollections = {}
            state.home.builds.push({
                guid: 50,
                build_id: config.id,
                build_type: group.type,
                status: 1,
                locate: { block_id: 101, anchor: 6750050, direction: 0 },
            })
        })
        rejects([1, 50], ErrorCode.FunctionClosed)
    } finally {
        f.close()
    }
})
