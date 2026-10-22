import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { grantRewards } from '../src/rewards.js'
import { gridAnchor } from '../src/home-grid.js'
import { eggSpeciesPools, selectBaseHatchSpecies } from '../src/egg-pools.js'
const c = configuration(),
    t = new Tables(c.tables),
    p = new Protocol(c.base)
function setup(file = ':memory:') {
    let now = 1800000000,
        draws = 0
    const store = new Store(file),
        game = new Game(p, store, t, {
            clock: () => now,
            rng: () => {
                draws++
                return 0
            },
        }),
        session = {}
    let seq = 1
    const call = (name, r, s = session) => {
        const e = p.byName.get('CSProto' + name)
        return game.dispatch(s, { id: e.id, seq: seq++, pushSeq: 0, payload: p.encode(e.req, r) })
    }
    call('EnterGame', { open_id: 'hatch' })
    store.transact(session.id, 0, (s) => {
        s.player.basic_info.lv = 15
        grantRewards(t, s, [
            { itemtype: 13, itemid: 30231, itemnum: 1 },
            { itemtype: 14, itemid: 40003007, itemnum: 2 },
        ])
    })
    call('BuildLocate', { build_id: 30231, locate: { block_id: 101, anchor: gridAnchor(-50, -25), direction: 0 } })
    const hatchGuid = store
        .load(session.id)
        .state.home.builds.find((b) => b.build_type === 12 && b.build_id === 30231)?.guid
    assert(hatchGuid, 'Placed hatch building must exist')
    return {
        hatchGuid,
        store,
        game,
        session,
        call,
        advance: (n) => {
            now += n
        },
        draws: () => draws,
    }
}
test('native egg buckets map combined normal rarities to the correct pools', () => {
    const result = eggSpeciesPools(t, 40003007)
    assert.deepEqual(
        result.groups.map((g) => [g.name, g.weight, g.id]),
        [
            ['SR', 1600, 4001],
            ['R4_R5', 8400, 3023],
        ],
    )
    assert.equal(
        selectBaseHatchSpecies(t, 40003007, () => 0),
        500609,
    )
    let n = 0
    assert.equal(
        selectBaseHatchSpecies(t, 40003007, () => (n++ ? 0 : 1600)),
        500083,
    )
    assert.equal(
        selectBaseHatchSpecies(t, 20004001, () => 0),
        500023,
    )
    const bad = {
        get: t.get.bind(t),
        find: (name, id) => (name === 'pet' && id === 500609 ? undefined : t.find(name, id)),
    }
    assert.throws(() => eggSpeciesPools(bad, 40003007), /Missing hatch pet/)
})
test('legacy hatch start and modern ProductFinish produce a unique pet after the configured duration', () => {
    const { store, game, session, call, advance, hatchGuid } = setup()
    try {
        const initialCount = store.load(session.id).state.pets.length
        call('HatchPetEgg', { build_guid: hatchGuid, egg_guid: 1 })
        let state = store.load(session.id).state
        const job = state.home.productionJobs[hatchGuid][0]
        assert.equal(state.petEggs[0].hatch_state, 2)
        assert.equal(state.home.builds.find((b) => b.guid === hatchGuid).specials[0].extra_guid, 1)
        const before = store.load(session.id)
        assert.throws(() => call('HatOutPetEgg', { build_guid: hatchGuid, egg_guid: 1 }), /not finished/)
        assert.deepEqual(store.load(session.id), before)
        advance(18000)
        assert(game.tick(session.id).some((packet) => packet.id === 6518))
        const packets = call('ProductFinish', { guid: hatchGuid, product_guids: [job.guid] })
        const reward = p.decode('SCProductFinish', packets.find((x) => x.id === 6111).payload).reward.rewards[0]
        assert.equal(reward.itemid, 500609)
        assert.equal(reward.itemtype, 5)
        assert(BigInt(reward.guid) > BigInt(Number.MAX_SAFE_INTEGER))
        assert(packets.findIndex((x) => x.id === 6517) < packets.findIndex((x) => x.id === 6111))
        assert.deepEqual(p.decode('SCPetEggInfoSync', packets.find((x) => x.id === 6518).payload).egg_infos.guid, [1])
        state = store.load(session.id).state
        assert.equal(state.pets.length, initialCount + 1)
        assert.equal(state.petEggs.length, 1)
        assert(state.pets.some((p) => p.guid === reward.guid))
        assert.throws(() => call('ProductFinish', { guid: hatchGuid, product_guids: [job.guid] }))
    } finally {
        store.close()
    }
})
test('queued eggs use zero start time and cancellation retains its preselected outcome', () => {
    const { store, session, call, draws, hatchGuid } = setup()
    try {
        call('HatchPetEgg', { build_guid: hatchGuid, egg_guid: 1 })
        call('HatchPetEgg', { build_guid: hatchGuid, egg_guid: 2 })
        let s = store.load(session.id).state
        assert.equal(s.home.builds.find((b) => b.guid === hatchGuid).hatch.hatch_infos[1].start_time, 0)
        assert.equal(s.petEggs[1].hatch_state, 1)
        const rolls = draws(),
            outcome = s.eggOutcomes[1]
        call('CancelHatchPetEgg', { build_guid: hatchGuid, egg_guid: 1 })
        s = store.load(session.id).state
        assert.equal(s.petEggs[0].hatch_state, 0)
        assert.equal(s.petEggs[1].hatch_state, 2)
        call('HatchPetEgg', { build_guid: hatchGuid, egg_guid: 1 })
        assert.equal(draws(), rolls)
        assert.equal(store.load(session.id).state.eggOutcomes[1], outcome)
    } finally {
        store.close()
    }
})
test('locked/affixed eggs and full pet storage cannot lose eggs or produce duplicate rewards', () => {
    const { store, session, call, advance, hatchGuid } = setup()
    try {
        call('PetEggLock', { guid: '1', lock_operate: true })
        let before = store.load(session.id)
        assert.throws(() => call('HatchPetEgg', { build_guid: hatchGuid, egg_guid: 1 }), /locked/)
        assert.deepEqual(store.load(session.id), before)
        call('PetEggLock', { guid: '1', lock_operate: false })
        store.transact(session.id, 0, (s) => {
            s.petEggs[0].egg_affix = [1]
        })
        before = store.load(session.id)
        assert.throws(() => call('HatchPetEgg', { build_guid: hatchGuid, egg_guid: 1 }), /Affix/)
        assert.deepEqual(store.load(session.id), before)
        store.transact(session.id, 0, (s) => {
            s.petEggs[0].egg_affix = []
        })
        call('HatchPetEgg', { build_guid: hatchGuid, egg_guid: 1 })
        advance(18000)
        store.transact(session.id, 0, (s) => {
            while (s.pets.length < 600) s.pets.push({ ...s.pets[0], guid: String(900000 + s.pets.length), box_id: 0 })
        })
        before = store.load(session.id)
        assert.throws(() => call('HatOutPetEgg', { build_guid: hatchGuid, egg_guid: 1 }), /full/)
        assert.deepEqual(store.load(session.id), before)
    } finally {
        store.close()
    }
})
test('direct pet rewards allocate distinct 64-bit identities and roll back invalid later grants', () => {
    const { store, session } = setup()
    try {
        const start = store.load(session.id).state.pets.length
        const awarded = store.transact(session.id, 0, (s) =>
            grantRewards(t, s, [{ itemtype: 5, itemid: 500609, itemnum: 2 }]),
        )
        assert.equal(awarded.length, 2)
        assert.notEqual(awarded[0].guid, awarded[1].guid)
        assert.equal(store.load(session.id).state.pets.length, start + 2)
        assert.equal((BigInt(awarded[0].guid) >> 32n) & 0xffffffn, 500609n)
        const before = store.load(session.id)
        assert.throws(() =>
            store.transact(session.id, 0, (s) =>
                grantRewards(t, s, [
                    { itemtype: 5, itemid: 500609, itemnum: 1 },
                    { itemtype: 999, itemid: 1, itemnum: 1 },
                ]),
            ),
        )
        assert.deepEqual(store.load(session.id), before)
    } finally {
        store.close()
    }
})

test('hatch queues retain their result and progress across a database restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-hatch-')),
        file = path.join(dir, 'state.sqlite')
    let f = setup(file),
        store = f.store
    try {
        const hatchGuid = f.hatchGuid
        f.call('HatchPetEgg', { build_guid: hatchGuid, egg_guid: 1 })
        const id = f.session.id
        store.close()
        store = new Store(file)
        const game = new Game(p, store, t, {
                clock: () => 1800018001,
                rng: () => {
                    throw Error('Must not reroll after restart')
                },
            }),
            session = {}
        const entry = p.byName.get('CSProtoEnterGame')
        const login = game.dispatch(session, {
            id: entry.id,
            seq: 1,
            pushSeq: 0,
            payload: p.encode(entry.req, { open_id: 'hatch' }),
        })
        assert.equal(session.id, id)
        const eggs = p.decode('SCPetEggInfoSync', login.find((x) => x.id === 6518).payload).egg_infos.eggs
        assert.equal(eggs.find((e) => e.guid === 1).hatch_state, 3)
        const claim = p.byName.get('CSProtoHatOutPetEgg')
        const packets = game.dispatch(session, {
            id: claim.id,
            seq: 2,
            pushSeq: 0,
            payload: p.encode(claim.req, { build_guid: hatchGuid, egg_guid: 1 }),
        })
        const guid = p.decode('SCHatchFinish', packets.find((x) => x.id === 6507).payload).pet_guid
        assert.equal(store.load(id).state.pets.find((x) => x.guid === guid).config_id, 500609)
    } finally {
        store.close()
        assert.equal(path.dirname(dir), os.tmpdir())
        assert(path.basename(dir).startsWith('lurukaps-hatch-'))
        fs.rmSync(dir, { recursive: true })
    }
})
