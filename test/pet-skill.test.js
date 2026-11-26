import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { skillFailureRate } from '../src/handlers/pet-skill.js'
const config = configuration(),
    protocol = new Protocol(config.base),
    tables = new Tables(config.tables)
test('actual pet500002 query has asynchronous success reply and nonzero suppression uses queued failures', () => {
    let draws = 0
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { rng: () => (draws++ % 2 ? 9999 : 0) }),
        session = {}
    const call = (name, r, seq) => {
        const e = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: e.id, seq, payload: protocol.encode(e.req, r) })
            .filter((packet) => name !== 'SkillFailVec' || packet.id === 11151)
            .map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    }
    try {
        call('EnterGame', { open_id: 'fail-vec' }, 1)
        const guid = store.load(session.id).state.pets.find((pet) => pet.config_id === 500002).guid
        let result = call('SkillFailVec', { unit_id: guid }, 2)
        assert.equal(result.length, 1)
        assert.equal(result[0].id, 11151)
        assert.equal(result[0].data.success, true)
        assert.deepEqual(result[0].data.fail_vec, [])
        assert.equal(draws, 0)
        store.transact(session.id, 0, (s) => {
            const p = s.pets.find((p) => p.guid === guid)
            p.suppress_lv = 8
            p.original_type = 1
        })
        result = call('SkillFailVec', { unit_id: guid }, 3)
        assert.equal(result[0].data.success, false)
        assert.equal(result[0].data.fail_vec.length, 32)
        assert.deepEqual(result[0].data.fail_vec.slice(0, 4), [true, false, true, false])
        assert.deepEqual(call('SkillFailVec', { unit_id: guid }, 3), result)
        assert.equal(draws, 32)
        const before = store.load(session.id)
        assert.throws(() => call('SkillFailVec', { unit_id: '18446744073709551615' }, 4), /not owned/)
        assert.deepEqual(store.load(session.id), before)
        store.transact(session.id, 0, (s) => {
            const existing = s.player.attr_infos.attrs.find((row) => row.attr_id === 22)
            if (existing) existing.attr_val = '8'
            else s.player.attr_infos.attrs.push({ attr_id: 22, attr_val: '8' })
        })
        assert.equal(call('SkillFailVec', { unit_id: guid }, 5)[0].data.success, true)
    } finally {
        store.close()
    }
})
test('suppression uses capture force rather than player level and selects source rarity columns', () => {
    const state = { player: { basic_info: { lv: 99 }, attr_infos: { attrs: [{ attr_id: 22, attr_val: '1' }] } } }
    assert.equal(skillFailureRate(tables, state, { suppress_lv: 5, original_type: 1 }), 1000)
    assert.equal(skillFailureRate(tables, state, { suppress_lv: 5, original_type: 2 }), 0)
    assert.equal(skillFailureRate(tables, state, { suppress_lv: 9, original_type: 0 }), 3000)
    assert.equal(skillFailureRate(tables, state, { suppress_lv: 9, original_type: 1 }), 9000)
    assert.equal(skillFailureRate(tables, state, { suppress_lv: 0 }), 0)
})
