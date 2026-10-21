import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { createPets } from '../src/pets.js'
import { initialPetComprehension } from '../src/pet-comprehension.js'
import { petComprehensionPlan } from '../src/pet-comprehension-training.js'
import { petModules } from '../src/battle.js'
import { grantRewards } from '../src/rewards.js'
import { ErrorCode } from '../src/error-codes.js'

const cfg = configuration()
function fixture(name) {
    const tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base),
        store = new Store(':memory:'),
        session = {}
    let now = 1790600000,
        seq = 1
    const game = new Game(protocol, store, tables, { clock: () => now })
    const call = (name, data = {}, who = session) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(who, { id: e.id, seq: seq++, payload: protocol.encode(e.req, data) })
    }
    call('EnterGame', { open_id: name })
    const fruits = tables.get('pet_feed_item').filter((r) => r.type === 1)
    store.transact(session.id, 0, (s) => {
        s.pets = []
        s.petBoxes = []
        for (const h of s.player.heros_info.heros) h.pet_id = '0'
        for (const g of s.player.group_mgrs[0].groups) for (const h of g.heros) h.pet_id = '0'
        const [pet] = createPets(tables, s, 500002, 2)
        pet.comprehension = initialPetComprehension(tables, 1001, () => 0)
        s.player.sbag_infos.items = s.player.sbag_infos.items.filter((i) => !fruits.some((f) => f.id === i.itemid))
    })
    const state = () => store.load(session.id).state,
        guid = state().pets[0].guid
    const selected = () => state().pets.find((p) => p.guid === guid)
    const fund = (id, count) =>
        store.transact(session.id, 0, (s) => grantRewards(tables, s, [{ itemtype: 3, itemid: id, itemnum: count }]))
    const stock = (id) =>
        state()
            .player.sbag_infos.items.filter((i) => i.itemid === id)
            .reduce((n, i) => n + i.itemnum, 0)
    return {
        tables,
        protocol,
        store,
        session,
        game,
        call,
        state,
        guid,
        pet: selected,
        fund,
        stock,
        now: () => now,
        advance: (n) => (now += n),
        reload: () => call('EnterGame', { open_id: name }, {}),
    }
}
const row = (pet, id) => pet.comprehension.find((r) => r.attr_id === id)
function stateWithoutTraining(pet) {
    const { comprehension, favor_lv, favor_val, daily_favor_time, daily_favor_val, daily_favor_count, ...rest } = pet
    return rest
}

test('all six current fruits plan every tier transition from the 54-row table and never reroll innate levels', () => {
    const f = fixture('comprehension-catalog')
    try {
        const fruits = f.tables.get('pet_feed_item').filter((r) => r.type === 1)
        assert.equal(fruits.length, 6)
        let transitions = 0
        for (const fruit of fruits) {
            const [attr, gain] = fruit.param.split('#').map(Number)
            const rows = f.tables
                .get('pet_talent_upgrade')
                .filter((r) => r.attrId === attr)
                .sort((a, b) => a.level - b.level)
            for (const current of rows.slice(0, -1)) {
                const pet = structuredClone(f.pet()),
                    c = row(pet, attr)
                Object.assign(c, { level: current.level, value: current.InterA, cur_exp: 0, init_level: 1 })
                const before = structuredClone(pet)
                const plan = petComprehensionPlan(f.tables, pet, [
                    { item_id: fruit.id, item_num: Math.ceil(current.nextExpVal / gain) },
                ])
                const after = plan.comprehension.find((r) => r.attr_id === attr)
                assert.equal(after.level, current.level + 1)
                assert.equal(after.value, rows[current.level].InterA)
                assert.equal(after.init_level, 1)
                assert.deepEqual(pet, before)
                transitions++
            }
        }
        assert.equal(transitions, 48)
    } finally {
        f.store.close()
    }
})

test('6533 debits real stock, advances only selected dimensions, preserves identity and publishes pet/battle data before ACK', () => {
    const f = fixture('comprehension-owned')
    try {
        assert(BigInt(f.guid) > BigInt(Number.MAX_SAFE_INTEGER))
        f.fund(1700001, 4)
        const before = structuredClone(f.pet()),
            other = structuredClone(f.state().pets[1])
        assert.equal(row(before, 1).level, 1)
        const oldAttrs = petModules(f.tables, f.state(), before, []).modules[0].sub_modules[0].attrs.attrs
        const packets = f.call('LvUpComprehension', { pet_id: f.guid, items: [{ item_id: 1700001, item_num: 1 }] })
        const after = f.pet(),
            actual = row(after, 1)
        assert.deepEqual(actual, { ...row(before, 1), level: 2, value: 90, cur_exp: 0 })
        assert.equal(f.stock(1700001), 3)
        assert.deepEqual(stateWithoutTraining(after), stateWithoutTraining(before))
        assert.deepEqual(f.state().pets[1], other)
        for (const r of before.comprehension.filter((r) => r.attr_id !== 1)) assert.deepEqual(row(after, r.attr_id), r)
        assert.equal(after.favor_lv, 1)
        assert.equal(after.favor_val, 8)
        assert.equal(after.daily_favor_count, 8)
        assert.deepEqual(after.daily_favor_val, [{ source_type: 162, favor_val: 8 }])
        const ack = packets.findIndex((p) => p.id === 6533),
            petSync = f.protocol.byName.get('CSProtoPetInfoSync'),
            attrSync = f.protocol.byName.get('CSProtoHeroAttrInfoSync')
        assert(packets.slice(0, ack).some((p) => p.id === petSync.id))
        const update = packets.slice(0, ack).find((p) => p.id === attrSync.id)
        assert(update)
        const petData = f.protocol.decode(attrSync.rsp, update.payload).heros.find((p) => p.hero_guid === f.guid)
        const nextAttack = petData.modules[0].sub_modules[0].attrs.attrs.find((a) => a.attr_id === 1).attr_val
        assert(BigInt(nextAttack) > BigInt(oldAttrs.find((a) => a.attr_id === 1).attr_val))
        f.reload()
        assert.equal(row(f.pet(), 1).level, 2)
        assert.equal(f.stock(1700001), 3)
        assert.equal(row(f.pet(), 1).init_level, row(before, 1).init_level)
    } finally {
        f.store.close()
    }
})

test('duplicate item lines aggregate, multiple dimensions train together and partial EXP is retained at the new tier', () => {
    const f = fixture('comprehension-batch')
    try {
        f.fund(1700001, 4)
        f.fund(1700002, 4)
        f.store.transact(
            f.session.id,
            0,
            (s) =>
                (row(
                    s.pets.find((p) => p.guid === f.guid),
                    1,
                ).cur_exp = 50),
        )
        f.call('LvUpComprehension', {
            pet_id: f.guid,
            items: [
                { item_id: 1700001, item_num: 1 },
                { item_id: 1700001, item_num: 1 },
                { item_id: 1700002, item_num: 3 },
            ],
        })
        assert.equal(f.stock(1700001), 2)
        assert.equal(f.stock(1700002), 1)
        assert.equal(row(f.pet(), 1).level, 3)
        assert.equal(row(f.pet(), 1).cur_exp, 50)
        assert.equal(row(f.pet(), 1).value, 100)
        assert.equal(row(f.pet(), 5).level, 4)
        assert.equal(row(f.pet(), 5).cur_exp, 0)
        assert.equal(f.pet().favor_val, 40)
    } finally {
        f.store.close()
    }
})

test('one necessary final fruit may overflow EXP, but fully wasted extras and already-max dimensions cannot consume stock', () => {
    const f = fixture('comprehension-cap')
    try {
        f.fund(1700001, 10)
        f.store.transact(f.session.id, 0, (s) =>
            Object.assign(
                row(
                    s.pets.find((p) => p.guid === f.guid),
                    1,
                ),
                { level: 8, value: 150, cur_exp: 50 },
            ),
        )
        const before = structuredClone(f.state())
        assert.throws(
            () => f.call('LvUpComprehension', { pet_id: f.guid, items: [{ item_id: 1700001, item_num: 2 }] }),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
        assert.deepEqual(f.state(), before)
        f.call('LvUpComprehension', { pet_id: f.guid, items: [{ item_id: 1700001, item_num: 1 }] })
        assert.equal(row(f.pet(), 1).level, 9)
        assert.equal(row(f.pet(), 1).value, 165)
        assert.equal(row(f.pet(), 1).cur_exp, 0)
        const capped = structuredClone(f.state())
        assert.throws(
            () => f.call('LvUpComprehension', { pet_id: f.guid, items: [{ item_id: 1700001, item_num: 1 }] }),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
        assert.deepEqual(f.state(), capped)
        assert.equal(f.stock(1700001), 9)
    } finally {
        f.store.close()
    }
})

test('empty, wrong-type, unowned, missing-dimension and insufficient-stock requests fail without EXP, favor or inventory changes', () => {
    const f = fixture('comprehension-invalid')
    try {
        f.fund(1700001, 1)
        const base = structuredClone(f.state())
        const geneFruit = f.tables.get('pet_feed_item').find((r) => r.type === 3).id
        const cases = [
            { items: [], code: ErrorCode.PetComprehensionItemSizeInvilid },
            { items: [{ item_id: 1700001, item_num: 0 }], code: ErrorCode.InvalidArgument },
            { items: [{ item_id: 1700001, item_num: 2 }], code: ErrorCode.ItemNotEnough },
            { items: [{ item_id: geneFruit, item_num: 1 }], code: ErrorCode.PetComprehensionItemInvilid },
            {
                items: [
                    { item_id: 1700001, item_num: 1 },
                    { item_id: 0xffffffff, item_num: 1 },
                ],
                code: ErrorCode.PetComprehensionItemInvilid,
            },
            { items: [{ item_id: 1700001, item_num: 1 }], guid: '9999999999999', code: ErrorCode.PetNotExist },
            {
                items: [{ item_id: 1700001, item_num: 1 }],
                mutate: (s) => (s.pets[0].config_id = 0xffffffff),
                code: ErrorCode.PetConfNotExist,
            },
            {
                items: [{ item_id: 1700001, item_num: 1 }],
                mutate: (s) => s.pets[0].comprehension.pop(),
                code: ErrorCode.PetComprehensionNotExist,
            },
        ]
        for (const c of cases) {
            f.store.transact(f.session.id, 0, (s) => {
                Object.assign(s, structuredClone(base))
                c.mutate?.(s)
            })
            const before = structuredClone(f.state())
            assert.throws(
                () => f.call('LvUpComprehension', { pet_id: c.guid ?? f.guid, items: c.items }),
                (e) => e.code === c.code,
            )
            assert.deepEqual(f.state(), before)
        }
    } finally {
        f.store.close()
    }
})

test('favor has a shared daily point cap, does not block training at cap, and resets sources on reconnect after refresh', () => {
    const f = fixture('comprehension-favor-cap')
    try {
        f.fund(1700001, 3)
        f.fund(1700002, 3)
        f.store.transact(f.session.id, 0, (s) => {
            const p = s.pets.find((p) => p.guid === f.guid)
            Object.assign(p, {
                favor_lv: 4,
                favor_val: 145,
                daily_favor_count: 495,
                daily_favor_val: [{ source_type: 1, favor_val: 495 }],
                daily_favor_time: f.now(),
            })
        })
        f.call('LvUpComprehension', { pet_id: f.guid, items: [{ item_id: 1700001, item_num: 1 }] })
        assert.equal(f.pet().favor_val, 150)
        assert.equal(f.pet().daily_favor_count, 500)
        f.call('LvUpComprehension', { pet_id: f.guid, items: [{ item_id: 1700002, item_num: 1 }] })
        assert.equal(row(f.pet(), 5).level, 2)
        assert.equal(f.pet().favor_val, 150)
        f.advance(86400)
        f.reload()
        assert.equal(f.pet().daily_favor_count, 0)
        assert.deepEqual(f.pet().daily_favor_val, [])
        f.call('LvUpComprehension', { pet_id: f.guid, items: [{ item_id: 1700001, item_num: 1 }] })
        assert.equal(f.pet().favor_val, 158)
        assert.equal(f.pet().daily_favor_count, 8)
    } finally {
        f.store.close()
    }
})

test('fruit favor and caress share totals without fruit points being mistaken for caress interaction counts', () => {
    const f = fixture('comprehension-caress')
    try {
        f.fund(1700001, 1)
        f.call('LvUpComprehension', { pet_id: f.guid, items: [{ item_id: 1700001, item_num: 1 }] })
        f.call('EnterHome', { creator_id: f.session.id })
        const packets = f.call('PetCaress', { u64: f.guid }),
            e = f.protocol.byName.get('CSProtoPetCaress')
        const result = f.protocol.decode(e.rsp, packets.find((p) => p.id === e.id).payload)
        assert.equal(result.favor_exp_add, 50)
        assert.equal(result.favor_lv_add, 1)
        assert.equal(f.pet().favor_lv, 2)
        assert.equal(f.pet().favor_val, 8)
        assert.equal(f.pet().daily_favor_count, 58)
        f.call('PetCaress', { u64: f.guid })
        assert.equal(f.pet().daily_favor_count, 58)
    } finally {
        f.store.close()
    }
})

test('legacy caress counters migrate from recorded earned favor without granting that favor a second time', () => {
    const f = fixture('comprehension-legacy-favor')
    try {
        f.fund(1700001, 1)
        f.store.transact(f.session.id, 0, (s) =>
            Object.assign(s.pets[0], {
                favor_lv: 2,
                favor_val: 0,
                daily_favor_count: 1,
                daily_favor_val: [{ source_type: 4, favor_val: 50 }],
                daily_favor_time: f.now(),
            }),
        )
        f.reload()
        assert.equal(f.pet().daily_favor_count, 50)
        assert.equal(f.pet().favor_lv, 2)
        assert.equal(f.pet().favor_val, 0)
        f.call('LvUpComprehension', { pet_id: f.guid, items: [{ item_id: 1700001, item_num: 1 }] })
        assert.equal(f.pet().favor_val, 8)
        assert.equal(f.pet().daily_favor_count, 58)
    } finally {
        f.store.close()
    }
})

test('a pet at maximum favor can still train without gaining extra favor or rerolling its innate profile', () => {
    const f = fixture('comprehension-favor-max')
    try {
        f.fund(1700001, 1)
        f.store.transact(f.session.id, 0, (s) => Object.assign(s.pets[0], { favor_lv: 10, favor_val: 0 }))
        const innate = f.pet().comprehension.map((r) => r.init_level)
        f.call('LvUpComprehension', { pet_id: f.guid, items: [{ item_id: 1700001, item_num: 1 }] })
        assert.equal(row(f.pet(), 1).level, 2)
        assert.equal(f.pet().favor_lv, 10)
        assert.equal(f.pet().favor_val, 0)
        assert.equal(f.pet().daily_favor_count, 0)
        assert.deepEqual(
            f.pet().comprehension.map((r) => r.init_level),
            innate,
        )
    } finally {
        f.store.close()
    }
})

test('later bad fruit metadata and invalid favor configuration never spend an earlier valid fruit', () => {
    const f = fixture('comprehension-config-atomic')
    const bad = f.tables.find('pet_feed_item', 1700002),
        oldParam = bad.param
    const favor = f.tables.get('game').find((r) => r.title === 'FRUIT_PET_FAVORABILITY_ONCE'),
        oldFavor = favor.value
    try {
        f.fund(1700001, 1)
        f.fund(1700002, 1)
        bad.param = '99999#100'
        let before = structuredClone(f.state())
        assert.throws(
            () =>
                f.call('LvUpComprehension', {
                    pet_id: f.guid,
                    items: [
                        { item_id: 1700001, item_num: 1 },
                        { item_id: 1700002, item_num: 1 },
                    ],
                }),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
        bad.param = oldParam
        favor.value = '0|0|5|-1|10'
        before = structuredClone(f.state())
        assert.throws(
            () => f.call('LvUpComprehension', { pet_id: f.guid, items: [{ item_id: 1700001, item_num: 1 }] }),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        bad.param = oldParam
        favor.value = oldFavor
        f.store.close()
    }
})
