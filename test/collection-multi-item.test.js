import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
    multiCollectionFixture,
    tables,
    protocol,
    build,
    extra,
    stock,
    product,
} from './collection-multi-item-fixture.js'
import { collectionPlan, collectionStorage, settleCollections, retimeCollections } from '../src/home-collection.js'
import { collectionDropIds, collectionPending } from '../src/collection-drop.js'
import { ErrorCode } from '../src/error-codes.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'

test('actual10087 purchase and orchard dispatch produce one random candidate per360-second stream, total ten/hour, and6529 grants both members', () => {
    const f = multiCollectionFixture()
    try {
        assert.equal(f.state().home.technology.levels[10087].level, 1)
        const stream = collectionPlan(tables, f.state(), build(f.state())).streams.find((s) => s.product === product)
        assert.deepEqual(stream.itemIds, [306000, 306004])
        assert.equal(stream.seconds, 360 * 0.99)
        let choices = 0
        f.game.rng = (min, max) => (min === 0 && max === 2 ? choices++ % 2 : min)
        f.advance(3600)
        assert.equal(choices, 10)
        assert.deepEqual(
            extra(f.state())
                .map((item) => [item.item_id, item.item_num])
                .sort((a, b) => a[0] - b[0]),
            [
                [306000, 5],
                [306004, 5],
            ],
        )
        const before = f.state(),
            reply = f.call('CollectGetReward', { guid: [100] }).find((p) => p.id === 6529).data
        for (const id of [306000, 306004]) {
            const count = build(before)
                .collect_build_data.items.filter((item) => item.item_type === 3 && item.item_id === id)
                .reduce((n, item) => n + item.item_num, 0)
            assert.equal(reply.rewards.find((r) => r.itemtype === 3 && r.itemid === id).itemnum, count)
            assert.equal(stock(f.state(), id) - stock(before, id), count)
        }
        assert.deepEqual(build(f.state()).collect_build_data.items, [])
        f.call('EnterGame', { open_id: 'home-collection' }, {})
        assert.deepEqual(build(f.state()).collect_build_data.items, [])
    } finally {
        f.close()
    }
})

test('full warehouse seals the chosen second item through login and resumes that exact pending identity after6529', () => {
    const f = multiCollectionFixture()
    try {
        f.edit((state) => {
            const plan = collectionPlan(tables, state, build(state)),
                job = state.home.collectionProduction[100],
                stream = plan.streams.find((s) => s.product === product)
            job.clocks = [{ product, next: f.now(), seconds: stream.seconds }]
            build(state).collect_build_data.items = [
                { item_id: 300000, item_type: 3, item_num: plan.stack * plan.slots, source_product_id: 131000101 },
            ]
        })
        let choices = 0
        f.game.rng = (min, max) => {
            assert.equal(max, 2)
            choices++
            return 1
        }
        f.advance(0)
        const saved = f.state().home.collectionProduction[100].clocks.find((c) => c.product === product).pending
        assert.deepEqual(saved, { item_id: 306004, item_type: 3, item_num: 1 })
        assert.equal(choices, 1)
        f.game.rng = () => {
            throw Error('sealed pending rerolled')
        }
        f.call('EnterGame', { open_id: 'home-collection' }, {})
        assert.deepEqual(
            f.state().home.collectionProduction[100].clocks.find((c) => c.product === product).pending,
            saved,
        )
        f.call('CollectGetReward', { guid: [100] })
        f.advance(0)
        assert.deepEqual(extra(f.state()), [{ item_id: 306004, item_type: 3, item_num: 1, source_product_id: product }])
        assert.equal(
            f.state().home.collectionProduction[100].clocks.find((c) => c.product === product).pending,
            undefined,
        )
    } finally {
        f.close()
    }
})

test('candidate-specific tails cannot borrow another item cell and partial pending retains identity and remaining amount', () => {
    const f = multiCollectionFixture()
    try {
        const state = f.state(),
            b = build(state),
            plan = collectionPlan(tables, state, b),
            stream = plan.streams.find((s) => s.product === product),
            job = state.home.collectionProduction[100]
        b.collect_build_data.items = [
            { item_id: 306000, item_type: 3, item_num: plan.stack * plan.slots - 1, source_product_id: product },
        ]
        job.clocks = [
            {
                product,
                next: f.now(),
                seconds: stream.seconds,
                pending: { item_id: 306004, item_type: 3, item_num: 3 },
            },
        ]
        settleCollections(tables, state, f.now(), () => {
            throw Error('pending reroll')
        })
        assert.equal(job.blocked, true)
        assert.equal(job.clocks[0].pending.item_num, 3)
        assert.equal(extra(state).length, 1)
        // Synthetic saved backlog isolates the generic partial-insert contract;
        // actual139000002 currently rolls one item, not3.
        b.collect_build_data.items = [
            { item_id: 306004, item_type: 3, item_num: plan.stack * plan.slots - 1, source_product_id: product },
        ]
        retimeCollections(tables, state, f.now())
        settleCollections(tables, state, f.now(), () => {
            throw Error('partial pending reroll')
        })
        assert.equal(collectionStorage(plan, b.collect_build_data.items), plan.slots)
        assert.deepEqual(job.clocks.find((c) => c.product === product).pending, {
            item_id: 306004,
            item_type: 3,
            item_num: 2,
        })
        b.collect_build_data.items = []
        retimeCollections(tables, state, f.now())
        settleCollections(tables, state, f.now(), () => {
            throw Error('remaining pending reroll')
        })
        assert.equal(extra(state)[0].item_num, 2)
        const single = plan.streams.find((s) => s.itemIds.length === 1)
        assert.equal(collectionPending(single, 2).item_num, 2, 'legacy numeric pending keeps the sole candidate')
    } finally {
        f.close()
    }
})

test('malformed lists, missing definitions and counterfeit pending/stock members reject rather than reroll or grant', () => {
    const f = multiCollectionFixture()
    try {
        const drop = tables.find('home_drop', product),
            stream = collectionPlan(tables, f.state(), build(f.state())).streams.find((s) => s.product === product)
        for (const itemId of ['', '306000|', '306000||306004', '306000|306000', '306000|999999999', '0', '1.2'])
            assert.throws(
                () => collectionDropIds(tables, { ...drop, itemId }),
                (error) => error.code === ErrorCode.GameConfig,
            )
        for (const pending of [
            1,
            { item_id: 300000, item_type: 3, item_num: 1 },
            { item_id: 306004, item_type: 10, item_num: 1 },
            { item_id: 306004, item_type: 3, item_num: -1 },
        ])
            assert.throws(
                () => collectionPending(stream, pending),
                (error) => error.code === ErrorCode.GameConfig,
            )
        f.edit((state) => {
            build(state).collect_build_data.items = [
                { item_id: 300000, item_type: 3, item_num: 1, source_product_id: product },
            ]
        })
        const before = f.state()
        assert.throws(
            () => f.call('CollectGetReward', { guid: [100] }),
            (error) => error.code === ErrorCode.CollectProductnotMatch,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.close()
    }
})

test('new candidate production and6529 reply encoding failures atomically restore clocks, pending and inventory', () => {
    const f = multiCollectionFixture()
    try {
        f.advance(360, false)
        const before = f.state(),
            packet = f.game.packet
        f.game.rng = (min, max) => (min === 0 && max === 2 ? 1 : min)
        f.game.packet = function (name, ...args) {
            if (name === 'CSProtoHomeSync') throw Error('multi collection sync')
            return packet.call(this, name, ...args)
        }
        assert.throws(() => f.game.tick(f.session.id), /multi collection sync/)
        assert.deepEqual(f.state(), before)
        f.game.packet = packet
        f.advance(0)
        const produced = f.state(),
            encode = protocol.encode
        protocol.encode = function (name, ...args) {
            if (name.replace(/^cs\./, '') === 'Rewards') throw Error('multi collection ack')
            return encode.call(this, name, ...args)
        }
        try {
            assert.throws(() => f.call('CollectGetReward', { guid: [100] }), /multi collection ack/)
            assert.deepEqual(f.state(), produced)
        } finally {
            protocol.encode = encode
        }
        f.call('CollectGetReward', { guid: [100] })
    } finally {
        f.close()
    }
})

test('all current pending clocks are validated before an earlier due stream can deposit any stock', () => {
    const f = multiCollectionFixture()
    try {
        for (const pending of [-1, NaN, Infinity, { item_id: 300000, item_type: 3, item_num: 1 }]) {
            const state = f.state(),
                b = build(state),
                plan = collectionPlan(tables, state, b),
                ordinary = plan.streams.find((s) => s.product !== product),
                extraStream = plan.streams.find((s) => s.product === product)
            state.home.collectionProduction[100].clocks = [
                { product: ordinary.product, next: f.now(), seconds: ordinary.seconds },
                { product, next: f.now() + 360, seconds: extraStream.seconds, pending },
            ]
            const before = structuredClone(state)
            assert.throws(
                () => settleCollections(tables, state, f.now(), () => 0),
                (error) => error.code === ErrorCode.GameConfig,
            )
            assert.deepEqual(state, before)
        }
        const state = f.state(),
            b = build(state),
            plan = collectionPlan(tables, state, b),
            ordinary = plan.streams[0]
        state.home.collectionProduction[100].clocks = [
            { product: ordinary.product, next: f.now(), seconds: ordinary.seconds },
            { product: 999999999, next: f.now() + 360, seconds: 360, pending: 1 },
        ]
        assert.doesNotThrow(() => settleCollections(tables, state, f.now(), () => 0))
        retimeCollections(tables, state, f.now())
        assert(!state.home.collectionProduction[100].clocks.some((clock) => clock.product === 999999999))
    } finally {
        f.close()
    }
})

test('sealed selected item persists through SQLite close/reopen and login without invoking a new random choice', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collection-multi-')),
        file = path.join(dir, 'state.sqlite')
    let f
    try {
        f = multiCollectionFixture(file)
        f.edit((state) => {
            const plan = collectionPlan(tables, state, build(state)),
                job = state.home.collectionProduction[100],
                stream = plan.streams.find((s) => s.product === product)
            job.clocks = [
                {
                    product,
                    next: f.now(),
                    seconds: stream.seconds,
                    pending: { item_id: 306004, item_type: 3, item_num: 1 },
                },
            ]
            job.blocked = true
            build(state).collect_build_data.items = [
                { item_id: 300000, item_type: 3, item_num: plan.stack * plan.slots, source_product_id: 131000101 },
            ]
        })
        f.close()
        const store = new Store(file),
            session = {},
            game = new Game(protocol, store, tables, {
                clock: () => 1800000000,
                rng: () => {
                    throw Error('reopen selected candidate rerolled')
                },
            }),
            entry = protocol.byName.get('CSProtoEnterGame')
        f = { close: () => store.close() }
        game.dispatch(session, {
            id: entry.id,
            seq: 1,
            payload: protocol.encode(entry.req, { open_id: 'home-collection' }),
        })
        assert.deepEqual(
            store.load(session.id).state.home.collectionProduction[100].clocks.find((c) => c.product === product)
                .pending,
            { item_id: 306004, item_type: 3, item_num: 1 },
        )
    } finally {
        f?.close()
        const resolved = path.resolve(dir)
        assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()))
        assert(path.basename(resolved).startsWith('collection-multi-'))
        fs.rmSync(resolved, { recursive: true, force: true })
    }
})
