import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { grantRewards } from '../src/rewards.js'
import { gridAnchor } from '../src/home-grid.js'
import { hatchCardDefinition } from '../src/hatch-cards.js'
import { ErrorCode } from '../src/error-codes.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
function fixture(name, filename = ':memory:', prepare = true) {
    let now = 1800000000,
        seq = 1,
        session = {}
    const store = new Store(filename),
        game = new Game(protocol, store, tables, { clock: () => now, rng: () => 0 })
    const frame = (name, request = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        return { id: entry.id, seq: seq++, payload: entry.req ? protocol.encode(entry.req, request) : Buffer.alloc(0) }
    }
    const dispatch = (frame) =>
        game.dispatch(session, frame).map((packet) => ({
            id: packet.id,
            data: protocol.decode(protocol.byId.get(packet.id).rsp, packet.payload),
        }))
    const call = (name, request) => dispatch(frame(name, request)),
        state = () => store.load(session.id).state,
        edit = (fn) => store.transact(session.id, 0, fn)
    const login = call('EnterGame', { open_id: name })
    if (prepare) {
        edit((s) => {
            // Trusted home progression baseline, assets still come from actual reward factories.
            s.player.basic_info.lv = 15
            grantRewards(
                tables,
                s,
                [
                    { itemtype: 13, itemid: 30231, itemnum: 1 },
                    { itemtype: 14, itemid: 20004001, itemnum: 3 },
                    ...tables
                        .get('common_item')
                        .filter((row) => row.type === 410)
                        .map((row) => ({ itemtype: 3, itemid: row.id, itemnum: 5 })),
                ],
                0,
                { randomInt: () => 0 },
            )
        })
        call('BuildLocate', { build_id: 30231, locate: { block_id: 101, anchor: gridAnchor(-50, -25), direction: 0 } })
    }
    const build = () => state().home.builds.find((row) => row.build_id === 30231 && row.build_type === 12),
        jobs = () => state().home.productionJobs?.[build().guid] ?? []
    return {
        store,
        game,
        call,
        frame,
        dispatch,
        state,
        edit,
        login,
        build,
        jobs,
        raw: () => ({
            player: store.load(session.id),
            sql: store.db.prepare('SELECT state,revision,updated_at FROM players WHERE account_id=?').get(session.id),
            sequences: store.db.prepare('SELECT * FROM sequences ORDER BY name').all(),
        }),
        advance: (seconds) => {
            now += seconds
            return game.tick(session.id, session)
        },
        reconnect: () => {
            session = {}
            return call('EnterGame', { open_id: name, reconnect: true })
        },
        close: () => store.close(),
    }
}
const amount = (s, id) =>
    s.player.sbag_infos.items.filter((row) => row.itemid === id).reduce((n, row) => n + row.itemnum, 0)
const egg = (f, id) => f.state().petEggs.find((row) => row.guid === id)
const sync = (packets) => packets.find((packet) => packet.id === 6518).data
function unchanged(f, fn, predicate) {
    const before = f.raw()
    assert.throws(fn, predicate)
    assert.deepEqual(f.raw(), before)
}
function beforeAck(packets, id) {
    assert(
        packets.findIndex((p) => p.id === 6518) >= 0 &&
            packets.findIndex((p) => p.id === 6518) < packets.findIndex((p) => p.id === id),
    )
}

test('current6574/6576 select owned cards without spending, keep egg override separate and sync6518 before callbacks', () => {
    const f = fixture('hatch-card-settings')
    try {
        const cards = tables.get('common_item').filter((row) => row.type === 410)
        assert.equal(cards.length, 10)
        for (const row of cards) assert.equal(hatchCardDefinition(tables, row.id).config.type, row.subId)
        assert.equal(sync(f.login).default_catch_card_id ?? 0, 0)
        const before = amount(f.state(), 1000002)
        const selected = f.call('SetEggCatchCard', { egg_guid: 1, catch_card_id: 1000002 })
        beforeAck(selected, 6574)
        assert.equal(sync(selected).egg_infos.eggs.find((e) => e.guid === 1).catch_card_id, 1000002)
        assert.equal(sync(selected).default_catch_card_id ?? 0, 0)
        const defaults = f.call('SetDefaultCatchCard', { catch_card_id: 1000003 })
        beforeAck(defaults, 6576)
        assert.equal(sync(defaults).default_catch_card_id, 1000003)
        assert.equal(egg(f, 1).catch_card_id, 1000002)
        assert(!egg(f, 2).catch_card_id)
        assert.equal(amount(f.state(), 1000002), before)
        const repeated = f.state()
        f.call('SetEggCatchCard', { egg_guid: 1, catch_card_id: 1000002 })
        f.call('SetDefaultCatchCard', { catch_card_id: 1000003 })
        assert.deepEqual(f.state().hatchCardReceipts, repeated.hatchCardReceipts)
        assert.equal(amount(f.state(), 1000002), before)
        assert.equal(sync(f.reconnect()).default_catch_card_id, 1000003)
        assert.equal(egg(f, 1).catch_card_id, 1000002)
        unchanged(
            f,
            () => f.call('SetEggCatchCard', { egg_guid: 99999, catch_card_id: 1000002 }),
            (e) => e.code === ErrorCode.EggNotExist,
        )
        unchanged(
            f,
            () => f.call('SetDefaultCatchCard', { catch_card_id: 402001 }),
            (e) => e.code === ErrorCode.CatchParamErr,
        )
        unchanged(
            f,
            () => f.call('SetDefaultCatchCard', { catch_card_id: 0 }),
            (e) => e.code === ErrorCode.CatchParamErr,
        )
        f.edit((s) => {
            s.petEggs[2].lock_state = true
        })
        unchanged(
            f,
            () => f.call('SetEggCatchCard', { egg_guid: 3, catch_card_id: 1000002 }),
            (e) => e.code === ErrorCode.EggIsLock,
        )
    } finally {
        f.close()
    }
})

test('6506 binds each accepted queue entry, spends one card once, and current6111 rewards preserve catch_item and idempotency', () => {
    const f = fixture('hatch-card-queue')
    try {
        f.call('SetDefaultCatchCard', { catch_card_id: 1000003 })
        f.call('SetEggCatchCard', { egg_guid: 1, catch_card_id: 1000002 })
        const a = amount(f.state(), 1000002),
            b = amount(f.state(), 1000003),
            request = f.frame('HatchPetEgg', { build_guid: f.build().guid, egg_guid: 1 })
        f.dispatch(request)
        const first = structuredClone(f.jobs()[0]),
            firstState = f.state()
        assert.equal(amount(f.state(), 1000002), a - 1)
        assert.equal(first.hatch_card.item_id, 1000002)
        unchanged(
            f,
            () => f.dispatch(request),
            (e) => e.code === ErrorCode.EggInHatch,
        )
        assert.deepEqual(
            f.state(),
            firstState,
            'direct Game retries retain the existing already-assigned error without another charge; TCP replay is outside Game',
        )
        f.call('HatchPetEgg', { build_guid: f.build().guid, egg_guid: 2 })
        const second = structuredClone(f.jobs()[1])
        assert.equal(second.hatch_card.item_id, 1000003)
        assert.equal(amount(f.state(), 1000003), b - 1)
        assert.equal(egg(f, 2).hatch_state, 1)
        f.call('SetDefaultCatchCard', { catch_card_id: 1000004 })
        assert.equal(f.jobs()[0].hatch_card.item_id, 1000002)
        assert.equal(f.jobs()[1].hatch_card.item_id, 1000003)
        unchanged(
            f,
            () => f.call('SetEggCatchCard', { egg_guid: 2, catch_card_id: 1000004 }),
            (e) => e.code === ErrorCode.PetEggHatchStateIn,
        )
        f.call('SetEggCatchCard', { egg_guid: 2, catch_card_id: 1000003 })
        f.advance(first.seconds)
        const count = f.state().pets.length,
            packets = f.call('ProductFinish', { guid: f.build().guid, product_guids: [first.guid] }),
            rsp = packets.find((p) => p.id === 6111).data,
            pet = f.state().pets.find((p) => p.guid === rsp.reward.rewards[0].guid)
        assert.equal(pet.catch_item, 1000002)
        assert.equal(f.state().pets.length, count + 1)
        assert.equal(
            packets.find((p) => p.id === 6517).data.pet_infos.pets.find((p) => p.guid === pet.guid).catch_item,
            1000002,
        )
        assert(packets.findIndex((p) => p.id === 6517) < packets.findIndex((p) => p.id === 6111))
        assert.equal(f.state().hatchCardReceipts[first.hatch_card.receipt_key].status, 'claimed')
        assert.equal(f.state().hatchReceipts[f.build().guid + ':1'].hatch_card.item_id, 1000002)
        const paid = amount(f.state(), 1000002)
        assert.deepEqual(
            f.call('ProductFinish', { guid: f.build().guid, product_guids: [first.guid] }).find((p) => p.id === 6111)
                .data.reward.rewards,
            [],
        )
        assert.equal(amount(f.state(), 1000002), paid)
        assert.equal(f.state().pets.length, count + 1)
        assert.equal(sync(f.reconnect()).default_catch_card_id, 1000004)
        assert.equal(f.jobs()[0].hatch_card.item_id, 1000003)
    } finally {
        f.close()
    }
})

test('actual optimized6518 keeps the selected default through egg updates, queued ticks, claim and cold login', () => {
    const f = fixture('hatch-card-wire-default')
    const observe = (packets) => {
        const frames = packets.filter((frame) => frame.id === 6518)
        assert.equal(frames.length, 1)
        const value = frames[0].data ?? protocol.decode(protocol.byId.get(6518).rsp, frames[0].payload)
        assert.equal(value.default_catch_card_id ?? 0, 1000003, 'Native getter must not reset an unchanged default')
    }
    try {
        observe(f.call('SetDefaultCatchCard', { catch_card_id: 1000003 }))
        observe(f.call('SetEggCatchCard', { egg_guid: 1, catch_card_id: 1000002 }))
        const before = amount(f.state(), 1000002)
        observe(f.call('HatchPetEgg', { build_guid: f.build().guid, egg_guid: 1 }))
        const job = structuredClone(f.jobs()[0])
        assert.equal(amount(f.state(), 1000002), before - 1)
        observe(f.advance(job.seconds))
        observe(f.call('ProductFinish', { guid: f.build().guid, product_guids: [job.guid] }))
        assert.equal(f.state().hatchDefaultCatchCardId, 1000003)
        assert.equal(f.state().hatchCardReceipts[job.hatch_card.receipt_key].status, 'claimed')
        observe(f.reconnect())
    } finally {
        f.close()
    }
})

test('cancel keeps the paid receipt and seeded outcome; a distinct retry consumes one new card and cannot spend absent stock', () => {
    const f = fixture('hatch-card-cancel')
    try {
        f.call('SetDefaultCatchCard', { catch_card_id: 1000002 })
        const n = amount(f.state(), 1000002)
        f.call('HatchPetEgg', { build_guid: f.build().guid, egg_guid: 1 })
        const job = f.jobs()[0],
            result = f.state().eggOutcomes[1],
            seed = f.state().eggGenerationSeeds[1]
        f.call('ProductCancel', { guid: f.build().guid, product_guids: [job.guid] })
        assert.equal(amount(f.state(), 1000002), n - 1)
        assert.equal(f.state().hatchCardReceipts[job.hatch_card.receipt_key].status, 'cancelled')
        assert.equal(egg(f, 1).hatch_state, 0)
        assert.equal(f.jobs().length, 0)
        f.call('HatchPetEgg', { build_guid: f.build().guid, egg_guid: 1 })
        assert.equal(amount(f.state(), 1000002), n - 2)
        assert.equal(f.state().eggOutcomes[1], result)
        assert.equal(f.state().eggGenerationSeeds[1], seed)
        assert.notEqual(f.jobs()[0].guid, job.guid)
        f.edit((s) => {
            for (const item of s.player.sbag_infos.items) if (item.itemid === 1000002) item.itemnum = 0
        })
        unchanged(
            f,
            () => f.call('HatchPetEgg', { build_guid: f.build().guid, egg_guid: 2 }),
            (e) => e.code === ErrorCode.ItemNotEnough,
        )
        unchanged(
            f,
            () => f.call('SetDefaultCatchCard', { catch_card_id: 1000009 + 77 }),
            (e) => e.code === ErrorCode.GameConfig,
        )
    } finally {
        f.close()
    }
})

test('settings/start/finish codec failure and SQL failure roll back card, queue, seed, allocator and rewards as one tuple', () => {
    const f = fixture('hatch-card-rollback')
    try {
        const packet = f.game.packet
        f.game.packet = function (name, value) {
            if (name === 'CSProtoPetEggInfoSync') throw Error('hatch-card-codec')
            return packet.call(this, name, value)
        }
        unchanged(f, () => f.call('SetDefaultCatchCard', { catch_card_id: 1000002 }), /hatch-card-codec/)
        f.game.packet = packet
        f.call('SetDefaultCatchCard', { catch_card_id: 1000002 })
        f.game.packet = function (name, value) {
            if (name === 'CSProtoPetEggInfoSync') throw Error('hatch-card-codec')
            return packet.call(this, name, value)
        }
        unchanged(f, () => f.call('HatchPetEgg', { build_guid: f.build().guid, egg_guid: 1 }), /hatch-card-codec/)
        f.game.packet = packet
        f.store.db.exec(
            "CREATE TRIGGER hatch_card_fail BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'hatch-card-sql'); END",
        )
        unchanged(f, () => f.call('SetEggCatchCard', { egg_guid: 1, catch_card_id: 1000003 }), /hatch-card-sql/)
        unchanged(f, () => f.call('HatchPetEgg', { build_guid: f.build().guid, egg_guid: 1 }), /hatch-card-sql/)
        f.store.db.exec('DROP TRIGGER hatch_card_fail')
        f.call('HatchPetEgg', { build_guid: f.build().guid, egg_guid: 1 })
        const job = structuredClone(f.jobs()[0])
        f.advance(job.seconds)
        f.game.packet = function (name, value) {
            if (name === 'CSProtoPetInfoSync') throw Error('hatch-card-codec')
            return packet.call(this, name, value)
        }
        unchanged(
            f,
            () => f.call('ProductFinish', { guid: f.build().guid, product_guids: [job.guid] }),
            /hatch-card-codec/,
        )
        f.game.packet = packet
        f.store.db.exec(
            "CREATE TRIGGER hatch_card_finish_fail BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'hatch-card-finish-sql'); END",
        )
        unchanged(
            f,
            () => f.call('ProductFinish', { guid: f.build().guid, product_guids: [job.guid] }),
            /hatch-card-finish-sql/,
        )
        f.store.db.exec('DROP TRIGGER hatch_card_finish_fail')
        f.call('ProductFinish', { guid: f.build().guid, product_guids: [job.guid] })
        assert.equal(f.state().hatchCardReceipts[job.hatch_card.receipt_key].status, 'claimed')
    } finally {
        f.close()
    }
})

test('a private cold database reopen preserves default, per-egg choice and paid queue without charging again', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luruka-hatch-card-')),
        filename = path.join(dir, 'validation-only.sqlite')
    let f
    try {
        f = fixture('hatch-card-cold', filename)
        f.call('SetDefaultCatchCard', { catch_card_id: 1000003 })
        f.call('SetEggCatchCard', { egg_guid: 1, catch_card_id: 1000002 })
        f.call('HatchPetEgg', { build_guid: f.build().guid, egg_guid: 1 })
        const job = structuredClone(f.jobs()[0]),
            receipts = structuredClone(f.state().hatchCardReceipts),
            count = amount(f.state(), 1000002)
        f.close()
        f = undefined
        f = fixture('hatch-card-cold', filename, false)
        assert.equal(sync(f.login).default_catch_card_id, 1000003)
        assert.equal(egg(f, 1).catch_card_id, 1000002)
        assert.deepEqual(f.state().hatchCardReceipts, receipts)
        assert.deepEqual(f.jobs()[0].hatch_card, job.hatch_card)
        assert.equal(amount(f.state(), 1000002), count)
        f.advance(job.seconds)
        f.call('ProductFinish', { guid: f.build().guid, product_guids: [job.guid] })
        assert.equal(f.state().pets.at(-1).catch_item, 1000002)
    } finally {
        f?.close()
        assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep + 'luruka-hatch-card-'))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('all nine ordinary current cards complete real queues without silently changing base appearance', () => {
    const f = fixture('hatch-cards-all-ordinary')
    try {
        f.edit((s) =>
            grantRewards(tables, s, [{ itemtype: 14, itemid: 20004001, itemnum: 6 }], 0, { randomInt: () => 0 }),
        )
        const cards = tables
            .get('common_item')
            .filter((row) => row.type === 410 && hatchCardDefinition(tables, row.id).config.StarColorProb === 0)
        assert.equal(cards.length, 9)
        let appearance
        for (const [index, card] of cards.entries()) {
            const id = index + 1,
                before = amount(f.state(), card.id)
            f.call('SetEggCatchCard', { egg_guid: id, catch_card_id: card.id })
            f.call('HatchPetEgg', { build_guid: f.build().guid, egg_guid: id })
            const job = f.jobs()[0]
            assert.equal(amount(f.state(), card.id), before - 1)
            f.advance(job.seconds)
            const packets = f.call('ProductFinish', { guid: f.build().guid, product_guids: [job.guid] }),
                reward = packets.find((p) => p.id === 6111).data.reward.rewards[0],
                pet = f.state().pets.find((p) => p.guid === reward.guid),
                value = { special: pet.special, color: pet.color, colorful: pet.colorful }
            assert.equal(pet.catch_item, card.id)
            if (appearance) assert.deepEqual(value, appearance)
            else appearance = value
            assert.equal(amount(f.state(), card.id), before - 1)
        }
    } finally {
        f.close()
    }
})

test('unrecovered special-card branch rejects before charge and damaged payment references stay strict', () => {
    const f = fixture('hatch-card-strict')
    try {
        f.call('SetEggCatchCard', { egg_guid: 1, catch_card_id: 1000091 })
        unchanged(
            f,
            () => f.call('HatchPetEgg', { build_guid: f.build().guid, egg_guid: 1 }),
            (e) => e.code === ErrorCode.FunctionClosed,
        )
        f.call('SetEggCatchCard', { egg_guid: 1, catch_card_id: 1000002 })
        f.call('HatchPetEgg', { build_guid: f.build().guid, egg_guid: 1 })
        const job = f.jobs()[0]
        f.advance(job.seconds)
        f.edit((s) => {
            s.hatchCardReceipts[job.hatch_card.receipt_key].build_guid++
        })
        unchanged(
            f,
            () => f.call('ProductFinish', { guid: f.build().guid, product_guids: [job.guid] }),
            (e) => e.code === ErrorCode.GameConfig,
        )
    } finally {
        f.close()
    }
})

test('a trusted previous unmarked accepted-job shape is not retrocharged or rewritten by current default cards', () => {
    const f = fixture('hatch-card-previous-job')
    try {
        const config = tables.find('pet_egg', 20004001),
            buildGuid = f.build().guid,
            petCount = f.state().pets.length
        // Trusted historical saved state: exact pre-card startHatch job fields
        // from baseline99. This is a compatibility fixture, not a new producer.
        f.edit((s) => {
            s.home.productionJobs ??= {}
            s.home.productionJobs[buildGuid] = [
                {
                    kind: 'hatch',
                    eggGuid: 1,
                    petId: 500023,
                    guid: 900,
                    productId: config.product,
                    count: 1,
                    claimed: 0,
                    start: 1800000000,
                    seconds: config.eggTime,
                    costs: [],
                    rewards: [],
                    reportedDone: 0,
                },
            ]
            s.petEggs.find((e) => e.guid === 1).hatch_build_guid = buildGuid
            s.eggOutcomes = { 1: 500023 }
            s.home.nextProductGuid = 901
        })
        f.call('SetDefaultCatchCard', { catch_card_id: 1000003 })
        const cardCount = amount(f.state(), 1000003)
        f.advance(config.eggTime)
        const packets = f.call('ProductFinish', { guid: buildGuid, product_guids: [900] })
        assert.equal(packets.find((p) => p.id === 6111).data.reward.rewards[0].itemid, 500023)
        assert.equal(f.state().pets.length, petCount + 1)
        assert.equal(amount(f.state(), 1000003), cardCount)
        assert.equal(f.state().hatchCardReceipts, undefined)
        assert.equal(f.state().hatchReceipts[buildGuid + ':1'].hatch_card, undefined)
    } finally {
        f.close()
    }
})

test('marked current jobs cannot downgrade to legacy by losing a binding', () => {
    const f = fixture('hatch-card-marker')
    try {
        f.call('SetDefaultCatchCard', { catch_card_id: 1000002 })
        f.call('HatchPetEgg', { build_guid: f.build().guid, egg_guid: 1 })
        const job = f.jobs()[0]
        assert.equal(job.hatch_card_version, 1)
        f.advance(job.seconds)
        f.edit((s) => {
            delete s.home.productionJobs[f.build().guid][0].hatch_card
        })
        unchanged(
            f,
            () => f.call('ProductFinish', { guid: f.build().guid, product_guids: [job.guid] }),
            (e) => e.code === ErrorCode.GameConfig,
        )
    } finally {
        f.close()
    }
})

test('current queue capacity rejects before card charge and account-local egg IDs cannot select another account assets', () => {
    const f = fixture('hatch-card-capacity')
    try {
        const capacity = tables.find('home_building_production', 30231).productionQueueNum
        assert(capacity > 0)
        f.edit((s) =>
            grantRewards(
                tables,
                s,
                [
                    { itemtype: 3, itemid: 1000002, itemnum: capacity + 2 },
                    ...(capacity + 1 > s.petEggs.length
                        ? [{ itemtype: 14, itemid: 20004001, itemnum: capacity + 1 - s.petEggs.length }]
                        : []),
                ],
                0,
                { randomInt: () => 0 },
            ),
        )
        f.call('SetDefaultCatchCard', { catch_card_id: 1000002 })
        for (let id = 1; id <= capacity; id++) f.call('HatchPetEgg', { build_guid: f.build().guid, egg_guid: id })
        unchanged(
            f,
            () => f.call('HatchPetEgg', { build_guid: f.build().guid, egg_guid: capacity + 1 }),
            (e) => e.code === ErrorCode.ProductQueueFull,
        )
        const other = {}
        f.game.dispatch(other, f.frame('EnterGame', { open_id: 'hatch-card-other-account' }))
        const before = f.raw(),
            otherBefore = f.store.load(other.id)
        assert.throws(
            () => f.game.dispatch(other, f.frame('SetEggCatchCard', { egg_guid: 1, catch_card_id: 1000002 })),
            (e) => e.code === ErrorCode.EggNotExist,
        )
        assert.deepEqual(f.raw(), before)
        assert.deepEqual(f.store.load(other.id), otherBefore)
    } finally {
        f.close()
    }
})

test('current actual factory guaranteed-star egg rejects the incompatible high-value card without consuming it', () => {
    const f = fixture('hatch-card-star-conflict')
    try {
        let eggGuid
        f.edit((s) => {
            const row = tables.find('pet_egg', 20004001),
                weights = (text) =>
                    String(text)
                        .split('|')
                        .map((v) => v.split('#').map(Number)),
                quantities = weights(row.affixquantityweight),
                affixes = weights(row.affixweight)
            let quantityOffset = 0,
                affixOffset = 0
            for (const [count, weight] of quantities) {
                if (count === 1) break
                quantityOffset += weight
            }
            for (const [id, weight] of affixes) {
                if (id === 8) break
                affixOffset += weight
            }
            assert(quantities.some(([count]) => count === 1) && affixes.some(([id]) => id === 8))
            const draws = [quantityOffset, affixOffset]
            const rewards = grantRewards(tables, s, [{ itemtype: 14, itemid: row.id, itemnum: 1 }], 0, {
                randomInt: () => draws.shift(),
            })
            eggGuid = rewards[0].guid
        })
        assert.deepEqual(egg(f, Number(eggGuid)).egg_affix, [8])
        unchanged(
            f,
            () => f.call('SetEggCatchCard', { egg_guid: Number(eggGuid), catch_card_id: 1000091 }),
            (e) => e.code === ErrorCode.StarColrCardUnMatched,
        )
    } finally {
        f.close()
    }
})
