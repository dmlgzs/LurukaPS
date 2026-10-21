import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Tables, seedPlayer } from '../src/player.js'
import { heroModules, heroBattleLimits, refreshBattleState, pairs } from '../src/battle.js'
const c = configuration(),
    t = new Tables(c.tables),
    protocol = new Protocol(c.base)
test('CBT3 hero 101003 level-one attributes use extracted base and factors', () => {
    const s = seedPlayer(t, 1, 'battle'),
        h = s.player.heros_info.heros.find((h) => h.conf_id === 101003),
        module = heroModules(t, s, h)
    const attrs = new Map(module.modules[0].sub_modules[0].attrs.attrs.map((a) => [a.attr_id, a.attr_val]))
    // Independently read constants in template_value rows 1001001 / 101003.
    assert.equal(attrs.get(1), '437350')
    assert.equal(attrs.get(5), '1968836')
    assert.equal(attrs.get(6), '100')
    assert.deepEqual(heroBattleLimits(module), { hp: 196, sp: 100 })
    refreshBattleState(t, s)
    assert.equal(s.player.heros_info.battle_infos.find((x) => x.hero_id === h.guid).hp, 196)
    const result = protocol.decode('SCHeroAttrInfoSync', protocol.encode('SCHeroAttrInfoSync', { heros: [module] }))
    assert.equal(result.heros[0].hero_guid, h.guid)
    assert(
        result.heros[0].modules[0].sub_modules[0].skills.skills.some(
            (x) => x.skill_slot === 1 && x.skill_id === 10100301,
        ),
    )
    assert.equal((BigInt(h.guid) >> 32n) & 0xffffffn, 101003n)
})
test('legacy fixed-point battle HP migrates once while dead and already-valid HP remain intact', () => {
    const s = seedPlayer(t, 21, 'legacy-hp'),
        ids = s.player.heros_info.heros.map((h) => h.guid)
    s.player.heros_info.battle_infos = [
        { hero_id: ids[0], hp: 1434738, sp: 20 },
        { hero_id: ids[1], hp: 0, sp: 0 },
        { hero_id: ids[2], hp: 80, sp: 10 },
    ]
    refreshBattleState(t, s)
    assert.deepEqual(
        s.player.heros_info.battle_infos.slice(0, 3).map((x) => x.hp),
        [143, 0, 80],
    )
    refreshBattleState(t, s)
    assert.deepEqual(
        s.player.heros_info.battle_infos.slice(0, 3).map((x) => x.hp),
        [143, 0, 80],
    )
    assert.equal(s.battleHpUnitsVersion, 1)
})
test('battle HP combines fixed-point base, table percentage and flat HP additions in actual points', () => {
    const info = {
        hero_conf_id: 101003,
        modules: [
            {
                sub_modules: [
                    {
                        attrs: {
                            attrs: [
                                { attr_id: 5, attr_val: '1968836' },
                                { attr_id: 1005, attr_val: '1000' },
                                { attr_id: 2005, attr_val: '20' },
                                { attr_id: 6, attr_val: '100' },
                            ],
                        },
                    },
                ],
            },
        ],
    }
    assert.equal(heroBattleLimits(info).hp, 236)
})
test('equipping and removing essence replaces module and never heals existing damage', () => {
    const s = seedPlayer(t, 9, 'battle')
    refreshBattleState(t, s)
    const h = s.player.heros_info.heros[0]
    s.player.heros_info.battle_infos[0].hp = 100
    s.player.heros_info.battle_infos[0].sp = 20
    h.wguid = 10001
    let result = refreshBattleState(t, s)
    assert.equal(s.player.heros_info.battle_infos[0].hp, 100)
    assert.equal(s.player.heros_info.battle_infos[0].sp, 20)
    const soul = result[0].modules.find((m) => m.module_type === 1).sub_modules[0]
    // Current 2451868 moves template10001 to group10001: HP309 at level1.
    assert.equal(soul.attrs.attrs.find((a) => a.attr_id === 5).attr_val, '3090000')
    h.wguid = 0
    result = refreshBattleState(t, s)
    assert.deepEqual(result[0].modules[1].sub_modules[0].attrs.attrs, [])
    assert.deepEqual(result[0].modules[1].sub_modules[0].skills.skills, [])
    assert.equal(s.player.heros_info.battle_infos[0].hp, 100)
})
test('all supplied usable heroes encode attributes and invalid tables fail explicitly', () => {
    const s = seedPlayer(t, 10, 'all')
    const heros = refreshBattleState(t, s)
    assert.equal(heros.length, s.player.heros_info.heros.length)
    assert(protocol.encode('SCHeroAttrInfoSync', { heros }).length > 0)
    assert(s.player.heros_info.battle_infos.every((h) => h.hp > 0))
    assert.throws(() => pairs('1#bad'))
    assert.throws(() => pairs('2'))
    assert.equal(pairs('601#|1#2').get(1), 2)
    const h = { ...s.player.heros_info.heros[0], hero_lv: 999999 }
    assert.throws(() => heroModules(t, s, h), /Missing template_hero/)
})
