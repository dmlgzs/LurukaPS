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
import { createEggs, upgradeEggState } from '../src/eggs.js'
import { grantRewards } from '../src/rewards.js'
const c = configuration(),
    t = new Tables(c.tables),
    p = new Protocol(c.base)
test('shop egg awards have unique GUIDs, precede the reply, and persist across restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-eggs-')),
        db = path.join(dir, 'state.sqlite')
    let store = new Store(db),
        game = new Game(p, store, t, { clock: () => 1800000000, rng: () => 0 }),
        session = {}
    let seq = 1
    const call = (name, r) => {
        const e = p.byName.get('CSProto' + name)
        return game.dispatch(session, { id: e.id, seq: seq++, pushSeq: 0, payload: p.encode(e.req, r) })
    }
    try {
        call('EnterGame', { open_id: 'eggs' })
        const id = session.id
        store.transact(id, 0, (s) => {
            s.player.basic_info.lv = 25
            const currency = s.player.attr_infos.attrs.find((row) => row.attr_id === 413)
            if (currency) currency.attr_val = '1000'
            else s.player.attr_infos.attrs.push({ attr_id: 413, attr_val: '1000' })
        })
        const result = call('ShopBuyItems', { shop_id: 502, items: [{ slot_id: 502002, goods_id: 502002, times: 2 }] })
        assert(result.findIndex((x) => x.id === 6518) < result.findIndex((x) => x.id === 6071))
        const reward = p.decode('SCShopBuyItems', result.find((x) => x.id === 6071).payload).rewards[0].rewards
        assert.equal(reward.length, 2)
        assert.notEqual(reward[0].guid, reward[1].guid)
        assert(reward.every((r) => r.itemtype === 14 && r.itemnum === 1))
        const eggs = store.load(id).state.petEggs
        assert.deepEqual(
            eggs.map((e) => e.egg_affix),
            [[], []],
        )
        call('PetEggLock', { guid: String(eggs[0].guid), lock_operate: true })
        store.close()
        store = new Store(db)
        game = new Game(p, store, t, { clock: () => 1800000000, rng: () => 0 })
        session = {}
        const login = call('EnterGame', { open_id: 'eggs' })
        const restored = p.decode('SCPetEggInfoSync', login.find((x) => x.id === 6518).payload).egg_infos.eggs
        assert.equal(restored.length, 2)
        assert.equal(restored[0].lock_state, true)
        assert.equal(session.id, id)
        const before = store.load(id)
        assert.throws(() => call('PetEggLock', { guid: '999', lock_operate: true }))
        assert.deepEqual(store.load(id), before)
        store.transact(id, 0, (s) => grantRewards(t, s, [{ itemtype: 14, itemid: 40003007, itemnum: 1 }]))
        assert.equal(store.load(id).state.petEggs[2].guid, 3)
    } finally {
        store.close()
        assert.equal(path.dirname(dir), os.tmpdir())
        assert(path.basename(dir).startsWith('lurukaps-eggs-'))
        fs.rmSync(dir, { recursive: true })
    }
})
test('egg allocation obeys capacity, identity overflow and rollback on later invalid reward', () => {
    const store = new Store(':memory:')
    try {
        const game = new Game(p, store, t, { clock: () => 1800000000, rng: () => 0 }),
            session = {},
            entry = p.byName.get('CSProtoEnterGame')
        game.dispatch(session, {
            id: entry.id,
            seq: 1,
            pushSeq: 0,
            payload: p.encode(entry.req, { open_id: 'rollback-eggs' }),
        })
        const before = store.load(session.id)
        assert.throws(() =>
            store.transact(session.id, 0, (s) =>
                grantRewards(t, s, [
                    { itemtype: 14, itemid: 40003007, itemnum: 1 },
                    { itemtype: 999, itemid: 1, itemnum: 1 },
                ]),
            ),
        )
        assert.deepEqual(store.load(session.id), before)
        assert.throws(() => createEggs(t, { petEggs: [], nextEggGuid: 0xffffffff }, 40003007, 2), /GUID/)
        assert.throws(
            () => createEggs(t, { petEggs: Array.from({ length: 1000 }, (_, i) => ({ guid: i + 1 })) }, 40003007, 1),
            /full/,
        )
    } finally {
        store.close()
    }
})
test('configured weighted affixes respect mutex groups and old GUIDs are not reused', () => {
    const fake = {
        find: (name, id) =>
            name === 'pet_egg'
                ? { id, affixquantityweight: '2#1', affixweight: '1#1|2#1|3#1' }
                : { id, mutexgroup: id < 3 ? 4 : 5 },
        get: () => [{ title: 'PET_EGG_LIMITS', value: '1000' }],
    }
    const state = { petEggs: [{ guid: 50 }], nextEggGuid: 1 }
    const [egg] = createEggs(fake, state, 1, 1, () => 0)
    assert.equal(egg.guid, 51)
    assert.deepEqual(egg.egg_affix, [1, 3])
    assert.equal(egg.hatch_state, p.root.lookupEnum('cs.PetEggHatchState').values.PEHS_NORMAL)
})
test('mail uses typed rewards and egg entities are synchronized before fetch completion', () => {
    const store = new Store(':memory:'),
        game = new Game(p, store, t, { clock: () => 1800000000, rng: () => 0 }),
        session = {}
    let seq = 1
    const call = (name, r) => {
        const e = p.byName.get('CSProto' + name)
        return game.dispatch(session, { id: e.id, seq: seq++, pushSeq: 0, payload: p.encode(e.req, r) })
    }
    try {
        call('EnterGame', { open_id: 'mail-eggs' })
        store.transact(session.id, 0, (s) =>
            s.mail.push({
                guid: '1',
                read: false,
                fetch: false,
                reward: {
                    rewards: [
                        { itemtype: 10, itemid: 2, itemnum: 100 },
                        { itemtype: 14, itemid: 40003007, itemnum: 1 },
                    ],
                },
            }),
        )
        const packets = call('FetchMail', { u64: '1' })
        assert(packets.findIndex((x) => x.id === 6518) < packets.findIndex((x) => x.id === 6121))
        const state = store.load(session.id).state
        assert.equal(state.player.basic_info.gold, 100)
        assert.equal(state.petEggs.length, 1)
        assert.equal(state.mail[0].fetch, true)
        const before = store.load(session.id)
        assert.throws(() => call('FetchMail', { u64: '1' }))
        assert.deepEqual(store.load(session.id), before)
        assert.throws(() =>
            store.transact(session.id, 0, (s) => grantRewards(t, s, [{ itemtype: 10, itemid: 2, itemnum: -1 }])),
        )
        assert.deepEqual(store.load(session.id), before)
    } finally {
        store.close()
    }
})

test('wire egg state migration repairs old unassigned UI-idle values and preserves queued eggs', () => {
    const state = {
        petEggs: [
            { guid: 1, hatch_state: 1 },
            { guid: 2, hatch_state: 1, hatch_build_guid: 55 },
            { guid: 3, hatch_state: 2, hatch_build_guid: 55 },
        ],
        eggRevision: 2,
    }
    upgradeEggState(state)
    assert.deepEqual(
        state.petEggs.map((e) => e.hatch_state),
        [0, 1, 2],
    )
    assert.equal(state.eggSchemaVersion, 2)
    const before = structuredClone(state)
    upgradeEggState(state)
    assert.deepEqual(state, before)
})
