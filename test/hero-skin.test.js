import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
test('skin data and skinned ultimate levels precede the recreate callback; switching back clears the skin slot', () => {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables),
        session = {}
    let seq = 1
    const call = (name, request) => {
        const e = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, request) })
            .map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    }
    try {
        call('EnterGame', { open_id: 'skin-test' })
        const state = store.load(session.id).state,
            hero = state.player.heros_info.heros.find((h) => h.conf_id === 101010)
        hero.system_skill_levels[2] = 7
        const manager = state.player.group_mgrs.find((m) => m.type === 1),
            group = manager.groups.find((g) => g.id === manager.cur_group)
        group.heros[0].hero_id = hero.guid
        group.control = hero.guid
        store.transact(session.id, 0, (saved) => Object.assign(saved, state))
        const before = structuredClone(state)
        const packets = call('HeroUpdateSkin', { hero_guid: hero.guid, skin_id: 1010101 })
        const ack = packets.findIndex((p) => p.id === 11903),
            data = packets.findIndex((p) => p.id === 9001 || protocol.byId.get(p.id).name === 'CSProtoSyncPlayerData'),
            attrs = packets.findIndex((p) => p.id === 10006)
        assert.ok(data >= 0 && data < ack)
        assert.ok(attrs >= 0 && attrs < ack)
        const info = packets[attrs].data.heros.find((h) => h.hero_guid === hero.guid)
        const skills = info.modules[0].sub_modules[0].skills.skills
        assert.deepEqual(
            skills.find((s) => s.skill_slot === 4),
            { skill_id: 1010100113, skill_lv: 7, skill_slot: 4, type: 0 },
        )
        assert.ok(skills.some((s) => s.skill_id === 10101013 && s.skill_lv === 7))
        const after = store.load(session.id).state
        assert.deepEqual(after.world, before.world)
        assert.deepEqual(after.player.group_mgrs, before.player.group_mgrs)
        const limits = after.player.heros_info.battle_infos.find((h) => h.hero_id === hero.guid)
        limits.sp = 100
        store.transact(session.id, 0, (saved) => Object.assign(saved, after))
        call('SkillStart', { unit_id: hero.guid, skill: { skill_id: 1010100113 } })
        assert.equal(
            store.load(session.id).state.player.heros_info.battle_infos.find((h) => h.hero_id === hero.guid).sp,
            0,
        )
        const reset = call('HeroUpdateSkin', { hero_guid: hero.guid, skin_id: 0 })
        const resetSkills = reset.find((p) => p.id === 10006).data.heros.find((h) => h.hero_guid === hero.guid)
            .modules[0].sub_modules[0].skills.skills
        assert.equal(resetSkills.find((s) => s.skill_slot === 4).skill_id, 10101013)
        assert.ok(!resetSkills.some((s) => s.skill_id === 1010100113))
    } finally {
        store.close()
    }
})
