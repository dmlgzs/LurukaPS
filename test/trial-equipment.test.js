import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { heroModules, pairs } from '../src/battle.js'
import { trialSoulEssence } from '../src/trial-equipment.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
test('equipped trial Abi enters task dungeon with table soul attributes and skill, without granting permanent equipment', () => {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables),
        session = {}
    let seq = 1
    const call = (name, r) => {
        const p = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: p.id, seq: seq++, payload: protocol.encode(p.req, r) })
            .map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    }
    const state = () => store.load(session.id).state
    try {
        call('EnterGame', { open_id: 'trial-equipped-abi' })
        store.transact(session.id, 0, (s) => {
            s.player.basic_info.lv = 30
            s.world.map_id = 100
            s.tasks = [
                {
                    task_id: 323001,
                    nodes: [{ node_id: 15, node_values: [0], client_before: true }],
                    finish_nodes: [],
                    reward_nodes: [],
                },
            ]
            s.taskRecords = tables
                .get('task')
                .filter((t) => t.type === 1)
                .map((t) => ({ task_id: t.id, count: 1, time: 1 }))
            s.taskEpochs[323001] = 1
            s.taskSceneReceipts['323001:1:15'] = true
        })
        const d = tables.find('dungeon', 10061)
        call('CampaignCreate', { group_id: d.groupId, difficulty: d.dungeonGroupOrder })
        assert.equal(state().world.map_id, 6206)
        const owned = structuredClone(state().player.soulessence_infos)
        const req = {
            trial_heros: [{ pos: 0, id: 2109001 }],
            trial_pets: [{ pos: 0, id: 0 }],
            open: true,
            force: true,
            trial_control: { id: 2109001 },
        }
        const packets = call('TrialGroupChange', req),
            hero = state().trialGroup.heroes[0]
        assert.equal(hero.conf_id, 107003)
        const module = heroModules(tables, state(), hero).modules.find((m) => m.module_type === 1).sub_modules[0]
        assert.ok(module.attrs.attrs.length > 0)
        const config = tables.find('soulessence', 10061),
            expected = pairs(tables.find('soulessence_value', config.attribute * 1000 + 30).baseAttribute)
        for (const [id, n] of expected)
            assert.equal(
                Number(module.attrs.attrs.find((a) => a.attr_id === id).attr_val),
                n * ([1, 3, 5, 201, 229, 230].includes(id) ? 10000 : 1),
            )
        assert.ok(module.skills.skills.some((s) => s.skill_id === 1900800 && s.skill_lv === 1))
        assert.ok(packets.some((p) => p.id === 10006))
        assert.deepEqual(state().player.soulessence_infos, owned)
        call('TrialGroupChange', req)
        assert.deepEqual(state().player.soulessence_infos, owned)
        call('TrialGroupChange', { open: false, force: true })
        assert.equal(state().trialGroup, undefined)
        assert.deepEqual(state().player.soulessence_infos, owned)
    } finally {
        store.close()
    }
})
test('trial soul validation rejects missing table references instead of accepting unequipped trial silently', () => {
    assert.throws(() => trialSoulEssence(tables, { soulessence: '999999|0|30' }), /attributes unavailable/)
    assert.throws(() => trialSoulEssence(tables, { soulessence: '10061|0' }), /Invalid trial/)
    assert.deepEqual(trialSoulEssence(tables, tables.find('hero_interim', 2109001)), {
        id: 10061,
        lv: 30,
        advance: 1,
        rank: 1,
    })
})
