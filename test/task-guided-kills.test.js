import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Protocol } from '../src/protocol.js'
import { Game } from '../src/game.js'
import { recordGuidedKill, recoverInitialDungeonKills } from '../src/task-kills.js'
import { guidedConditionValue } from '../src/guided-conditions.js'
import { activeFormationManager } from '../src/trial-actors.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
function fixture() {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => 1800000000 }),
        session = {}
    let seq = 1
    const call = (name, r = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, r) })
    }
    call('EnterGame', { open_id: 'guided-boss-kill' })
    store.transact(session.id, 0, (s) => {
        s.player.basic_info.lv = 20
        s.world.map_id = 100
        s.taskEpochs[107016] = 1
        s.taskRecords = tables
            .get('task')
            .filter((r) => r.type === 1 && r.id !== 107016)
            .map((r) => ({ task_id: r.id, count: 1, time: 1 }))
        s.tasks = [
            {
                task_id: 107016,
                nodes: [{ node_id: 34, node_values: [0], client_before: true }],
                finish_nodes: [26, 32, 33],
                reward_nodes: [],
            },
        ]
        s.taskSceneReceipts['107016:1:34'] = true
        delete s.pendingTaskScene
        delete s.pendingTaskStorySync
    })
    call('CampaignCreate', { group_id: 219, difficulty: 1 })
    call('TaskClientBefore', { task_id: 500018, node_id: 2 })
    return { store, game, session, call, state: () => store.load(session.id).state }
}
const target = '216172782114383809',
    context = { taskId: 500018, nodeId: 2, index: 0 }
test('table-guided400084 kill counts once, syncs the goal and permits the configured after-story', () => {
    const f = fixture()
    try {
        const s = f.state(),
            formation = activeFormationManager(s),
            source = formation.groups.find((group) => group.id === formation.cur_group).control,
            hp = s.combat.entities[target].hp
        let reportTime = 1800000000000
        assert.equal(guidedConditionValue(1070161, s, context), 0)
        const packets = f.call('BattleInfoReduce', {
            base_time: String(++reportTime),
            uint64_dic: [source, target],
            battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -hp } }],
        })
        assert.equal(f.state().tasks.find((t) => t.task_id === 500018).nodes[0].node_values[0], 1)
        assert.equal(guidedConditionValue(1070161, f.state(), context), 1)
        assert.ok(packets.some((p) => p.id === 9860 || protocol.byId.get(p.id)?.name === 'CSProtoTaskSync'))
        f.call('BattleInfoReduce', {
            base_time: String(++reportTime),
            uint64_dic: [source, target],
            battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -hp } }],
        })
        assert.equal(guidedConditionValue(1070161, f.state(), context), 1)
        f.call('TaskClientCondAfter', { task_id: 500018, node_id: 2, indexes: [0] })
        f.call('TaskClientAfter', { task_id: 500018, node_id: 2 })
        assert.equal(f.state().tasks.find((t) => t.task_id === 500018).nodes[0].node_id, 3)
    } finally {
        f.store.close()
    }
})
test('friendly AI heroes, wrong targets and wrong scene never satisfy the configured kill goal', () => {
    const f = fixture()
    try {
        f.store.transact(f.session.id, 0, (s) => {
            const boss = { ...s.combat.entities[target], hp: 0, alive_state: 1 }
            recordGuidedKill(tables, s, { ...boss, config_id: 310001, pack_id: 20000010 })
            recordGuidedKill(tables, s, { ...s.combat.entities['216172782114383810'], hp: 0, alive_state: 1 })
            recordGuidedKill(tables, s, { ...boss, captured: true })
            s.world.map_id = 100
            recordGuidedKill(tables, s, boss)
        })
        assert.equal(guidedConditionValue(1070161, f.state(), context), 0)
    } finally {
        f.store.close()
    }
})
test('old current-run dead boss recovers on login without another battle or fake story completion', () => {
    const f = fixture()
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.combat.entities[target] = {
                ...s.combat.entities[target],
                hp: 0,
                alive_state: 1,
                updated_at: s.storyCampaign.start_time + 2,
            }
        })
        const before = f.state(),
            who = {},
            e = protocol.byName.get('CSProtoEnterGame')
        f.game.dispatch(who, {
            id: e.id,
            seq: 100,
            payload: protocol.encode(e.req, { open_id: 'guided-boss-kill', reconnect: true }),
        })
        const s = f.state(),
            task = s.tasks.find((t) => t.task_id === 500018)
        assert.equal(task.nodes[0].node_values[0], 1)
        assert.equal(task.nodes[0].node_id, 2)
        assert.deepEqual(s.player.basic_info, before.player.basic_info)
        assert.equal(s.world.map_id, 6207)
        assert.equal(s.storyCampaign.status, 2)
        recoverInitialDungeonKills(tables, s)
        assert.equal(guidedConditionValue(1070161, s, context), 1)
    } finally {
        f.store.close()
    }
})
test('legacy recovery rejects deaths before this dungeon run or while the node was not initialized', () => {
    const f = fixture()
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.combat.entities[target] = {
                ...s.combat.entities[target],
                hp: 0,
                alive_state: 1,
                updated_at: s.storyCampaign.start_time - 1,
            }
            recoverInitialDungeonKills(tables, s)
        })
        assert.equal(guidedConditionValue(1070161, f.state(), context), 0)
        f.store.transact(f.session.id, 0, (s) => {
            s.combat.entities[target].updated_at = s.storyCampaign.start_time + 1
            s.tasks.find((t) => t.task_id === 500018).nodes[0].client_before = false
            recoverInitialDungeonKills(tables, s)
        })
        assert.equal(guidedConditionValue(1070161, f.state(), context), 0)
    } finally {
        f.store.close()
    }
})

test('guided boss FSM story101266 authorizes its exact StoryKill callback and credits the kill goal', () => {
    const f = fixture()
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.combat.entities[target].hp = 55
        })
        const before = f.store.load(f.session.id)
        assert.throws(() => f.call('StoryKill', { guid: [target] }), /story has not played/)
        assert.deepEqual(f.store.load(f.session.id), before)
        f.call('SetStoryId', { story_id: 101266, story_type: 3, is_skip: false })
        f.call('StoryKill', { guid: [target] })
        assert.equal(f.state().combat.entities[target].hp, 0)
        assert.equal(f.state().tasks.find((t) => t.task_id === 500018).nodes[0].node_values[0], 1)
        assert.deepEqual(f.state().storyKillReceipts['6207:' + target].story_ids, [101266])
        f.call('StoryKill', { guid: [target] })
        assert.equal(guidedConditionValue(1070161, f.state(), context), 1)
        assert.throws(() => f.call('StoryKill', { guid: ['216172782114383810'] }), /no configured story kill/)
        f.call('TaskClientCondAfter', { task_id: 500018, node_id: 2, indexes: [0] })
        f.call('TaskClientAfter', { task_id: 500018, node_id: 2 })
        assert.equal(f.state().tasks.find((t) => t.task_id === 500018).nodes[0].node_id, 3)
    } finally {
        f.store.close()
    }
})
