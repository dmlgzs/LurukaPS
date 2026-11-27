import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { combatHurtIsDuplicate } from '../src/combat-hurt-receipts.js'
import {
    currentFixedGroup,
    fundCurrentCombatActors,
    qualifyCurrentCombatWorld,
} from './combat-normal-current-fixture.js'

test('current ordinary battle acknowledges duplicate global damage indices without applying HP or SP twice', (t) => {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base),
        store = new Store(':memory:'),
        now = 1800000000,
        game = new Game(protocol, store, tables, { clock: () => now }),
        session = {}
    let sequence = 1,
        group,
        hero
    const call = (name, value = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: entry.id, seq: sequence++, payload: protocol.encode(entry.req, value) })
    }
    const state = () => store.load(session.id).state
    const hit = (index, target = group.ids[0], extra = {}) =>
        call('BattleInfoReduce', {
            base_time: String(now * 1000 + 1),
            uint64_dic: [hero, target],
            battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -7, dmg_inc_id: index, ...extra } }],
        })
    try {
        call('EnterGame', { open_id: 'current-ordinary-hurt-receipts' })
        store.transact(session.id, 0, (draft) => {
            qualifyCurrentCombatWorld(tables, draft)
            fundCurrentCombatActors(tables, draft)
            const manager = draft.player.group_mgrs.find((value) => value.type === 1)
            hero = manager.groups.find((value) => value.id === manager.cur_group).control
            draft.player.heros_info.battle_infos.find((value) => value.hero_id === hero).sp = 0
            group = currentFixedGroup(tables, draft, { minHp: 100, minSlots: 2 })
        })
        t.diagnostic(
            JSON.stringify({
                map: state().world.map_id,
                object: group.row.id,
                group: group.group.id,
                packs: group.packs,
                hp: group.definitions.map((value) => value.max_hp),
            }),
        )
        hit(1)
        const afterFirst = state().combat.entities[group.ids[0]].hp,
            duplicate = hit(1)
        assert.equal(state().combat.entities[group.ids[0]].hp, afterFirst, 'One numbered hit must be applied once')
        const ack = duplicate.find((packet) => packet.id === protocol.byName.get('SCProtoBattleInfoReduceNtf').id)
        assert(ack, 'A retry still needs the current HP acknowledgement to clear the client DamageIndex')
        assert.equal(
            protocol.decode(protocol.byId.get(ack.id).rsp, ack.payload).battle_info[0].hurt_info.cur_hp,
            afterFirst,
        )
        hit(3)
        hit(2)
        assert.equal(
            state().combat.entities[group.ids[0]].hp,
            afterFirst - 14,
            'Out-of-order first-seen hits remain valid',
        )
        const beforeConflict = structuredClone(state())
        assert.throws(() => hit(3, group.ids[1]), /Conflicting combat damage index/)
        assert.deepEqual(
            state(),
            beforeConflict,
            'A conflicting global index must roll back preparations as well as receipts',
        )
        hit(4, group.ids[1])
        assert.equal(state().combat.entities[group.ids[1]].hp, group.definitions[1].max_hp - 7)
        hit(0)
        hit(0)
        assert.equal(
            state().combat.entities[group.ids[0]].hp,
            afterFirst - 28,
            'Unsequenced identical hits are not duplicates',
        )
        const beforeRejectedBatch = structuredClone(state())
        assert.throws(
            () =>
                call('BattleInfoReduce', {
                    base_time: String(now * 1000 + 1),
                    uint64_dic: [hero, group.ids[0]],
                    battle_info: [
                        { hurt_info: { from_id: '1', tar_id: '2', hp_change: -7, dmg_inc_id: 5 } },
                        { hurt_info: { from_id: '1', tar_id: '2', hp_change: -9, dmg_inc_id: 3 } },
                    ],
                }),
            /Conflicting combat damage index/,
        )
        assert.deepEqual(
            state(),
            beforeRejectedBatch,
            'Rejected batch must not consume the earlier accepted row number',
        )
        hit(5)
        const finalHp = state().combat.entities[group.ids[0]].hp
        assert.equal(finalHp, afterFirst - 35)
        hit(5)
        assert.equal(state().combat.entities[group.ids[0]].hp, finalHp)
        const damageHero = () =>
            call('BattleInfoReduce', {
                base_time: String(now * 1000 + 1),
                uint64_dic: [group.ids[0], hero],
                battle_info: [
                    { hurt_info: { from_id: '1', tar_id: '2', hp_change: -1, delta_sp: 100, dmg_inc_id: 6 } },
                ],
            })
        damageHero()
        const heroAfter = structuredClone(
            state().player.heros_info.battle_infos.find((value) => value.hero_id === hero),
        )
        assert(heroAfter.sp > 0, 'The first HP event must apply its accompanying SP delta')
        const heroRetry = damageHero()
        assert.deepEqual(
            state().player.heros_info.battle_infos.find((value) => value.hero_id === hero),
            heroAfter,
            'A retried numbered HP event must not apply a second hero HP or SP delta',
        )
        const heroAck = heroRetry.find((packet) => packet.id === protocol.byName.get('SCProtoBattleInfoReduceNtf').id)
        assert.equal(
            protocol.decode(protocol.byId.get(heroAck.id).rsp, heroAck.payload).battle_info[0].hurt_info.cur_hp,
            heroAfter.hp,
        )
    } finally {
        store.close()
    }
})

test('ordinary receipt retention survives diagnostic eviction and a fresh connection has its own counter scope', () => {
    const c = { state: { combat: {} }, combatSessionId: 'private-connection-a' },
        hurt = (index) => ({ from_id: '10', tar_id: '20', hp_change: -7, dmg_inc_id: index })
    for (let index = 1; index <= 513; index++) assert.equal(combatHurtIsDuplicate(c, hurt(index)), false)
    const previous = c.state.combat.hurt_receipts
    assert.equal(previous.receipt.recent[1], undefined)
    assert.equal(combatHurtIsDuplicate(c, hurt(1)), true, 'Eviction of diagnostics must not forget an applied hit')
    assert.deepEqual(previous.receipt.ranges, [[1, 513]])
    c.combatSessionId = 'private-connection-b'
    assert.equal(combatHurtIsDuplicate(c, hurt(1)), false, 'A new client process can restart its global damage counter')
    assert.deepEqual(
        previous.receipt.ranges,
        [[1, 513]],
        'The replaced namespace must stay immutable for deferred rollback',
    )
    assert(!JSON.stringify(c.state).includes('private-connection-'), 'Never persist the raw connection credential')
})
