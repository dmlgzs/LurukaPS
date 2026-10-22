import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { tableWaveCampaignRoute } from '../src/table-wave-campaign.js'
import { campaignStagePlan } from '../src/campaign-stage-plan.js'
import { TaskGraphs, makeNode } from '../src/tasks.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
test('204/1 resolves the exact targeted victory, runs all seven configured stages and does not skip interactions', () => {
    const dungeon = tables.find('dungeon', 10023),
        route = tableWaveCampaignRoute(tables, dungeon)
    assert.deepEqual(route.scene_ids, [6215])
    assert.equal(route.victory_stage_count, 7)
    assert.equal(route.preview_roster_matches, false)
    const ambiguous = Object.create(tables)
    ambiguous.get = (n) => (n === 'dungeon_scene' ? [tables.find(n, 6215), tables.find(n, 6215)] : tables.get(n))
    assert.equal(tableWaveCampaignRoute(ambiguous, dungeon), null)
    assert.equal(tableWaveCampaignRoute(tables, { ...dungeon, enemy: '310001#1' }), null)
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => 1800000000 }),
        session = {}
    let seq = 1
    const call = (name, r = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, r) })
    }
    const state = () => store.load(session.id).state
    try {
        call('EnterGame', { open_id: 'targeted-campaign' })
        store.transact(session.id, 0, (s) => {
            s.world.map_id = 100
            s.player.basic_info.lv = 30
            s.taskRecords = tables
                .get('task')
                .filter((t) => t.type === 1)
                .map((t) => ({ task_id: t.id, count: 1, time: 1 }))
            s.tasks = [
                {
                    task_id: 202025,
                    nodes: [{ ...makeNode(new TaskGraphs(tables).get(202025), 4, s), client_before: true }],
                    finish_nodes: [],
                    reward_nodes: [],
                    start_time: 1,
                },
            ]
        })
        call('CampaignCreate', { group_id: 204, difficulty: 1 })
        assert.equal(state().world.map_id, 6215)
        const plan = campaignStagePlan(tables, 6215)
        for (let step = 0; step < plan.length; step++) {
            assert.equal(state().storyCampaign.stage_index ?? 0, step)
            assert.throws(() => call('EndDungeonScene', { result: 3 }), /not defeated/)
            const row = plan[step][0],
                s = state()
            assert.equal(s.worldObjects['6215:' + row.id].active, true)
            if (tables.find('world_spawner', row.spawnerId).objectType === 50) {
                const enemies = Object.values(s.combat.entities).filter((e) => e.object_id === row.id)
                call('BattleInfoReduce', {
                    uint64_dic: [s.player.heros_info.heros[0].guid, ...enemies.map((e) => e.uuid)],
                    battle_info: enemies.map((e, i) => ({
                        hurt_info: { from_id: '1', tar_id: String(i + 2), hp_change: -e.hp },
                    })),
                })
                assert.deepEqual(state().worldObjects['6215:' + row.id].expand_data.battle_group.world_indexes, [])
            } else {
                store.transact(session.id, 0, (s) => {
                    s.world.pos = { ...s.worldObjects['6215:' + row.id].pos }
                })
                call('WorldObjInteract', {
                    objs: [{ obj: { obj_id: row.id, complete: true, state_data: { step: 1, complete: true } } }],
                })
            }
        }
        assert.equal(state().storyCampaign.status, 3)
        assert.equal(state().storyCampaign.stage_index, 7)
        assert.equal(state().storyCampaignClears[10023].count, 1)
        call('EndDungeonScene', { result: 3 })
        call('CampaignQuit')
        assert.equal(state().world.map_id, 100)
    } finally {
        store.close()
    }
})
