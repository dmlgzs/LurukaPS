import { giveCurrentHero } from './hero-growth-current-fixture.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { aggregateCosts, spend } from '../src/inventory.js'
import { advanceLevel, maximumLevel } from '../src/handlers/progression.js'
const c = configuration(),
    protocol = new Protocol(c.base),
    tables = new Tables(c.tables)
function setup() {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables),
        session = {}
    let seq = 1
    const call = (name, r) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: e.id, seq: seq++, pushSeq: 0, payload: protocol.encode(e.req, r) })
    }
    call('EnterGame', { open_id: 'level' })
    // Explicit current resources; normal provides no default pet/materials.
    for (const command of ['gold 100', 'item 400000 3', 'item 402000 2', 'give 5 500001 1'])
        call('GMCommand', { command: Buffer.from(command).toString('base64') })
    return { store, game, session, call }
}
test('hero and pet upgrades consume their own materials and refresh attributes', () => {
    const { store, session, call } = setup()
    try {
        let s = store.load(session.id).state
        const hero = s.player.heros_info.heros[0],
            pet = s.pets[0]
        const packets = call('LvUpHero', { hero_id: hero.guid, items: [{ item_id: 400000, item_num: 1 }] })
        s = store.load(session.id).state
        assert.equal(s.player.heros_info.heros[0].hero_lv, 6)
        assert.equal(s.player.heros_info.heros[0].hero_exp, 0)
        assert.equal(s.player.basic_info.gold, 80)
        assert.equal(s.player.sbag_infos.items[0].itemnum, 2)
        assert(packets.some((p) => p.id === 10006))
        call('LvUpPet', { pet_id: pet.guid, items: [{ item_id: 402000, item_num: 1 }] })
        s = store.load(session.id).state
        assert.equal(s.pets[0].lv, 6)
        assert.equal(s.player.basic_info.gold, 80)
        assert.equal(s.player.sbag_infos.items[1].itemnum, 1)
    } finally {
        store.close()
    }
})
test('invalid costs, duplicate rows, insufficient gold and downstream failure roll back', () => {
    const { store, game, session, call } = setup()
    try {
        const h = store.load(session.id).state.player.heros_info.heros[0]
        let before = store.load(session.id)
        for (const items of [
            [],
            [{ item_id: 400000, item_num: 0 }],
            [
                { item_id: 400000, item_num: 2 },
                { item_id: 400000, item_num: 2 },
            ],
            [{ item_id: 402000, item_num: 1 }],
        ]) {
            assert.throws(() => call('LvUpHero', { hero_id: h.guid, items }))
            assert.deepEqual(store.load(session.id), before)
        }
        store.transact(session.id, 0, (s) => {
            s.player.basic_info.gold = 0
        })
        before = store.load(session.id)
        assert.throws(() => call('LvUpHero', { hero_id: h.guid, items: [{ item_id: 400000, item_num: 1 }] }), /gold/)
        assert.deepEqual(store.load(session.id), before)
        store.transact(session.id, 0, (s) => {
            s.player.basic_info.gold = 100
        })
        before = store.load(session.id)
        game.tables = {
            dir: tables.dir,
            get: tables.get.bind(tables),
            find: (name, id) => (name === 'template_hero' && id === 6 ? undefined : tables.find(name, id)),
        }
        assert.throws(
            () => call('LvUpHero', { hero_id: h.guid, items: [{ item_id: 400000, item_num: 1 }] }),
            /Missing template_hero/,
        )
        assert.deepEqual(store.load(session.id), before)
    } finally {
        store.close()
    }
})
test('expiry-aware spending aggregates costs before making any changes', () => {
    const state = {
        player: {
            basic_info: { gold: 10 },
            sbag_infos: {
                items: [
                    { itemid: 1, itemnum: 9, deadtime: 99 },
                    { itemid: 1, itemnum: 2, deadtime: 200 },
                    { itemid: 1, itemnum: 4 },
                ],
            },
        },
    }
    const before = structuredClone(state)
    assert.throws(() => spend(state, aggregateCosts([{ item_id: 1, item_num: 7 }]), 0, 100))
    assert.deepEqual(state, before)
    spend(
        state,
        aggregateCosts([
            { item_id: 1, item_num: 1 },
            { item_id: 1, item_num: 2 },
        ]),
        2,
        100,
    )
    assert.deepEqual(
        state.player.sbag_infos.items.map((x) => x.itemnum),
        [9, 0, 3],
    )
    assert.equal(state.player.basic_info.gold, 8)
})
test('level caps follow player-level conditions and experience is conserved', () => {
    const rows = tables.get('hero_level'),
        cap = maximumLevel(rows, 1)
    assert(cap < maximumLevel(rows, 30))
    assert.throws(() => advanceLevel(rows, cap, 0, 100, cap), /cap/)
    const result = advanceLevel(rows, 1, 0, 100, cap)
    assert.deepEqual(result, { level: 6, exp: 0 })
    const small = [
        { lv: 1, exp: 10 },
        { lv: 2, exp: 15 },
    ]
    assert.deepEqual(advanceLevel(small, 1, 0, 100, 2), { level: 2, exp: 90 })
})
