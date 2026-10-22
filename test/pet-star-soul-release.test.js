import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { petData } from '../src/pets.js'
import { addItems } from '../src/inventory.js'
import { petSoulRefunds } from '../src/pet-star-soul.js'
import { ErrorCode } from '../src/error-codes.js'
const tables = new Tables(configuration().tables),
    protocol = new Protocol(configuration().base),
    guid = '144115188099999999'
const packed = (g, n) => ((BigInt(g) << 32n) | BigInt(n)).toString()
function setup() {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => 1792680000 })
    let session = {},
        seq = 1
    const call = (name, r) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, r) })
    }
    const login = () => {
        session = {}
        return call('EnterGame', { open_id: 'soul-refund' })
    }
    login()
    const edit = (fn) => store.transact(session.id, 0, fn)
    edit((s) => {
        s.player.basic_info.lv = 30
        s.player.basic_info.gold = 100000000
        const p = petData(tables, 500001, guid, 2001)
        p.is_lock = false
        s.pets.push(p)
        addItems(
            s,
            [1720001, 1720002, 1720003, 1720004, 2200020].map((itemid) => ({ itemid, itemnum: 10000 })),
        )
    })
    return { store, call, edit, login, state: () => store.load(session.id).state }
}
const pet = (s) => s.pets.find((p) => p.guid === guid),
    count = (s, id) => s.player.sbag_infos.items.filter((i) => i.itemid === id).reduce((n, i) => n + i.itemnum, 0)
test('6512 after twenty real 11912 upgrades refunds the configured current-row cumulative materials once and persists deletion', () => {
    const f = setup()
    try {
        for (let i = 0; i < 20; i++) f.call('KiboStarLinkSoulUpdate', { u64: guid })
        const before = f.state(),
            p = pet(before),
            refund = petSoulRefunds(tables, p)
        assert.equal(p.soul_link_level, packed(6, 1))
        assert.ok(refund.length > 0)
        const packets = f.call('DelPet', { pet_list: [guid] }),
            after = f.state()
        assert.equal(pet(after), undefined)
        for (const r of refund) assert.equal(count(after, r.itemid) - count(before, r.itemid), r.itemnum)
        assert.equal(after.player.basic_info.gold, before.player.basic_info.gold)
        const sync = packets.findIndex((p) => p.id === protocol.byName.get('CSProtoPetInfoSync').id),
            ack = packets.findIndex((p) => p.id === protocol.byName.get('CSProtoDelPet').id)
        assert.ok(sync >= 0 && sync < ack)
        const settled = f.state()
        assert.throws(() => f.call('DelPet', { pet_list: [guid] }))
        assert.deepEqual(f.state(), settled)
        f.store.flushPending()
        f.login()
        assert.equal(pet(f.state()), undefined)
        for (const r of refund) assert.equal(count(f.state(), r.itemid), count(after, r.itemid))
    } finally {
        f.store.close()
    }
})
test('6512 absent, zero and encoded initial 1/1 have zero soul refund and preserve ordinary release behavior', () => {
    const f = setup()
    try {
        const p = pet(f.state())
        for (const raw of [undefined, '0', packed(1, 1)])
            assert.deepEqual(petSoulRefunds(tables, { ...p, soul_link_level: raw }), [])
        f.edit((s) => {
            pet(s).soul_link_level = packed(1, 1)
        })
        const before = f.state()
        f.call('DelPet', { pet_list: [guid] })
        assert.equal(pet(f.state()), undefined)
        assert.equal(count(f.state(), 2200020), count(before, 2200020))
    } finally {
        f.store.close()
    }
})
test('6512 soul refund cannot bypass active NPC inventory source protection and codec failure restores pet, materials and release ledger', () => {
    const f = setup()
    try {
        // Completed source state is a fixture here; the first test reaches it only via 11912.
        f.edit((s) => {
            pet(s).soul_link_level = packed(6, 1)
            s.multiCampaign = { duel_id: 2, start_time: 100 }
            s.combat = {
                npcDuel: {
                    duel_id: 2,
                    start_time: 100,
                    map_id: s.world.map_id,
                    actors: { active: { camp: 1, source_guid: guid } },
                },
            }
        })
        let before = f.state()
        assert.throws(
            () => f.call('DelPet', { pet_list: [guid] }),
            (e) => e.code === ErrorCode.PetInBattle,
        )
        assert.deepEqual(f.state(), before)
        f.edit((s) => {
            delete s.multiCampaign
            delete s.combat
        })
        before = f.state()
        const old = protocol.encode
        protocol.encode = function (name, r) {
            if (name === protocol.byName.get('CSProtoDelPet').rsp) throw Error('refund codec failure')
            return old.call(this, name, r)
        }
        try {
            assert.throws(() => f.call('DelPet', { pet_list: [guid] }), /codec failure/)
        } finally {
            protocol.encode = old
        }
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})
