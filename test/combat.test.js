import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { expandBattleReport } from '../src/combat-state.js'
import { enemyDefinition } from '../src/enemy-state.js'
import { populateParty } from './party-fixture.js'
import { afterBattlePassBeforePush, fixtureNow } from './battle-pass-packet-fixture.js'
const config = configuration(),
    protocol = new Protocol(config.base),
    tables = new Tables(config.tables)
function fixture(options = {}) {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => fixtureNow, ...options }),
        session = {}
    const call = (name, r = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: e.id, seq: 90000, pushSeq: 0, payload: protocol.encode(e.req, r) })
            .map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    }
    call('EnterGame', { open_id: 'combat-test' })
    return { store, game, session, call, state: () => store.load(session.id).state }
}
test('actual logged enemy4500001 receives cumulative authoritative HP and death through native hurt notification', () => {
    const f = fixture()
    try {
        f.call('EnterWorldMap', { map_id: 100, point_id: 10045 })
        const id = '216172782118283809',
            source = f.state().player.heros_info.heros[0].guid
        const definition = enemyDefinition(tables, f.state(), id)
        assert.equal(definition.config_id, 300071)
        assert(definition.max_hp > 0)
        assert(definition.level > 1)
        const hit = (delta) =>
            f.call('BattleInfoReduce', {
                base_time: '1000',
                uint64_dic: [source, id],
                battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: delta } }],
            })
        let packets = hit(-5)
        assert.equal(f.state().combat.entities[id].hp, definition.max_hp - 5)
        assert.equal(packets.find((p) => p.id === 10706).data.battle_info[0].hurt_info.cur_hp, definition.max_hp - 5)
        hit(-7)
        assert.equal(f.state().combat.entities[id].hp, definition.max_hp - 12)
        packets = hit(-definition.max_hp)
        assert.equal(f.state().combat.entities[id].hp, 0)
        assert.ok(packets.findIndex((p) => p.id === 10009) < packets.findIndex((p) => p.id === 10706))
        assert.equal(packets.find((p) => p.id === 10009).data.infos.find((r) => r.uuid === id).alive_state, 1)
        hit(-1)
        assert.equal(f.state().combat.entities[id].hp, 0)
        const before = f.store.load(f.session.id)
        assert.throws(() =>
            f.call('BattleInfoReduce', {
                uint64_dic: [source, id],
                battle_info: [
                    { hurt_info: { from_id: '1', tar_id: '2', hp_change: -3 } },
                    { hurt_info: { tar_id: '9' } },
                ],
            }),
        )
        assert.deepEqual(f.store.load(f.session.id), before)
        assert.throws(() =>
            f.call('BattleInfoReduce', {
                uint64_dic: [source, id],
                battle_info: [
                    { hurt_info: { from_id: '1', tar_id: '2', hp_change: -3 } },
                    { element_info: { op: 0, tar_id: '2' } },
                ],
            }),
        )
        assert.deepEqual(f.store.load(f.session.id), before)
    } finally {
        f.store.close()
    }
})
test('CBT3 report indexes and request-relative timestamps expand without rounding uint64', () => {
    const input = {
        base_time: '9007199254742000',
        uint64_dic: ['9007199254740993', '20011', '9007199254740995'],
        battle_info: [
            {
                hurt_info: {
                    from_id: '1',
                    tar_id: '0',
                    skill_id: 2,
                    element_uniqueId: '3',
                    verify_info: { related_index: '3', op_time: '123' },
                },
            },
            {
                element_info: {
                    op: 7,
                    tar_id: '1',
                    uniqueId: '3',
                    buff: {
                        cfg_id: 2,
                        begin_time: '55',
                        attacker_id: '1',
                        executor_id: '0',
                        source_id: '3',
                        creator_id: '1',
                        entrys: [
                            { key: 3, ui64_dic_values: ['1', '3'] },
                            { key: 2, ui64_dic_values: ['12345'] },
                        ],
                    },
                },
            },
            { attr_change: { uuid: '9007199254740993', attrButeInfos: [] } },
        ],
    }
    const before = structuredClone(input),
        rows = expandBattleReport(input)
    assert.deepEqual(input, before)
    assert.equal(rows[0].hurt_info.from_id, input.uint64_dic[0])
    assert.equal(rows[0].hurt_info.skill_id, 20011)
    assert.equal(rows[0].hurt_info.verify_info.op_time, '9007199254741877')
    assert.equal(rows[1].element_info.buff.begin_time, '9007199254741945')
    assert.deepEqual(rows[1].element_info.buff.entrys[0].ui64_dic_values, [input.uint64_dic[0], input.uint64_dic[2]])
    assert.deepEqual(rows[1].element_info.buff.entrys[1].ui64_dic_values, ['12345'])
    assert.equal(rows[2].attr_change.uuid, input.uint64_dic[0])
    assert.throws(
        () => expandBattleReport({ uint64_dic: ['2'], battle_info: [{ hurt_info: { tar_id: '2' } }] }),
        /dictionary index/,
    )
})
test('reported damage changes owned HP/SP, clamps healing, persists on relog and rolls back malformed batches', () => {
    const f = fixture({ clock: () => 1800000000 })
    try {
        // Current server preserves newer SP against stale absolute snapshots.
        // Start empty so this still tests the wire hundredths conversion.
        f.store.transact(f.session.id, 0, (s) => {
            populateParty(s)
            s.player.heros_info.battle_infos[0].sp = 0
            s.player.heros_info.battle_infos[1].sp = 0
        })
        const h = f.state().player.heros_info.battle_infos[0],
            original = h.hp,
            source = f.state().player.heros_info.battle_infos[1]
        const packets = f.call('BattleInfoReduce', {
            base_time: '1000',
            uint64_dic: [source.hero_id, h.hero_id],
            battle_info: [
                { hurt_info: { from_id: '1', tar_id: '2', hp_change: -100, cur_hp: 0, from_sp: 2500, tar_sp: 3300 } },
            ],
        })
        assert.equal(f.state().player.heros_info.battle_infos[0].hp, original - 100)
        assert.equal(f.state().player.heros_info.battle_infos[0].sp, 33)
        assert.equal(f.state().player.heros_info.battle_infos[1].sp, 25)
        assert.equal(packets.length, 1)
        assert.equal(packets[0].id, 10009)
        f.call('BattleInfoReduce', {
            uint64_dic: [source.hero_id, h.hero_id],
            battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', from_sp: 100, tar_sp: 100 } }],
        })
        assert.equal(f.state().player.heros_info.battle_infos[0].sp, 33)
        assert.equal(f.state().player.heros_info.battle_infos[1].sp, 25)
        f.call('BattleInfoReduce', {
            uint64_dic: [h.hero_id],
            battle_info: [{ hurt_info: { tar_id: '1', delta_sp: -300 } }],
        })
        assert.equal(f.state().player.heros_info.battle_infos[0].sp, 30)
        const before = f.store.load(f.session.id)
        assert.throws(() =>
            f.call('BattleInfoReduce', {
                uint64_dic: [h.hero_id],
                battle_info: [
                    { hurt_info: { tar_id: '1', hp_change: -1 } },
                    { hurt_info: { tar_id: '2', hp_change: -1 } },
                ],
            }),
        )
        assert.deepEqual(f.store.load(f.session.id), before)
        const again = {}
        const e = protocol.byName.get('CSProtoEnterGame')
        f.game.dispatch(again, { id: e.id, seq: 1, payload: protocol.encode(e.req, { open_id: 'combat-test' }) })
        assert.equal(f.state().player.heros_info.battle_infos[0].hp, original - 100)
        f.call('BattleInfoReduce', {
            uint64_dic: [h.hero_id],
            battle_info: [{ hurt_info: { tar_id: '1', hp_change: 2147483647 } }],
        })
        assert.equal(f.state().player.heros_info.battle_infos[0].hp, original)
    } finally {
        f.store.close()
    }
})
test('skill and projectile lifecycle is scoped, bounded and does not echo duplicate local effects', () => {
    const f = fixture()
    try {
        const [h, other] = f.state().player.heros_info.heros
        assert.deepEqual(f.call('SkillStart', { unit_id: h.guid, skill: { skill_id: 20011 }, op_time: '1000' }), [])
        assert.equal(f.state().combat.skills[h.guid].skill.skill_id, 20011)
        f.call('SkillStop', { unit_id: h.guid, skill_id: '99' })
        assert(f.state().combat.skills[h.guid])
        f.call('SkillStop', { unit_id: h.guid, skill_id: '20011' })
        assert.equal(f.state().combat.skills[h.guid], undefined)
        f.call('CreateBullet', {
            unit_id: h.guid,
            bullet_info: [{ bullet_id: '9007199254740993', config_id: 100, skill_id: 20011 }],
        })
        f.call('BulletActionChange', {
            action_info: [{ unit_id: h.guid, bullet_id: '9007199254740993', action_type: 2, action_id: 5 }],
        })
        assert.equal(f.state().combat.bullets['9007199254740993'].action.action_id, 5)
        const before = f.store.load(f.session.id)
        assert.throws(() =>
            f.call('BulletActionChange', { action_info: [{ unit_id: other.guid, bullet_id: '9007199254740993' }] }),
        )
        assert.deepEqual(f.store.load(f.session.id), before)
        f.call('ComboStart')
        f.call('ComboEnd', { combo_num: 5, combo_damage: '9999999999999999' })
        assert.equal(f.state().combat.combo.active, false)
        assert.equal(f.state().combat.combo.reported_damage, '9999999999999999')
    } finally {
        f.store.close()
    }
})
test('element add/query/change/delete and direct attribute reports retain per-world state', () => {
    const f = fixture()
    try {
        const id = f.state().player.heros_info.heros[0].guid
        f.call('BattleInfoReduce', {
            base_time: '1000',
            uint64_dic: [id, '9999999999999999', '20011'],
            battle_info: [
                {
                    element_info: {
                        op: 1,
                        tar_id: '1',
                        uniqueId: '2',
                        buff: { cfg_id: 3, begin_time: '25', layer: 1, attacker_id: '1' },
                    },
                },
            ],
        })
        const packets = afterBattlePassBeforePush(f.call('RequestHeroElement', { u64s: [id] }), tables, f.state())
        assert.deepEqual(
            packets.map((p) => p.id),
            [11113],
        )
        assert.equal(packets[0].id, 11113)
        assert.equal(packets[0].data.info[0].buff.begin_time, '975')
        assert.equal(packets[0].data.info[0].uniqueId, '9999999999999999')
        f.call('BattleInfoReduce', {
            uint64_dic: [id, '9999999999999999'],
            battle_info: [
                { element_info: { op: 3, tar_id: '1', uniqueId: '2', buff: { layer: 2 } } },
                { attr_change: { uuid: id, attrButeInfos: [{ attrId: 5, attr_values: [{ value: 123 }] }] } },
            ],
        })
        assert.equal(f.state().combat.elements['9999999999999999'].buff.layer, 2)
        assert.equal(f.state().combat.entities[id].reported_attributes[0].attrId, 5)
        f.call('BattleInfoReduce', {
            uint64_dic: [id, '9999999999999999'],
            battle_info: [{ element_info: { op: 2, tar_id: '1', uniqueId: '2' } }],
        })
        const empty = afterBattlePassBeforePush(f.call('RequestHeroElement', { u64s: [id] }), tables, f.state())
        assert.deepEqual(
            empty.map((p) => p.id),
            [11113],
        )
        assert.deepEqual(empty[0].data.info, [])
    } finally {
        f.store.close()
    }
})

test('configured hero ultimate drains SP while ordinary skill slot claims do not', () => {
    const f = fixture()
    try {
        const hero = f.state().player.heros_info.heros.find((h) =>
            String(tables.find('hero', h.conf_id).skillList)
                .split('|')
                .some((x) => x.startsWith('4#')),
        )
        assert(hero)
        const id = Number(
            String(tables.find('hero', hero.conf_id).skillList)
                .split('|')
                .find((x) => x.startsWith('4#'))
                .split('#')[1],
        )
        f.store.transact(f.session.id, 0, (s) => {
            s.player.heros_info.battle_infos.find((h) => h.hero_id === hero.guid).sp = 80
        })
        f.call('SkillStart', { unit_id: hero.guid, skill: { skill_id: 20011, slot: 4 } })
        assert.equal(f.state().player.heros_info.battle_infos.find((h) => h.hero_id === hero.guid).sp, 80)
        const packets = f.call('SkillStart', { unit_id: hero.guid, skill: { skill_id: id } })
        assert.equal(f.state().player.heros_info.battle_infos.find((h) => h.hero_id === hero.guid).sp, 0)
        assert.equal(packets[0].id, 10009)
    } finally {
        f.store.close()
    }
})
