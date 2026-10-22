import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'
import { constrainedEggPools, selectBaseHatchSpecies } from '../src/egg-pools.js'
import { collectionPlan } from '../src/home-collection.js'
import { assertSyncBefore } from './exchange-sync-assertions.js'
import { fixture, tables, protocol } from './home-collection-fixture.js'

const build = (state, guid = 100) => state.home.builds.find((b) => b.guid === guid)
const stock = (state, id) =>
    state.player.sbag_infos.items.filter((i) => i.itemid === id).reduce((n, i) => n + i.itemnum, 0)
const claim = (f, guid = [100]) => f.call('CollectGetReward', { guid })
function seed(f, entries, guid = 100) {
    f.edit((state) => {
        build(state, guid).collect_build_data = {
            guid,
            build_id: build(state, guid).build_id,
            pet_guid: '0',
            start_time: 0,
            product_infos: [],
            items: entries.map(([id, count]) => {
                const p = tables.find('products_collection', id),
                    drop = tables.find('home_drop', p.homeDropId)
                return {
                    item_type: drop.itemType,
                    item_id: Number(drop.itemId),
                    item_num: count,
                    source_product_id: id,
                }
            }),
        }
    })
}

test('6529 grants actual elapsed stock and home XP, then clears warehouse before the only Rewards presentation', () => {
    const f = fixture()
    try {
        f.edit((state) => {
            state.home.level = 1
        })
        f.call('PetStationed', { build_guid: 100, build_type: 1, pet_guid: f.worker })
        f.advance(360)
        const before = f.state(),
            out = claim(f),
            after = f.state()
        const response = out.find((p) => p.id === 6529).data
        assert.equal(response.src, 68)
        for (const item of build(before).collect_build_data.items) {
            const actual = response.rewards.find((r) => r.itemtype === item.item_type && r.itemid === item.item_id)
            assert.equal(actual.itemnum, item.item_num)
            if (item.item_type === 3)
                assert.equal(stock(after, item.item_id), stock(before, item.item_id) + item.item_num)
        }
        assert.equal(BigInt(after.home.experienceTotal), BigInt(before.home.experienceTotal) + 6n)
        assert.equal(after.home.level, 1)
        const snapshots = assertSyncBefore(protocol, out, 'CSProtoSyncPlayerData', 6529)
        assert(
            snapshots.some((p) =>
                p.data.sbag_infos.items.some((i) => i.itemid === 300000 && i.itemnum === stock(after, 300000)),
            ),
        )
        const homes = assertSyncBefore(protocol, out, 'CSProtoHomeSync', 6529)
        assert.deepEqual(homes.at(-1).data.home_builds.find((b) => b.guid === 100).collect_build_data.items, [])
        assert.equal(out.filter((p) => p.data.rewards?.length).length, 1)
        assert.deepEqual(build(after).collect_build_data.items, [])
        const receipt = f.store.load(f.session.id)
        assert.throws(
            () => claim(f),
            (e) => e.code === ErrorCode.CollectRewardNull,
        )
        assert.deepEqual(f.store.load(f.session.id), receipt)
        f.call('EnterGame', { open_id: 'home-collection' }, {})
        assert.equal(stock(f.state(), 300000), stock(after, 300000))
        assert.deepEqual(build(f.state()).collect_build_data.items, [])
    } finally {
        f.close()
    }
})

test('multi-building claims merge fungible sources, retain eggs by GUID, and work after withdrawing workers', () => {
    const f = fixture()
    try {
        seed(f, [
            [131000101, 2],
            [131010101, 3],
        ])
        seed(
            f,
            [
                [131000101, 4],
                [138000501, 2],
            ],
            104,
        )
        const before = stock(f.state(), 300000),
            out = claim(f, [100, 104, 101])
        const response = out.find((p) => p.id === 6529).data
        assert.deepEqual(
            response.rewards
                .filter((r) => r.itemtype === 3)
                .map(({ itemtype, itemid, itemnum }) => ({ itemtype, itemid, itemnum })),
            [{ itemtype: 3, itemid: 300000, itemnum: 9 }],
        )
        const eggs = response.rewards.filter((r) => r.itemtype === 14)
        assert.equal(eggs.length, 2)
        assert.notEqual(eggs[0].guid, eggs[1].guid)
        assert.equal(stock(f.state(), 300000), before + 9)
        const sync = assertSyncBefore(protocol, out, 'CSProtoPetEggInfoSync', 6529)
        for (const egg of eggs) assert(sync.at(-1).data.egg_infos.eggs.some((e) => String(e.guid) === egg.guid))
        for (const guid of [100, 101, 104]) assert.deepEqual(build(f.state(), guid).collect_build_data.items, [])
    } finally {
        f.close()
    }
})

test('all current collection egg templates grant their actual identity/affixes, and the constrained egg hatches in its element', () => {
    const f = fixture()
    try {
        const ids = [
            ...new Set(tables.get('home_building_homecollection').flatMap((b) => b.products.split('|').map(Number))),
        ]
        f.edit((state) => {
            state.home.worldCollections = Object.fromEntries(
                tables.get('home_collection_world').map((world) => {
                    const b = tables
                        .get('home_building_collection')
                        .find((b) => b.groupId === world.groupId && b.level === 1)
                    return [world.id, { collect_id: world.id, build_id: b.id, guid: 1000 + world.id, items: [] }]
                }),
            )
        })
        const state = f.state(),
            plan = collectionPlan(tables, state, build(state, 104)),
            byEgg = new Map()
        for (const stream of plan.streams.filter((s) => s.drop.itemType === 14)) {
            const id = Number(stream.drop.itemId)
            if (!byEgg.has(id) || stream.drop.elementTypeId || stream.drop.raceId) byEgg.set(id, stream.product)
        }
        assert.equal(byEgg.size, 9)
        assert(ids.includes(138000501))
        seed(
            f,
            [...byEgg.values()].map((id) => [id, 1]),
            104,
        )
        const out = claim(f, [104]),
            eggs = f.state().petEggs
        assert.equal(out.find((p) => p.id === 6529).data.rewards.filter((r) => r.itemtype === 14).length, 9)
        assert.equal(new Set(eggs.map((e) => e.guid)).size, 9)
        const constrained = eggs.find((e) => e.configid === 30201001)
        const constraints = f.state().eggHatchConstraints[constrained.guid]
        assert.deepEqual(constraints, {
            element_type: 1,
            race: 0,
            product_id: 138040301,
            drop_id: 138040301,
        })
        assert.deepEqual(constrained.egg_affix, []) // The real table's zero-affix weighted branch, not forced removal.
        const restored = f.call('EnterGame', { open_id: 'home-collection' }, {})
        assert(restored.some((p) => p.id === 6518 && p.data.egg_infos.eggs.some((e) => e.guid === constrained.guid)))
        assert.deepEqual(f.state().eggHatchConstraints[constrained.guid], constraints)
        const pool = constrainedEggPools(tables, 30201001, constraints)
        assert.deepEqual(
            pool.groups[0].candidates.map((p) => p.id),
            [500817, 500214, 500293, 500812],
        )
        for (const candidate of pool.groups[0].candidates)
            assert(String(tables.find('pet', candidate.id).element).split('|').includes('1'))
        f.edit((state) =>
            state.home.builds.push({
                guid: 200,
                build_id: 30231,
                build_type: 12,
                status: 1,
                locate: { block_id: 101, anchor: 6750100, direction: 0 },
            }),
        )
        let draws = 0
        f.game.rng = () => {
            draws++
            return 0
        }
        f.call('HatchPetEgg', { build_guid: 200, egg_guid: constrained.guid })
        assert.equal(f.state().eggOutcomes[constrained.guid], 500817)
        assert.equal(draws, 2)
        f.call('CancelHatchPetEgg', { build_guid: 200, egg_guid: constrained.guid })
        f.call('HatchPetEgg', { build_guid: 200, egg_guid: constrained.guid })
        assert.equal(draws, 2)
        f.advance(tables.find('pet_egg', constrained.configid).eggTime)
        f.call('HatOutPetEgg', { build_guid: 200, egg_guid: constrained.guid })
        assert(f.state().pets.some((p) => p.config_id === 500817))
        assert(!f.state().petEggs.some((e) => e.guid === constrained.guid))
        assert(!f.state().eggHatchConstraints[constrained.guid])
    } finally {
        f.close()
    }
})

test('invalid/foreign selection, corrupt stock and full egg inventory cannot grant or clear any part of a batch', () => {
    const f = fixture()
    try {
        seed(f, [[131000101, 3]])
        seed(f, [[138000501, 1]], 104)
        for (const request of [
            { guid: [] },
            { guid: [100, 100] },
            { guid: [100, 99999] },
            { guid: [100], source_build: 1 },
        ]) {
            const before = f.store.load(f.session.id)
            assert.throws(() => f.call('CollectGetReward', request))
            assert.deepEqual(f.store.load(f.session.id), before)
        }
        f.edit((state) => {
            build(state, 104).collect_build_data.items[0].item_id = 300000
        })
        let before = f.store.load(f.session.id)
        assert.throws(
            () => claim(f, [100, 104]),
            (e) => e.code === ErrorCode.CollectProductnotMatch,
        )
        assert.deepEqual(f.store.load(f.session.id), before)
        seed(f, [[138000501, 1]], 104)
        f.edit((state) => {
            state.petEggs = Array.from(
                { length: Number(tables.get('game').find((r) => r.title === 'PET_EGG_LIMITS').value) },
                (_, i) => ({ guid: i + 1, configid: 20101001, hatch_state: 0, egg_affix: [] }),
            )
        })
        before = f.store.load(f.session.id)
        assert.throws(
            () => claim(f, [100, 104]),
            (e) => e.code === ErrorCode.EggBagNumIsMax,
        )
        assert.deepEqual(f.store.load(f.session.id), before)
    } finally {
        f.close()
    }
})

test('response encoding failure rolls back all credits, egg identities and stock; a retry cannot duplicate delivery', () => {
    const f = fixture()
    const encode = protocol.encode
    try {
        seed(f, [
            [131000101, 3],
            [1300511450, 6],
        ])
        seed(f, [[138000501, 1]], 104)
        const entry = protocol.byName.get('CSProtoCollectGetReward')
        const frame = { id: entry.id, seq: 50, payload: protocol.encode(entry.req, { guid: [100, 104] }) }
        const before = f.store.load(f.session.id)
        protocol.encode = function (type, data, ...args) {
            if (type === entry.rsp && data?.rewards?.length) throw Error('claim reply encoding failed')
            return encode.call(this, type, data, ...args)
        }
        assert.throws(() => f.game.dispatch(f.session, frame), /claim reply encoding failed/)
        assert.deepEqual(f.store.load(f.session.id), before)
        protocol.encode = encode
        f.game.dispatch(f.session, frame)
        const once = f.store.load(f.session.id)
        assert.throws(
            () => f.game.dispatch(f.session, frame),
            (e) => e.code === ErrorCode.CollectRewardNull,
        )
        assert.deepEqual(f.store.load(f.session.id), once)
    } finally {
        protocol.encode = encode
        f.close()
    }
})

test('egg constraints retain original candidate weights, support multi-element/race pets and reject empty or malformed filters', () => {
    const constraint = { element_type: 1, race: 5 }
    const groups = constrainedEggPools(tables, 30201001, constraint).groups
    assert.deepEqual(groups[0].candidates, [{ id: 500293, weight: 526 }])
    assert.equal(
        selectBaseHatchSpecies(tables, 30201001, () => 0, constraint),
        500293,
    )
    assert.throws(
        () => constrainedEggPools(tables, 30201001, { element_type: 999, race: 0 }),
        /no configured candidates/,
    )
    assert.throws(
        () => constrainedEggPools(tables, 30201001, { element_type: -1, race: 0 }),
        /Invalid egg species constraint/,
    )
})

test('claiming full storage resumes retained pending output without granting it twice or rerolling it', () => {
    const f = fixture()
    try {
        f.call('PetStationed', { build_guid: 104, build_type: 1, pet_guid: f.worker })
        seed(f, [[138000501, 10]], 104)
        f.edit((state) => {
            const job = state.home.collectionProduction[104],
                clock = job.clocks.find((c) => c.product === 138000501)
            job.blocked = true
            for (const c of job.clocks) c.remaining = 1
            clock.next = f.now()
            clock.remaining = 0
            clock.pending = 1
        })
        claim(f, [104])
        assert.equal(f.state().petEggs.length, 10)
        assert.equal(f.state().home.collectionProduction[104].blocked, false)
        f.game.rng = () => {
            throw Error('Retained pending drop must not reroll')
        }
        f.advance(0)
        assert.equal(build(f.state(), 104).collect_build_data.items[0].item_num, 1)
        assert.equal(f.state().petEggs.length, 10)
        f.game.rng = () => 0
        claim(f, [104])
        assert.equal(f.state().petEggs.length, 11)
    } finally {
        f.close()
    }
})

test('legacy type55 saved stock uses the outer building identity and never pretends a new world production job exists', () => {
    const f = fixture()
    try {
        f.edit((state) => {
            state.home.worldCollections = {
                1: {
                    guid: 999,
                    collect_id: 1,
                    build_id: 1110101,
                    items: [{ item_type: 3, item_id: 300000, item_num: 4, source_product_id: 131000101 }],
                },
            }
        })
        assert.throws(
            () => claim(f, [1]),
            (e) => e.code === ErrorCode.CollectBuildNotExist,
        )
        const before = stock(f.state(), 300000),
            out = claim(f, [999])
        assert.equal(stock(f.state(), 300000), before + 4)
        assert.deepEqual(f.state().home.worldCollections[1].items, [])
        assert(!f.state().home.collectionProduction?.[999])
        const homes = assertSyncBefore(protocol, out, 'CSProtoHomeSync', 6529)
        const point = homes.at(-1).data.home_builds.find((b) => b.guid === 999)
        assert.equal(point.collect_build_data.guid, 1)
        assert.deepEqual(point.collect_build_data.items, [])
    } finally {
        f.close()
    }
})

test('missing optional source metadata warns and omits src while the valid reward still reaches inventory', () => {
    const f = fixture(),
        warn = console.warn,
        previousLog = process.env.LURUKAPS_REWARD_SOURCE_LOG
    const warnings = []
    try {
        seed(f, [[131000101, 1]])
        const adapter = Object.create(tables)
        adapter.find = (name, id) => (name === 'reason_itemnum_change' ? undefined : tables.find(name, id))
        f.game.tables = adapter
        process.env.LURUKAPS_REWARD_SOURCE_LOG = ''
        console.warn = (line) => warnings.push(line)
        const before = stock(f.state(), 300000),
            out = claim(f)
        assert.equal(stock(f.state(), 300000), before + 1)
        assert(!Object.hasOwn(out.find((p) => p.id === 6529).data, 'src'))
        assert(warnings.some((line) => line.includes('collectionHarvest') && line.includes('source_row_missing')))
    } finally {
        console.warn = warn
        if (previousLog === undefined) delete process.env.LURUKAPS_REWARD_SOURCE_LOG
        else process.env.LURUKAPS_REWARD_SOURCE_LOG = previousLog
        f.close()
    }
})

test('real database restart preserves consumed stock, delivered items and private egg constraints; release cleans the latter', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-collection-claim-'))
    const file = path.join(directory, 'state.sqlite'),
        f = fixture(file)
    let restored,
        closed = false
    try {
        seed(f, [[131000101, 2]])
        seed(f, [[138040301, 1]], 104)
        claim(f, [100, 104])
        const before = f.state(),
            egg = before.petEggs.find((e) => e.configid === 30201001)
        assert(egg)
        f.close()
        closed = true
        restored = new Store(file)
        const game = new Game(protocol, restored, tables, { clock: f.now }),
            session = {}
        let seq = 1
        const call = (name, data) => {
            const entry = protocol.byName.get('CSProto' + name)
            return game.dispatch(session, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, data) })
        }
        call('EnterGame', { open_id: 'home-collection' })
        let state = restored.load(session.id).state
        assert.equal(session.id, f.session.id)
        assert.equal(stock(state, 300000), stock(before, 300000))
        assert.deepEqual(state.eggHatchConstraints[egg.guid], before.eggHatchConstraints[egg.guid])
        assert.deepEqual(build(state).collect_build_data.items, [])
        assert.throws(
            () => call('CollectGetReward', { guid: [100, 104] }),
            (e) => e.code === ErrorCode.CollectRewardNull,
        )
        call('DelEgg', { egg_list: [egg.guid] })
        state = restored.load(session.id).state
        assert(!state.petEggs.some((e) => e.guid === egg.guid))
        assert(!state.eggHatchConstraints[egg.guid])
    } finally {
        if (!closed) f.close()
        restored?.close()
        assert.equal(path.dirname(directory), os.tmpdir())
        assert(path.basename(directory).startsWith('lurukaps-collection-claim-'))
        fs.rmSync(directory, { recursive: true })
    }
})
