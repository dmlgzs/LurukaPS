import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Tables, seedPlayer } from '../src/player.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { repairSoulEssenceStars, soulEssenceGrade } from '../src/equipment.js'
import { heroModules } from '../src/battle.js'
import { grantRewards } from '../src/rewards.js'
const config = configuration(),
    protocol = new Protocol(config.base),
    tables = new Tables(config.tables)
test('all seeded and awarded soul essences have a valid nonnegative client star-list size', () => {
    assert.equal(
        tables.get('soulessence').length,
        77,
        'current acquisition matrix must exercise the full target catalogue',
    )
    const state = seedPlayer(tables, 1, 'star-test')
    assert.equal(state.player.soulessence_infos.soulessences.length, 0, 'normal does not gift the catalogue')
    grantRewards(
        tables,
        state,
        tables.get('soulessence').map((row) => ({ itemtype: 9, itemid: row.id, itemnum: 1 })),
    )
    assert.equal(state.player.soulessence_infos.soulessences.length, tables.get('soulessence').length)
    for (const item of state.player.soulessence_infos.soulessences) {
        assert.equal(item.advance, 1)
        assert.equal(item.advance - 1, 0)
    }
    const awarded = grantRewards(tables, state, [{ itemtype: 9, itemid: 10255, itemnum: 2 }])
    for (const r of awarded)
        assert.equal(state.player.soulessence_infos.soulessences.find((i) => String(i.guid) === r.guid).advance, 1)
})
test('zero-star legacy state repairs without changing existing upgrades or equipment ownership', () => {
    const state = seedPlayer(tables, 1, 'migration')
    grantRewards(tables, state, [{ itemtype: 9, itemid: 10001, itemnum: 3 }])
    const items = state.player.soulessence_infos.soulessences
    items[0].advance = 0
    delete items[1].advance
    items[2].advance = 4
    items[2].lv = 20
    items[2].exp = 123
    items[2].wear_hero = state.player.heros_info.heros[0].guid
    const upgraded = structuredClone(items[2])
    repairSoulEssenceStars(state)
    assert.equal(items[0].advance, 1)
    assert.equal(items[1].advance, 1)
    assert.deepEqual(items[2], upgraded)
    const before = structuredClone(state)
    repairSoulEssenceStars(state)
    assert.deepEqual(state, before)
    assert.equal(soulEssenceGrade(items[2]), 3)
})
test('one-based wire stars map to zero-based skill grades without a free skill upgrade', () => {
    const state = seedPlayer(tables, 1, 'skills')
    grantRewards(tables, state, [{ itemtype: 9, itemid: 10001, itemnum: 1 }])
    const hero = state.player.heros_info.heros[0],
        item = state.player.soulessence_infos.soulessences.find((i) => i.id === 10001)
    hero.wguid = item.guid
    item.wear_hero = hero.guid
    const level = () =>
        heroModules(tables, state, hero)
            .modules.flatMap((m) => m.sub_modules)
            .flatMap((m) => m.skills?.skills ?? [])
            .find((s) => s.skill_id === 1900480)?.skill_lv
    assert.equal(level(), 1)
    item.advance = 5
    assert.equal(level(), 5)
})
test('login and giveall repair and synchronize legacy zero-star inventory before results', () => {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables),
        session = {}
    const call = (who, name, r) => {
        const e = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(who, { id: e.id, seq: 1, payload: protocol.encode(e.req, r) })
            .map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    }
    try {
        call(session, 'EnterGame', { open_id: 'legacy-stars' })
        call(session, 'GMCommand', { command: Buffer.from('give 9 10001 1').toString('base64') })
        store.transact(session.id, 0, (s) => {
            for (const item of s.player.soulessence_infos.soulessences) item.advance = 0
        })
        const result = call(session, 'GMCommand', { command: Buffer.from('giveall').toString('base64') })
        const sync = result.find((p) => p.data.soulessence_infos)
        assert(sync)
        assert(sync.data.soulessence_infos.soulessences.every((i) => i.advance === 1))
        assert(result.indexOf(sync) < result.findIndex((p) => p.id === 19903))
        assert.equal(result.filter((p) => p.data.soulessence_infos).length, 1)
        store.transact(session.id, 0, (s) => {
            s.player.soulessence_infos.soulessences[0].advance = 0
        })
        const login = call({}, 'EnterGame', { open_id: 'legacy-stars' }).find((p) => p.id === 5001)
        assert(login.data.data.soulessence_infos.soulessences.every((i) => i.advance >= 1))
        assert(store.load(session.id).state.player.soulessence_infos.soulessences.every((i) => i.advance >= 1))
    } finally {
        store.close()
    }
})
