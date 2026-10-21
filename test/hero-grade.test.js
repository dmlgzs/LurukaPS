import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables, seedPlayer } from '../src/player.js'
import { nextHeroGrade, heroGradeEffects, heroGradeRows } from '../src/hero-grade.js'
import { heroModules } from '../src/battle.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables)

test('all 23 usable heroes have six current grade costs and rewards; fresh heroes start at grade zero', () => {
    const s = seedPlayer(tables, 1, 'hero-grade')
    assert.equal(s.player.heros_info.heros.length, 23)
    for (const hero of s.player.heros_info.heros) {
        assert.equal(hero.hero_grade, 0)
        for (let grade = 0; grade < 6; grade++) {
            hero.hero_grade = grade
            const next = nextHeroGrade(tables, hero)
            assert.equal(next.grade, grade + 1)
            assert.equal([...next.costs.values()][0], 1)
            assert.equal(heroGradeRows(hero.conf_id).length, 7)
        }
        hero.hero_grade = 6
        assert.throws(
            () => nextHeroGrade(tables, hero),
            (e) => e.code === ErrorCode.HeroGradeMax,
        )
    }
})
test('grade module 10 uses current attributes and never mistakes effect keys for skill IDs', () => {
    const s = seedPlayer(tables, 1, 'hero-grade'),
        hero = s.player.heros_info.heros.find((h) => h.conf_id === 107002)
    hero.hero_grade = 5
    const effect = heroGradeEffects(hero)
    // Independently re-extracted 2451868: tier3 5#800|23#1200|105#500,
    // tier5 3#60|5#800|23#1200. The old export used different bonuses.
    assert.deepEqual(
        [...effect.attrs],
        [
            [5, 1600],
            [23, 2400],
            [105, 500],
            [3, 60],
        ],
    )
    assert.deepEqual(effect.skills, [])
    assert.deepEqual(effect.elements, [])
    const grade = heroModules(tables, s, hero).modules.find((m) => m.module_type === 10).sub_modules[0]
    assert.equal(grade.attrs.attrs.find((a) => a.attr_id === 5).attr_val, '16000000')
    assert.equal(grade.attrs.attrs.find((a) => a.attr_id === 23).attr_val, '2400')
    assert.equal(grade.skills.skills.length, 0)
    hero.hero_grade = 0
    assert.equal(heroGradeEffects(hero).skills.length, 0)
    assert.equal(heroGradeEffects(hero).attrs.size, 0)
})
test('6055 spends the next grade cost, synchronizes battle/ownership before ACK, rewards tier6 and rolls back failures', () => {
    const protocol = new Protocol(cfg.base),
        store = new Store(':memory:'),
        game = new Game(protocol, store, tables),
        session = {}
    let seq = 1
    const call = (name, data = {}, who = session) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(who, { id: e.id, seq: seq++, payload: protocol.encode(e.req, data) })
    }
    const state = () => store.load(session.id).state
    let guid
    const hero = () => state().player.heros_info.heros.find((h) => h.guid === guid)
    const claim = () => call('GradeUpHero', { u64: guid })
    try {
        call('EnterGame', { open_id: 'hero-grade' })
        guid = state().player.heros_info.heros.find((h) => h.conf_id === 107002).guid
        const initial = structuredClone(state())
        assert.throws(claim, (e) => e.code === ErrorCode.ItemNotEnough)
        assert.deepEqual(state(), initial)
        assert.throws(
            () => call('GradeUpHero', { u64: '999' }),
            (e) => e.code === ErrorCode.HeroNotExist,
        )
        store.transact(session.id, 0, (s) => {
            s.player.heros_info.heros.find((h) => h.guid === guid).trail = true
        })
        assert.throws(claim, (e) => e.code === ErrorCode.HeroNotExist)
        store.transact(session.id, 0, (s) => {
            delete s.player.heros_info.heros.find((h) => h.guid === guid).trail
            s.player.sbag_infos.items.push({ guid: '999999', itemid: 1100015, itemtype: 3, itemnum: 6 })
        })
        for (let grade = 1; grade <= 6; grade++) {
            const row = heroGradeRows(107002).find((row) => row.grade === grade),
                reward = row.reward
            const before = structuredClone(state())
            try {
                row.reward = '3#4294967295#1'
                assert.throws(claim, (e) => e.code === ErrorCode.GameConfig)
                assert.deepEqual(state(), before)
            } finally {
                row.reward = reward
            }
            const packets = claim(),
                ack = packets.findIndex((p) => p.id === 6055)
            const updates = packets
                .slice(0, ack)
                .filter((p) => p.id === protocol.byName.get('CSProtoSyncPlayerData').id)
            assert(
                updates.some((p) =>
                    protocol
                        .decode(protocol.byId.get(p.id).rsp, p.payload)
                        .heros_info?.heros.some((h) => h.guid === guid && h.hero_grade === grade),
                ),
            )
            const battle = packets.slice(0, ack).find((p) => p.id === protocol.byName.get('CSProtoHeroAttrInfoSync').id)
            // Shared delta synchronization can omit unchanged modules at
            // tiers with no numerical attribute change.
            if ([3, 5].includes(grade)) assert(battle)
            const result = protocol.decode(protocol.byId.get(6055).rsp, packets[ack].payload)
            assert.equal(hero().hero_grade, grade)
            assert.equal(result.src, 128)
            if (grade === 6) {
                assert(packets.slice(0, ack).some((p) => p.id === 5104))
                assert(state().playerCardItems.some((item) => item.config === 10143))
            }
            assert.deepEqual(
                result.rewards.map(({ itemtype, itemid, itemnum }) => ({ itemtype, itemid, itemnum })),
                grade === 6 ? [{ itemtype: 26, itemid: 10143, itemnum: 1 }] : [],
            )
        }
        assert.equal(state().player.sbag_infos.items.find((i) => i.itemid === 1100015).itemnum, 0)
        assert.equal(hero().hero_star, 0)
        assert.throws(claim, (e) => e.code === ErrorCode.HeroGradeMax)
        call('EnterGame', { open_id: 'hero-grade' }, {})
        assert.equal(hero().hero_grade, 6)
        assert.throws(claim, (e) => e.code === ErrorCode.HeroGradeMax)
    } finally {
        store.close()
    }
})
test('grade and cost corruption use named configuration failures', () => {
    const hero = seedPlayer(tables, 1, 'grade-invalid').player.heros_info.heros.find((h) => h.conf_id === 107002)
    hero.hero_grade = -1
    assert.throws(
        () => nextHeroGrade(tables, hero),
        (e) => e.code === ErrorCode.GameConfig,
    )
    hero.hero_grade = 0
    const row = tables.find('hero', hero.conf_id),
        original = row.gradeUpItem
    try {
        row.gradeUpItem = '1100015#0'
        assert.throws(
            () => nextHeroGrade(tables, hero),
            (e) => e.code === ErrorCode.HeroGradeConfigInvalid,
        )
    } finally {
        row.gradeUpItem = original
    }
})

test('grade effect replacement retains the replaced skill level and distinguishes elements from skills', () => {
    const s = seedPlayer(tables, 1, 'hero-grade-switch'),
        hero = s.player.heros_info.heros.find((h) => h.conf_id === 101003)
    hero.hero_grade = 2
    hero.system_skill_levels[1] = 9
    const effect = heroGradeEffects(hero)
    assert.deepEqual(effect.elements, [101003214])
    assert.equal(effect.switches.get(10100312), 10100343)
    const skills = heroModules(tables, s, hero).modules[0].sub_modules[0].skills.skills
    assert.equal(skills.find((s) => s.skill_id === 10100343).skill_lv, 9)
    assert(!skills.some((s) => s.skill_id === 101003214))
})
