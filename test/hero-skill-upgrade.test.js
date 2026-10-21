import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { heroSkillUpgrade } from '../src/hero-skill-upgrades.js'
import { ErrorCode } from '../src/error-codes.js'
import { grantRewards } from '../src/rewards.js'

test('6007 upgrades the zero-based system slot using current-row cost and updates base plus skinned battle skills before ACK', () => {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base),
        store = new Store(':memory:')
    const game = new Game(protocol, store, tables),
        session = {}
    let seq = 1
    const call = (name, data = {}, who = session) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(who, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, data) })
    }
    const state = () => store.load(session.id).state
    let guid
    const hero = () => state().player.heros_info.heros.find((row) => row.guid === guid)
    try {
        call('EnterGame', { open_id: 'hero-skill-upgrade' })
        guid = state().player.heros_info.heros.find((row) => row.conf_id === 101010).guid
        call('HeroUpdateSkin', { hero_guid: guid, skin_id: 1010101 })
        store.transact(session.id, 0, (state) =>
            grantRewards(tables, state, [{ itemtype: 10, itemid: 2, itemnum: 20000 }]),
        )
        const gold = state().player.basic_info.gold
        const packets = call('LvUpSkill', { hero_id: guid, skill_id: 2 })
        assert.equal(packets.at(-1).id, 6007)
        assert.equal(hero().system_skill_levels[2], 2)
        assert.equal(hero().system_skill_levels[0], 1)
        assert.equal(state().player.basic_info.gold, gold - 2000)
        const battle = packets.slice(0, -1).find((packet) => packet.id === 10006)
        assert.ok(battle)
        const modules = protocol
            .decode(protocol.byId.get(10006).rsp, battle.payload)
            .heros.find((row) => row.hero_guid === guid).modules
        const skills = modules.find((row) => row.module_type === 0).sub_modules[0].skills.skills
        assert.equal(skills.find((row) => row.skill_id === 1010100113).skill_lv, 2)
        assert.equal(skills.find((row) => row.skill_id === 10101013).skill_lv, 2)
        call('LvUpSkill', { hero_id: guid, skill_id: 0 })
        assert.equal(hero().system_skill_levels[0], 2)
        call('EnterGame', { open_id: 'hero-skill-upgrade' }, {})
        assert.equal(hero().system_skill_levels[2], 2)
        const before = structuredClone(state())
        assert.throws(
            () => call('LvUpSkill', { hero_id: guid, skill_id: 10101013 }),
            (error) => error.code === ErrorCode.HeroSkillUpCheckFailed,
        )
        assert.throws(
            () => call('LvUpSkill', { hero_id: '99999999', skill_id: 0 }),
            (error) => error.code === ErrorCode.HeroNotExist,
        )
        assert.deepEqual(state(), before)
        store.transact(session.id, 0, (s) => {
            s.player.basic_info.gold = 0
        })
        const poor = structuredClone(state())
        assert.throws(
            () => call('LvUpSkill', { hero_id: guid, skill_id: 2 }),
            (error) => error.code === ErrorCode.ItemNotEnough,
        )
        assert.deepEqual(state(), poor)
        store.transact(session.id, 0, (s) => {
            s.player.heros_info.heros.find((row) => row.guid === guid).system_skill_levels[2] = 12
        })
        assert.throws(
            () => call('LvUpSkill', { hero_id: guid, skill_id: 2 }),
            (error) => error.code === ErrorCode.HeroSkillUpCheckFailed,
        )
    } finally {
        store.close()
    }
})

test('hero skill upgrade uses next-row unlock gates and rejects duplicate or missing level configuration', () => {
    const tables = new Tables(configuration().tables)
    const current = tables.get('skill_level').find((row) => row.skillId === 10800101 && row.level === 1)
    const next = tables.get('skill_level').find((row) => row.skillId === 10800101 && row.level === 2)
    const oldLevel = next.heroLevel,
        oldRank = next.heroRank
    const hero = { conf_id: 108001, hero_lv: 1, hero_rank: 1, system_skill_levels: [1, 1, 1, 1, 1, 1] }
    try {
        next.heroLevel = 20
        assert.throws(
            () => heroSkillUpgrade(tables, hero, 0),
            (error) => error.code === ErrorCode.HeroSkillUpCheckFailed,
        )
        next.heroLevel = 0
        next.heroRank = 3
        assert.throws(
            () => heroSkillUpgrade(tables, hero, 0),
            (error) => error.code === ErrorCode.HeroSkillUpCheckFailed,
        )
        hero.hero_lv = 20
        hero.hero_rank = 3
        assert.equal(heroSkillUpgrade(tables, hero, 0).gold, current.gold)
    } finally {
        next.heroLevel = oldLevel
        next.heroRank = oldRank
    }
    const broken = new Tables(configuration().tables),
        get = broken.get.bind(broken)
    broken.get = (name) => (name === 'skill_level' ? [current, current] : get(name))
    assert.throws(
        () => heroSkillUpgrade(broken, hero, 0),
        (error) => error.code === ErrorCode.GameConfig,
    )
    const missing = new Tables(configuration().tables),
        originalGet = missing.get.bind(missing)
    missing.get = (name) =>
        name === 'skill_level'
            ? originalGet(name).filter((row) => row.skillId !== 10800101 || row.level !== 2)
            : originalGet(name)
    assert.throws(
        () => heroSkillUpgrade(missing, hero, 0),
        (error) => error.code === ErrorCode.GameConfig,
    )
})
