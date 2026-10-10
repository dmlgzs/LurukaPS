import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables, seedPlayer } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { WorldObjectCatalog } from '../src/world-objects.js'
import { grantRewards } from '../src/rewards.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
test('actual ring drop recipe resolves to acquired accessory type, ID and matching instance GUID', () => {
    const state = seedPlayer(tables, 1, 'ring-drop')
    const recipe = new WorldObjectCatalog(tables).drops(61000, (n) => (n === 1500 ? 400 : 0))
    assert.equal(recipe[0].itemid, 50005)
    assert.equal(recipe[0].itemtype, 33)
    const result = grantRewards(tables, state, recipe)
    assert.equal(result[0].itemtype, 15)
    assert.equal(result[0].itemid, 1050111)
    const ornament = state.ornaments.find((o) => String(o.guid) === result[0].guid)
    assert.equal(ornament.id, result[0].itemid)
    assert.equal(ornament.grade, tables.find('accessory_customed', 50005).grade)
    assert.ok([1, 2, 3, 4].includes(ornament.quality))
    assert.deepEqual(
        protocol
            .decode('cs.Rewards', protocol.encode('cs.Rewards', { rewards: result }))
            .rewards.map(({ itemtype, itemid, itemnum, guid }) => ({ itemtype, itemid, itemnum, guid })),
        result,
    )
    assert.equal(tables.find('accessory', ornament.id).setId, 0, 'do not fabricate a set bonus')
})
test('central grant publishes the acquired equipment cache before its request callback', () => {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables),
        session = {}
    let seq = 1
    const call = (name, r) => {
        const e = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, r) })
            .map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    }
    try {
        call('EnterGame', { open_id: 'ring-cache' })
        const text = (s) => Buffer.from(s).toString('base64')
        const packets = call('GMCommand', { command: text('give'), args: ['33', '50005', '1'].map(text) })
        const update = packets.find((p) => protocol.byId.get(p.id).name === 'CSProtoUpdateOrnament')
        const reply = packets.find((p) => protocol.byId.get(p.id).name === 'CSProtoGMCommand')
        assert.ok(packets.indexOf(update) < packets.indexOf(reply))
        assert.equal(update.data.ornaments[0].id, 1050111)
        const state = store.load(session.id).state
        assert.equal(state.ornaments.length, 1)
        assert.equal(String(update.data.ornaments[0].guid), String(state.ornaments[0].guid))
    } finally {
        store.close()
    }
})
