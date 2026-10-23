import test from 'node:test'
import assert from 'node:assert/strict'
import { ranchFixture } from './ranch-fixture.js'
import { createEggs } from '../src/eggs.js'
import { ErrorCode } from '../src/error-codes.js'

function produce(f) {
    f.assign()
    f.elapse(360)
    f.tick()
    return f.state().home.ranches[201].drops
}
const count = (state, id) =>
    state.player.sbag_infos.items.filter((i) => i.itemid === id).reduce((sum, i) => sum + i.itemnum, 0)
function seedEgg(f) {
    let result
    f.store.transact(f.session.id, 0, (s) => {
        const id = f.tables.get('pet_egg')[0].id
        result = createEggs(f.tables, s, id, 1)[0]
        s.petEggs = s.petEggs.filter((egg) => egg.guid !== result.guid)
        s.home.ranches[201].eggs.push(result)
    })
    return result
}
test('6160 transfers selected real drops to inventory before its null reply and retries cannot pay twice', () => {
    const f = ranchFixture('ranch-player-pick')
    try {
        const drops = produce(f),
            before = f.state(),
            selected = drops[0]
        const req = { block_id: 201, reward_guids: [selected.guid] },
            out = f.call('RanchPlayerGetReward', req)
        assert.equal(out.at(-1).id, 6160)
        assert(out.findIndex((p) => p.id === 5008) >= 0 && out.findIndex((p) => p.id === 5008) < out.length - 1)
        assert(out.findIndex((p) => p.id === 6102) >= 0 && out.findIndex((p) => p.id === 6102) < out.length - 1)
        assert.equal(
            count(f.state(), selected.item.itemid),
            count(before, selected.item.itemid) + selected.item.itemnum,
        )
        assert(!f.state().home.ranches[201].drops.some((d) => d.guid === selected.guid))
        assert.equal(f.state().home.ranches[201].drops.length, drops.length - 1)
        const after = f.state()
        f.call('RanchPlayerGetReward', req)
        assert.deepEqual(f.state(), after)
        f.call('EnterGame', { open_id: 'ranch-player-pick' }, {})
        f.call('RanchPlayerGetReward', req)
        assert.equal(count(f.state(), selected.item.itemid), count(after, selected.item.itemid))
    } finally {
        f.close()
    }
})
test('batch material and egg pickup preserves the persisted egg GUID, affixes and properties', () => {
    const f = ranchFixture('ranch-player-egg')
    try {
        const drops = produce(f),
            egg = seedEgg(f)
        const out = f.call('RanchPlayerGetReward', {
            block_id: 201,
            reward_guids: drops.map((d) => d.guid),
            egg_guids: [egg.guid],
        })
        const s = f.state()
        assert.deepEqual(
            s.petEggs.find((e) => e.guid === egg.guid),
            egg,
        )
        assert.deepEqual(s.home.ranches[201].eggs, [])
        assert.deepEqual(s.home.ranches[201].drops, [])
        assert(out.findIndex((p) => p.id === 6518) >= 0 && out.findIndex((p) => p.id === 6518) < out.length - 1)
        const settled = f.state()
        f.call('RanchPlayerGetReward', { block_id: 201, reward_guids: drops.map((d) => d.guid), egg_guids: [egg.guid] })
        assert.deepEqual(f.state(), settled)
    } finally {
        f.close()
    }
})
test('unknown, duplicate, empty and mixed stale GUIDs fail without partial pickup', () => {
    const f = ranchFixture('ranch-player-bad')
    try {
        const drops = produce(f)
        for (const req of [
            { reward_guids: [drops[0].guid, 999999] },
            { reward_guids: [drops[0].guid, drops[0].guid] },
            { reward_guids: [] },
            { egg_guids: [999999] },
            { reward_guids: [drops[0].guid], egg_guids: [999999] },
        ]) {
            const before = f.store.load(f.session.id)
            assert.throws(() => f.call('RanchPlayerGetReward', { block_id: 201, ...req }))
            assert.deepEqual(f.store.load(f.session.id), before)
        }
    } finally {
        f.close()
    }
})
test('a later broken reward, full egg inventory or packet failure rolls back every earlier grant and removal', () => {
    const f = ranchFixture('ranch-player-rollback')
    try {
        const drops = produce(f)
        f.store.transact(f.session.id, 0, (s) => {
            s.home.ranches[201].drops[1].item.itemnum = -1
        })
        let before = f.store.load(f.session.id)
        assert.throws(() => f.call('RanchPlayerGetReward', { block_id: 201, reward_guids: drops.map((d) => d.guid) }))
        assert.deepEqual(f.store.load(f.session.id), before)
        f.store.transact(f.session.id, 0, (s) => {
            s.home.ranches[201].drops[1].item.itemnum = drops[1].item.itemnum
        })
        const egg = seedEgg(f),
            limit = Number(f.tables.get('game').find((r) => r.title === 'PET_EGG_LIMITS').value)
        f.store.transact(f.session.id, 0, (s) => {
            s.petEggs = Array.from({ length: limit }, (_, i) => ({ ...egg, guid: egg.guid + 1 + i }))
        })
        before = f.store.load(f.session.id)
        assert.throws(
            () =>
                f.call('RanchPlayerGetReward', { block_id: 201, reward_guids: [drops[0].guid], egg_guids: [egg.guid] }),
            (e) => e.code === ErrorCode.EggBagNumIsMax,
        )
        assert.deepEqual(f.store.load(f.session.id), before)
        f.store.transact(f.session.id, 0, (s) => {
            s.petEggs = []
        })
        before = f.store.load(f.session.id)
        const packet = f.game.packet
        f.game.packet = function (name, ...args) {
            if (name === 'CSProtoHomeSync') throw Error('pickup encoding failed')
            return packet.call(this, name, ...args)
        }
        assert.throws(
            () => f.call('RanchPlayerGetReward', { block_id: 201, reward_guids: drops.map((d) => d.guid) }),
            /pickup encoding failed/,
        )
        assert.deepEqual(f.store.load(f.session.id), before)
        f.game.packet = packet
        f.call('RanchPlayerGetReward', { block_id: 201, reward_guids: drops.map((d) => d.guid) })
        assert.equal(f.state().home.ranches[201].drops.length, 0)
    } finally {
        f.close()
    }
})
