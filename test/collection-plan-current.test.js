import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fixture, legacy, oldPeriods, unchanged } from './helpers/collection-current-fixture.js'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { compileCollectionPlans } from '../src/home-collection-plan.js'
import { collectionPlan } from '../src/home-collection.js'
import {
    prepareCollectionClocks,
    currentHomeTalentRows,
    compileCollectionMigrationAliases,
} from '../src/home-production-clock.js'
import { ErrorCode } from '../src/error-codes.js'
import { grantRewards } from '../src/rewards.js'
import policy from '../configs/home-production-clock-migration-policy.json' with { type: 'json' }

const origin = 1800000000
const amount = (f, id) =>
    f
        .state()
        .player.sbag_infos.items.filter((row) => row.itemid === id)
        .reduce((n, row) => n + row.itemnum, 0)
const job = (f) => f.state().home.collectionProduction[f.build.guid]
const build = (f) => f.state().home.builds.find((row) => row.guid === f.build.guid)
const login = (f) => f.call('EnterGame', { open_id: f.name }, {})

test('current catalogue resolves all8 stations and32 base products without removed columns', () => {
    const tables = new Tables(configuration().tables),
        catalog = compileCollectionPlans(tables),
        products = new Set()
    assert.equal(catalog.size, 8)
    for (const entry of catalog.values()) {
        assert.equal(entry.allowed.length, 1)
        assert.equal(entry.station.isNeedPet, 1)
        assert.equal(entry.station.products, undefined)
        for (const { product, drop } of entry.allowed[0].leaves) {
            assert.equal(product.needLabor, undefined)
            assert.equal(product.isNeedMaster, undefined)
            assert.equal(product.homeDropId, drop.id)
            products.add(product.id)
        }
    }
    assert.equal(products.size, 32)
})

test('11931 owned same-plan selection and actual6532→tick→6529 produce current quantities once', () => {
    const f = fixture('collection-current-production')
    try {
        const request = { build_guid: f.build.guid, product_choose_id: 13001101 }
        const packets = f.call('HomeCollectBuildSwitchProduct', request)
        assert(packets.some((packet) => packet.id === 11931))
        // The normal sync optimizer may suppress an identical6102 already received at login.
        const raw = f.game.dispatchRaw(f.session, f.request('HomeCollectBuildSwitchProduct', request))
        assert(raw.some((packet) => packet.id === 6102))
        const selected = structuredClone(build(f).collect_build_data)
        f.call('HomeCollectBuildSwitchProduct', request)
        assert.deepEqual(build(f).collect_build_data, selected)
        unchanged(
            f,
            () => f.call('HomeCollectBuildSwitchProduct', { ...request, build_guid: 0x7fffffff }),
            (error) => error.code === ErrorCode.CollectBuildNotExist,
        )
        unchanged(
            f,
            () => f.call('HomeCollectBuildSwitchProduct', { ...request, product_choose_id: 13002101 }),
            (error) => error.code === ErrorCode.CollectProductnotMatch,
        )
        f.assign()
        const first = Math.ceil(Math.min(...job(f).clocks.map((clock) => clock.next)))
        f.setTime(first)
        const before = amount(f, 300000)
        assert(f.game.tick(f.session.id, f.session))
        const stock = build(f)
            .collect_build_data.items.filter((row) => row.item_id === 300000)
            .reduce((n, row) => n + row.item_num, 0)
        assert(stock >= 7, 'Current wood output is7 per eligible stream, not historical1')
        const ack = f.request('CollectGetReward', { guid: [f.build.guid] })
        f.game.dispatch(f.session, ack)
        assert.equal(amount(f, 300000), before + stock)
        const snapshot = f.hash()
        assert.throws(
            () => f.game.dispatch(f.session, ack),
            (error) => error.code === ErrorCode.CollectRewardNull,
        )
        assert.equal(f.hash(), snapshot)
        assert.equal(build(f).collect_build_data.items.length, 0)
    } finally {
        f.close()
    }
})

test('legitimate old future progress and missing Native row0 talent survive cold reopen unchanged', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'collection-clock-current-')),
        f = fixture('collection-current-future', { filename: path.join(directory, 'test.sqlite') })
    try {
        legacy(f)
        f.store.transact(f.session.id, 0, (state) => {
            const pet = state.pets.find((row) => row.guid === f.worker.guid)
            //500133 was a legitimate old orchard worker with these three initial home talents.
            pet.config_id = 500133
            pet.talent_id = [20010110, 20020110, 20030110]
            pet.labor_infos.push({ labor_id: 7, labor_grade: 20, upper_labor_grade: 40, labor_exp: 0 })
        })
        f.setTime(origin + 10)
        const raw = structuredClone(job(f).clocks)
        login(f)
        const current = job(f),
            plan = collectionPlan(f.tables, f.state(), build(f))
        for (const clock of raw) {
            const migrated = current.clocks.find((row) => row.product === clock.product),
                stream = plan.streams.find((row) => row.product === clock.product)
            assert(
                Math.abs((migrated.next - origin - 10) / stream.seconds - (clock.next - origin - 10) / clock.seconds) <
                    1e-7,
            )
        }
        assert.deepEqual(
            current.clockMigration.archive.map((row) => row.original),
            raw,
        )
        assert.deepEqual(
            f.state().pets.find((row) => row.guid === f.worker.guid).talent_id,
            [20010110, 20020110, 20030110],
        )
        const receipt = structuredClone(current.clockMigration),
            clocks = structuredClone(current.clocks)
        f.reopen()
        assert.deepEqual(job(f).clockMigration, receipt)
        assert.deepEqual(job(f).clocks, clocks)
    } finally {
        f.close()
        fs.rmSync(directory, { recursive: true, force: true })
    }
})

test('sealed old1-unit pending plus40000 stock retain original quantities through codec/SQL retry and claim', () => {
    const f = fixture('collection-current-sealed')
    try {
        legacy(f, true)
        const before = amount(f, 300000)
        login(f)
        assert.equal(job(f).clocks[0].pending.item_num, 1)
        assert.equal(build(f).collect_build_data.items[0].item_num, 40000)
        const type = f.protocol.byName.get('CSProtoCollectGetReward').rsp,
            encode = f.protocol.encode
        f.protocol.encode = function (name, ...args) {
            if (name === type) throw Error('collection claim codec failure')
            return encode.call(this, name, ...args)
        }
        try {
            unchanged(
                f,
                () => f.call('CollectGetReward', { guid: [f.build.guid] }),
                (error) => /claim codec failure/.test(error.message),
            )
        } finally {
            f.protocol.encode = encode
        }
        f.store.db.exec(
            "CREATE TRIGGER collection_claim_abort BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'collection-claim-sql'); END",
        )
        try {
            unchanged(
                f,
                () => f.call('CollectGetReward', { guid: [f.build.guid] }),
                (error) => /collection-claim-sql/.test(error.message),
            )
        } finally {
            f.store.db.exec('DROP TRIGGER collection_claim_abort')
        }
        f.call('CollectGetReward', { guid: [f.build.guid] })
        assert.equal(amount(f, 300000), before + 40000)
        f.setTime(origin + 33)
        f.game.tick(f.session.id, f.session)
        assert.equal(
            build(f)
                .collect_build_data.items.filter((row) => row.item_id === 300000)
                .reduce((n, row) => n + row.item_num, 0),
            1,
        )
        f.call('CollectGetReward', { guid: [f.build.guid] })
        assert.equal(amount(f, 300000), before + 40001)
        login(f)
        assert.equal(amount(f, 300000), before + 40001)
    } finally {
        f.close()
    }
})

test('approved cutover archives overdue without RNG/backlog and detached or unidentified outputs keep raw originals', () => {
    const tables = new Tables(configuration().tables),
        now = origin + 100,
        product = tables.find('products_collection', oldPeriods[0][0]),
        drop = tables.find('home_drop', product.homeDropId),
        streams = [{ product: product.id, drop, itemIds: [Number(drop.itemId)], seconds: drop.dropTime }],
        futureProduct = Number(
            Object.keys(policy.legacyCollectionAssets).find(
                (key) =>
                    key !== String(product.id) &&
                    policy.legacyCollectionAssets[key].type === 3 &&
                    policy.legacyCollectionAssets[key].ids.length === 1 &&
                    tables.find('common_item', policy.legacyCollectionAssets[key].ids[0]),
            ),
        ),
        futureItem = policy.legacyCollectionAssets[futureProduct].ids[0]
    const clocks = [
            { product: product.id, seconds: 36, next: origin + 36 },
            { product: futureProduct, seconds: 20, next: now + 10, pending: 2 },
            { product: 0x7fffffff, seconds: 50, next: now + 10, pending: 9 },
        ],
        saved = { pet: '1', started: origin, blocked: false, clocks: structuredClone(clocks) }
    prepareCollectionClocks(tables, saved, streams, now)
    assert.equal(saved.clocks.length, 1)
    assert.equal(saved.clocks[0].next, now + drop.dropTime)
    assert.equal(saved.clocks[0].pending, undefined)
    assert.deepEqual(
        saved.clockMigration.archive.map((row) => row.original),
        clocks,
    )
    assert.equal(saved.clockMigration.archive[0].reason, 'overdue-no-backpay')
    assert.deepEqual(saved.clockMigration.sealedPending[0].item, { item_type: 3, item_id: futureItem, item_num: 2 })
    assert.deepEqual(saved.clockMigration.unidentified[0].original, clocks[2])
    const snapshot = structuredClone(saved)
    prepareCollectionClocks(tables, saved, streams, now)
    assert.deepEqual(saved, snapshot)
    const emptyOldJob = { pet: '1', started: origin - 100000, blocked: false, clocks: [] }
    prepareCollectionClocks(tables, emptyOldJob, streams, now)
    assert.equal(
        emptyOldJob.clocks[0].next,
        now + drop.dropTime,
        'Previously lost empty work never backfills from started',
    )
})

test('only the six proven retired talents skip effects; raw ownership remains and malformed/unknown data rejects', () => {
    const tables = new Tables(configuration().tables),
        pet = { talent_id: [...policy.knownRetiredHomeTalents] }
    const original = structuredClone(pet)
    assert.deepEqual(currentHomeTalentRows(tables, pet), [])
    assert.deepEqual(pet, original)
    for (const value of [null, {}, [20020110, 20020110], [0], [99999999]])
        assert.throws(
            () => currentHomeTalentRows(tables, { talent_id: value }),
            (error) => error.code === ErrorCode.GameConfig,
        )
})

test('legacy egg stock and unknown numeric pending stay archived while real3/10 stock and proven detached output are claimed once', () => {
    const f = fixture('collection-current-unidentified')
    try {
        legacy(f, true)
        let detachedItem
        f.store.transact(f.session.id, 0, (state) => {
            const saved = state.home.collectionProduction[f.build.guid],
                data = state.home.builds.find((row) => row.guid === f.build.guid).collect_build_data
            // Policy boundary vector: old extra is no longer selected. Its source fixes the typed asset,
            // but no old probability/quantity recipe is executed to fabricate this already sealed2.
            const id = Number(
                Object.keys(policy.legacyCollectionAssets).find(
                    (key) =>
                        !saved.clocks.some((clock) => clock.product === Number(key)) &&
                        policy.legacyCollectionAssets[key].type === 3 &&
                        policy.legacyCollectionAssets[key].ids.length === 1 &&
                        f.tables.find('common_item', policy.legacyCollectionAssets[key].ids[0]),
                ),
            )
            detachedItem = policy.legacyCollectionAssets[id].ids[0]
            saved.clocks.push({ product: id, seconds: 360, next: origin + 360, remaining: 0, pending: 2 })
            saved.clocks.push({ product: 0x7fffffff, seconds: 360, next: origin + 360, remaining: 0, pending: 9 })
            // Real historical138040301 was30201001, current row became20201001.
            data.items.push({ source_product_id: 138040301, item_type: 14, item_id: 30201001, item_num: 1 })
        })
        const original = structuredClone(job(f)),
            oldEggCount = (f.state().petEggs ?? []).length,
            before = amount(f, detachedItem),
            beforeWood = amount(f, 300000)
        login(f)
        assert.equal(job(f).clockMigration.unidentified.length, 2)
        assert(job(f).clockMigration.unidentified.some((row) => row.original.pending === 9))
        assert(job(f).clockMigration.unidentified.some((row) => row.original.item_id === 30201001))
        assert.equal(job(f).clockMigration.sealedPending[0].item.item_num, 2)
        assert.equal((f.state().petEggs ?? []).length, oldEggCount)
        const claim = f.request('CollectGetReward', { guid: [f.build.guid] }),
            ack = f.game.dispatch(f.session, claim)
        assert.equal(amount(f, detachedItem), before + 2 + (detachedItem === 300000 ? 40000 : 0))
        assert.equal(amount(f, 300000), beforeWood + 40000 + (detachedItem === 300000 ? 2 : 0))
        assert.equal(job(f).clockMigration.sealedPending[0].claimed, true)
        assert(ack.some((row) => row.id === 6529))
        const receipt = structuredClone(job(f).clockMigration)
        // A new dispatch may settle the independently sealed1 after the warehouse was emptied.
        f.setTime(origin + 33)
        f.game.tick(f.session.id, f.session)
        f.call('CollectGetReward', { guid: [f.build.guid] })
        unchanged(
            f,
            () => f.game.dispatch(f.session, claim),
            (error) => error.code === ErrorCode.CollectRewardNull,
        )
        login(f)
        assert.deepEqual(job(f).clockMigration, receipt)
        assert.deepEqual(
            job(f).clockMigration.archive.find((row) => row.original.product === 0x7fffffff).original,
            original.clocks.find((row) => row.product === 0x7fffffff),
        )
        assert.equal((f.state().petEggs ?? []).length, oldEggCount)
    } finally {
        f.close()
    }
})

test('all5 stable historical egg sources retain sealed quantities while17 changed/missing sources stay raw', () => {
    const tables = new Tables(configuration().tables),
        raw = [],
        stable = []
    for (const [key, proof] of Object.entries(policy.legacyCollectionAssets)) {
        if (proof.type !== 14) continue
        const product = Number(key),
            saved = {
                pet: '1',
                blocked: true,
                started: origin,
                clocks: [{ product, seconds: 360, next: origin + 360, remaining: 0, pending: 1 }],
            }
        prepareCollectionClocks(tables, saved, [], origin + 1)
        if (saved.clockMigration.sealedPending.length) stable.push(product)
        else raw.push(product)
    }
    assert.deepEqual(stable, [138010201, 138010301, 138020401, 138050401, 138060401])
    assert.equal(raw.length, 17)
})

test('real mixed row+detached egg claim checks combined capacity before any grant and rolls back codec/SQL atomically', () => {
    const f = fixture('collection-current-eggs')
    try {
        legacy(f, true)
        const limit = Number(f.tables.get('game').find((row) => row.title === 'PET_EGG_LIMITS').value)
        f.store.transact(f.session.id, 0, (state) => {
            const saved = state.home.collectionProduction[f.build.guid],
                data = state.home.builds.find((row) => row.guid === f.build.guid).collect_build_data
            saved.clocks.push({ product: 138010201, seconds: 43200, next: origin + 43200, remaining: 0, pending: 1 })
            data.items.push({ source_product_id: 138010301, item_type: 14, item_id: 40003001, item_num: 1 })
            grantRewards(f.tables, state, [{ itemtype: 14, itemid: 30101001, itemnum: limit - 1 }], 0, {
                randomInt: (n) => 0,
            })
        })
        login(f)
        assert.equal(job(f).clockMigration.sealedPending.filter((row) => row.item.item_type === 14).length, 1)
        unchanged(
            f,
            () => f.call('CollectGetReward', { guid: [f.build.guid] }),
            (error) => error.code === ErrorCode.EggBagNumIsMax,
        )
        f.call('DelEgg', { egg_list: [f.state().petEggs[0].guid] })
        assert.equal(f.state().petEggs.length, limit - 2)
        const type = f.protocol.byName.get('CSProtoCollectGetReward').rsp,
            encode = f.protocol.encode
        f.protocol.encode = function (name, ...args) {
            if (name === type) throw Error('mixed egg codec failure')
            return encode.call(this, name, ...args)
        }
        try {
            unchanged(
                f,
                () => f.call('CollectGetReward', { guid: [f.build.guid] }),
                (error) => /mixed egg codec/.test(error.message),
            )
        } finally {
            f.protocol.encode = encode
        }
        f.store.db.exec(
            "CREATE TRIGGER collection_egg_abort BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'collection-egg-sql'); END",
        )
        try {
            unchanged(
                f,
                () => f.call('CollectGetReward', { guid: [f.build.guid] }),
                (error) => /collection-egg-sql/.test(error.message),
            )
        } finally {
            f.store.db.exec('DROP TRIGGER collection_egg_abort')
        }
        f.call('CollectGetReward', { guid: [f.build.guid] })
        assert.equal(f.state().petEggs.length, limit)
        assert(job(f).clockMigration.sealedPending.every((row) => row.claimed))
        const guids = f.state().petEggs.map((row) => row.guid)
        login(f)
        assert.deepEqual(
            f.state().petEggs.map((row) => row.guid),
            guids,
        )
    } finally {
        f.close()
    }
})

test('only proven same-station alias preserves future fraction; displaced different asset cannot capture its stream', () => {
    const tables = new Tables(configuration().tables),
        alias = policy.legacyCollectionAliases[0],
        product = tables.find('products_collection', alias.targetProduct),
        drop = tables.find('home_drop', product.homeDropId),
        stream = {
            product: product.id,
            drop,
            itemIds: String(drop.itemId).split('|').map(Number),
            seconds: drop.dropTime,
        },
        now = origin + 100,
        original = [
            { product: alias.targetProduct, seconds: 1000, next: now + 250 }, // Old target was a different type/asset.
            { product: alias.sourceProduct, seconds: 1000, next: now + 500 },
        ],
        saved = { pet: '1', blocked: false, started: origin, clocks: structuredClone(original) }
    assert.deepEqual(alias.identity, policy.legacyCollectionAssets[alias.sourceProduct])
    assert.notEqual(policy.legacyCollectionAssets[alias.targetProduct].type, stream.drop.itemType)
    prepareCollectionClocks(tables, saved, [stream], now, [], alias.stationId)
    assert.equal(saved.clocks.length, 1)
    assert.equal(saved.clocks[0].product, alias.targetProduct)
    assert.equal(saved.clocks[0].next, now + stream.seconds / 2)
    assert.deepEqual(
        saved.clockMigration.archive.map((row) => row.original),
        original,
    )
    assert.equal(saved.clockMigration.archive[0].reason, 'unmatched-restart-current')
    const receipt = structuredClone(saved)
    prepareCollectionClocks(tables, saved, [stream], now, [], alias.stationId)
    assert.deepEqual(saved, receipt)
    const outside = { pet: '1', blocked: false, started: origin, clocks: [structuredClone(original[1])] }
    prepareCollectionClocks(tables, outside, [stream], now, [], alias.stationId + 1)
    assert.equal(outside.clocks[0].next, now + stream.seconds)
    assert.throws(
        () =>
            compileCollectionMigrationAliases([
                alias,
                { ...alias, sourceProduct: 138040201, identity: policy.legacyCollectionAssets[138040201] },
            ]),
        (error) => error.code === ErrorCode.GameConfig,
    )
    const sealed = { pet: '1', blocked: true, started: origin, clocks: [{ ...original[1], remaining: 0, pending: 2 }] },
        stock = [{ source_product_id: alias.sourceProduct, item_type: 14, item_id: stream.itemIds[0], item_num: 3 }]
    prepareCollectionClocks(tables, sealed, [stream], now, stock, alias.stationId)
    assert.equal(stock.length, 0)
    assert.deepEqual(
        sealed.clockMigration.sealedPending.map((row) => row.item.item_num),
        [3, 2],
    )
    assert(sealed.clockMigration.sealedPending.every((row) => row.currentProduct === alias.targetProduct))
    assert.equal(sealed.clocks[0].pending, undefined)
    assert.equal(sealed.clocks[0].next, now + stream.seconds)
})
