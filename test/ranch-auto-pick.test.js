import test from 'node:test'
import assert from 'node:assert/strict'
import { ranchFixture } from './ranch-fixture.js'
import { ranchStoredSlots } from '../src/ranch-claims.js'
import { ErrorCode } from '../src/error-codes.js'
import fs from 'node:fs'

function produce(f, gather = true) {
    f.assign()
    if (gather) {
        f.store.transact(f.session.id, 0, (s) => {
            s.pets.find((p) => p.guid === f.pets[1]).labor_infos = [{ labor_id: 9, labor_grade: 1 }]
        })
        f.assign(f.pets[1], 0, 2)
    }
    f.elapse(360)
    f.tick()
    return f.state().home.ranches[201].drops
}
const auto = (f, guid) => f.call('RanchPetAutoGetReward', { block_id: 201, reward_guid: guid })

test('6161 transfers ground loot into ranch storage without granting the player inventory', () => {
    const f = ranchFixture('ranch-auto')
    try {
        const drops = produce(f),
            before = f.state().player.sbag_infos,
            first = drops[0]
        const out = auto(f, first.guid),
            s = f.state()
        assert.equal(out.at(-1).id, 6161)
        assert.equal(s.home.ranches[201].stores.find((i) => i.itemid === first.item.itemid).itemnum, first.item.itemnum)
        assert(!s.home.ranches[201].drops.some((d) => d.guid === first.guid))
        assert.deepEqual(s.player.sbag_infos, before)
        const settled = f.state()
        auto(f, first.guid)
        assert.deepEqual(f.state(), settled)
        f.call('RanchPlayerGetReward', { block_id: 201, reward_guids: [first.guid] })
        assert.deepEqual(f.state().player.sbag_infos, before, 'manual/auto races do not pay a stored item')
        for (const drop of drops.slice(1)) auto(f, drop.guid)
        const login = f.call('EnterGame', { open_id: 'ranch-auto' }, {})
        const wire = f.protocol
            .decode('SCHomeSync', login.find((p) => p.id === 6102).payload)
            .home_builds.find((b) => b.build_type === 53).ranch_pet_work_info
        assert.equal(wire.stores.length, drops.length)
        assert.equal(wire.drops.length, 0)
    } finally {
        f.close()
    }
})
test('missing harvesting workers and missing ground GUIDs fail without deleting loot', () => {
    const f = ranchFixture('ranch-auto-no-worker')
    try {
        const drops = produce(f, false),
            before = f.store.load(f.session.id)
        assert.throws(
            () => auto(f, drops[0].guid),
            (e) => e.code === ErrorCode.BuildPetAutoWorkInvalid,
        )
        assert.deepEqual(f.store.load(f.session.id), before)
        assert.throws(
            () => auto(f, 999999),
            (e) => e.code === ErrorCode.HomeRanchDropNotExist,
        )
        assert.deepEqual(f.store.load(f.session.id), before)
    } finally {
        f.close()
    }
})
test('storage capacity counts actual item stacks and full or overflowing stores keep the ground drop', () => {
    const f = ranchFixture('ranch-auto-capacity')
    try {
        const drops = produce(f),
            first = drops[0],
            numeric = JSON.parse(
                fs.readFileSync(new URL('../configs/inventory-tables/common_item.json', import.meta.url)),
            )
        const stacked = numeric.find((row) => row.stackNum > 0)
        assert(stacked)
        assert.equal(ranchStoredSlots([{ itemtype: 3, itemid: stacked.id, itemnum: stacked.stackNum + 1 }]), 2)
        const limit = f.tables.get('home_ranch')[0].storageLimit
        const candidates = numeric
            .filter((row) => row.stackNum === 0 && row.id !== first.item.itemid && f.tables.find('common_item', row.id))
            .slice(0, limit)
        assert.equal(candidates.length, limit)
        f.store.transact(f.session.id, 0, (s) => {
            s.home.ranches[201].stores = candidates.map((row) => ({ itemtype: 3, itemid: row.id, itemnum: 1 }))
        })
        let before = f.store.load(f.session.id)
        assert.throws(
            () => auto(f, first.guid),
            (e) => e.code === ErrorCode.BagItemFull,
        )
        assert.deepEqual(f.store.load(f.session.id), before)
        f.store.transact(f.session.id, 0, (s) => {
            s.home.ranches[201].stores = [{ ...first.item, itemnum: 0xffffffff }]
        })
        before = f.store.load(f.session.id)
        assert.throws(
            () => auto(f, first.guid),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.store.load(f.session.id), before)
    } finally {
        f.close()
    }
})
test('encoding failure rolls back an automatic pickup before any drop or warehouse state changes', () => {
    const f = ranchFixture('ranch-auto-rollback')
    try {
        const drops = produce(f),
            before = f.store.load(f.session.id),
            packet = f.game.packet
        f.game.packet = function (name, ...args) {
            if (name === 'CSProtoHomeSync') throw Error('auto pickup failed')
            return packet.call(this, name, ...args)
        }
        assert.throws(() => auto(f, drops[0].guid), /auto pickup failed/)
        assert.deepEqual(f.store.load(f.session.id), before)
        f.game.packet = packet
        auto(f, drops[0].guid)
        assert(f.state().home.ranches[201].stores.length > 0)
    } finally {
        f.close()
    }
})
