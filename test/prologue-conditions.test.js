import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { TaskGraphs, makeNode } from '../src/tasks.js'
import { WorldObjectCatalog } from '../src/world-objects.js'
import { taskActions } from '../src/task-scenes.js'
import { nodeConditions } from '../src/tasks.js'
import { bytes } from '../src/player.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    p = new Protocol(cfg.base),
    world = new WorldObjectCatalog(tables)
function fixture(taskId, nodeId, map) {
    const store = new Store(':memory:'),
        game = new Game(p, store, tables, { rng: () => 0 }),
        session = {}
    let seq = 1
    const call = (name, r = {}) => {
        const e = p.byName.get('CSProto' + name)
        return game.dispatch(session, { id: e.id, seq: seq++, payload: p.encode(e.req, r) })
    }
    call('EnterGame', { open_id: 'prologue' })
    const graph = new TaskGraphs(tables).get(taskId)
    const edit = (fn) => store.transact(session.id, 0, fn)
    edit((s) => {
        s.world.map_id = map
        s.tasks = [
            {
                task_id: taskId,
                nodes: [{ ...makeNode(graph, nodeId, s), client_before: true }],
                finish_nodes: [graph.start],
                reward_nodes: [],
            },
        ]
        if (taskId === 106002) s.taskRecords = [{ task_id: 106001, count: 1, time: 1 }]
    })
    return { store, game, call, edit, graph, state: () => store.load(session.id).state }
}
test('creation page receives CBT3 new-player name marker and legacy default account migrates at login', () => {
    const f = fixture(106001, 11, 102)
    try {
        assert.equal(Buffer.from(f.state().player.basic_info.name, 'base64').toString('utf8'), '&AzurPlayer')
        f.edit((s) => {
            s.player.basic_info.name = bytes('AzurPlayer')
            s.characterCustomized = false
        })
        const e = p.byName.get('CSProtoEnterGame')
        f.game.dispatch({}, { id: e.id, seq: 1, payload: p.encode(e.req, { open_id: 'prologue' }) })
        assert.equal(Buffer.from(f.state().player.basic_info.name, 'base64').toString('utf8'), '&AzurPlayer')
        assert.equal(f.state().tasks[0].nodes[0].node_id, 11)
        f.edit((s) => {
            s.player.basic_info.name = bytes('&AzurJSPlayer')
            s.characterCustomized = false
        })
        f.game.dispatch({}, { id: e.id, seq: 2, payload: p.encode(e.req, { open_id: 'prologue' }) })
        assert.equal(Buffer.from(f.state().player.basic_info.name, 'base64').toString('utf8'), '&AzurPlayer')
        f.call('PlayerCustomData', { name: bytes('PlayerName'), wardrobe_info: { sex: 2, height: 90, complexion: 0 } })
        const state = f.state(),
            groups = state.player.group_mgrs[0].groups,
            main = state.player.heros_info.heros.find((hero) => hero.conf_id === 199001)
        assert.equal(state.characterCustomized, true)
        assert.equal(state.tasks[0].nodes[0].node_values[0], 1)
        assert.equal(Buffer.from(state.player.basic_info.name, 'base64').toString('utf8'), 'PlayerName')
        assert.equal(groups[0].heros[0].hero_id, main.guid)
        assert.equal(groups[0].control, main.guid)
        assert(groups[0].heros.slice(1).every((slot) => slot.hero_id === '0'))
        assert(
            groups
                .slice(1)
                .every((group) => group.control === '0' && group.heros.every((slot) => slot.hero_id === '0')),
        )
        f.game.dispatch({}, { id: e.id, seq: 2, payload: p.encode(e.req, { open_id: 'prologue' }) })
        assert.equal(Buffer.from(f.state().player.basic_info.name, 'base64').toString('utf8'), 'PlayerName')
    } finally {
        f.store.close()
    }
})
test('early creator After ACK waits for real customization, then grants once and advances', () => {
    const f = fixture(106001, 11, 102),
        q = { task_id: 106001, node_id: 11 }
    try {
        const early = f.call('TaskClientAfter', q)
        assert.deepEqual(p.decode('Rewards', early.find((x) => x.id === 9862).payload).rewards, [])
        assert.equal(f.state().tasks[0].nodes[0].node_id, 11)
        assert.equal(f.state().tasks[0].nodes[0].node_values[0], 0)
        assert.equal(f.state().pendingCharacterTask.node_id, 11)
        assert(!f.state().player.sbag_infos.items.some((x) => x.itemid === 1000001))
        const repeated = f.call('TaskClientAfter', q)
        assert.deepEqual(p.decode('Rewards', repeated.find((x) => x.id === 9862).payload).rewards, [])
        const before = f.store.load(1)
        assert.throws(() => f.call('PlayerCustomData', { name: bytes('') }))
        assert.deepEqual(f.store.load(1), before)
        const e = p.byName.get('CSProtoEnterGame')
        f.game.dispatch({}, { id: e.id, seq: 3, payload: p.encode(e.req, { open_id: 'prologue' }) })
        assert.equal(f.state().pendingCharacterTask.node_id, 11)
        f.call('PlayerCustomData', {
            name: bytes('CreatedPlayer'),
            wardrobe_info: { sex: 2, height: 90, complexion: 1 },
        })
        const state = f.state(),
            reward = state.player.sbag_infos.items.find((x) => x.itemid === 1000001)
        assert.equal(state.tasks[0].nodes[0].node_id, 63)
        assert.equal(state.pendingCharacterTask, undefined)
        assert(reward?.itemnum > 0)
        f.call('TaskClientAfter', q)
        assert.equal(f.state().player.sbag_infos.items.find((x) => x.itemid === 1000001).itemnum, reward.itemnum)
    } finally {
        f.store.close()
    }
})
test('current star-search save repairs pre-action only after configured transfer and NPC objective are both recorded', () => {
    const f = fixture(106001, 60, 102)
    try {
        f.edit((s) => {
            s.tasks[0].nodes[0].client_before = false
            s.world.point_id = 10203
            s.tasks[0].nodes[0].node_values = [1]
            s.taskEvents = { [`106001:${s.taskEpochs[106001]}:60:0`]: 1 }
        })
        const e = p.byName.get('CSProtoEnterGame'),
            packets = f.game.dispatch({}, { id: e.id, seq: 1, payload: p.encode(e.req, { open_id: 'prologue' }) })
        const sync = packets.find((x) => x.id === 9853),
            task = p.decode('SCTaskSync', sync.payload).tasks.find((x) => x.task_id === 106001)
        assert.equal(task.nodes[0].node_id, 60)
        assert.equal(task.nodes[0].client_before, true)
        assert.equal(f.state().tasks[0].nodes[0].client_before, true)
        f.call('TaskClientCondAfter', { task_id: 106001, node_id: 60, indexes: [0] })
        f.call('TaskClientAfter', { task_id: 106001, node_id: 60 })
        assert.equal(f.state().tasks[0].nodes[0].node_id, 57)
    } finally {
        f.store.close()
    }
})
test('prologue NPC event arriving before before-action ACK is retained but cannot bypass action callbacks', () => {
    const f = fixture(106001, 60, 102)
    try {
        f.edit((s) => {
            s.tasks[0].nodes[0].client_before = false
        })
        f.call('ClientBehaviourRecord', { key: 2519, args: [106001009, 106001, 60, 0, 1] })
        assert.equal(f.state().tasks[0].nodes[0].node_values[0], 1)
        assert.equal(f.state().tasks[0].nodes[0].client_before, false)
        assert.throws(() => f.call('TaskClientAfter', { task_id: 106001, node_id: 60 }), /pre-action/)
        f.call('TaskClientBefore', { task_id: 106001, node_id: 60 })
        f.call('TaskClientAfter', { task_id: 106001, node_id: 60 })
        assert.equal(f.state().tasks[0].nodes[0].node_id, 57)
    } finally {
        f.store.close()
    }
})
test('prologue saddle pickup commits reward and satisfies configured object300000 status before next node', () => {
    const f = fixture(106002, 63, 102)
    try {
        const object = world.object(102, 300000)
        f.edit((s) => {
            s.world.pos = object.pos
        })
        const request = {
            objs: [{ obj: { obj_id: 300000, complete: true, state_data: { step: 1 } }, interact_type: 0 }],
        }
        const packets = f.call('WorldObjInteract', request)
        assert(f.state().mountSaddles.includes(500024))
        assert.equal(f.state().worldObjects['102:300000'].complete, true)
        assert.equal(f.state().tasks[0].nodes[0].node_values[0], 1)
        assert(packets.some((x) => x.id === 9853))
        f.call('TaskClientCondAfter', { task_id: 106002, node_id: 63, indexes: [0] })
        f.call('TaskClientAfter', { task_id: 106002, node_id: 63 })
        assert.equal(f.state().tasks[0].nodes[0].node_id, f.graph.nodes.get(63).nextNodeIdList)
    } finally {
        f.store.close()
    }
})
test('configured scene104 battle objective completes only after its own enemy group dies', () => {
    const f = fixture(106002, 59, 104)
    try {
        const hero = f.state().player.heros_info.heros[0].guid,
            enemy = ((3n << 56n) | 600003n).toString()
        assert.equal(f.state().tasks[0].nodes[0].node_values[0], 0)
        f.call('PerfectDefense', { uuid: hero, target_uuid: enemy })
        assert.equal(f.state().tasks[0].nodes[0].node_values[0], 0)
        f.call('CombineAttackEnd', { attack_id: hero, target_id: enemy })
        assert.equal(f.state().tasks[0].nodes[0].node_values[0], 0)
        f.call('BattleInfoReduce', {
            uint64_dic: [hero, enemy],
            battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -2147483647 } }],
        })
        assert.equal(f.state().combat.entities[enemy].config_id, 400068)
        assert.equal(f.state().combat.entities[enemy].hp, 0)
        assert.equal(f.state().tasks[0].nodes[0].node_values[0], 1)
        f.call('TaskClientCondAfter', { task_id: 106002, node_id: 59, indexes: [0] })
        f.call('TaskClientAfter', { task_id: 106002, node_id: 59 })
        assert.equal(f.state().tasks[0].nodes[0].node_id, f.graph.nodes.get(59).nextNodeIdList)
    } finally {
        f.store.close()
    }
})
test('low-HP zero-damage reports do not invent a battle completion threshold', () => {
    const f = fixture(106002, 59, 104)
    try {
        const hero = f.state().player.heros_info.heros[0].guid,
            enemy = ((3n << 56n) | 600003n).toString()
        f.edit((s) => {
            s.combat = {
                map_id: 104,
                skills: {},
                bullets: {},
                elements: {},
                entities: {
                    [enemy]: {
                        uuid: enemy,
                        config_id: 400068,
                        pack_id: 400068,
                        object_id: 600003,
                        slot: 0,
                        level: 50,
                        max_hp: 3911,
                        hp: 200,
                        alive_state: 0,
                        updated_at: 1,
                    },
                },
                report_count: 0,
            }
        })
        const report = {
            uint64_dic: [hero, enemy],
            battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: 0, skill_id: 0 } }],
        }
        for (let i = 0; i < 3; i++) f.call('BattleInfoReduce', report)
        assert.equal(f.state().tasks[0].nodes[0].node_values[0], 0)
        f.edit((s) => {
            s.combat.entities[enemy].hp = 69
            s.combat.nearDeathReports = []
        })
        f.call('BattleInfoReduce', report)
        assert.equal(f.state().tasks[0].nodes[0].node_values[0], 0)
        f.call('BattleInfoReduce', report)
        assert.equal(f.state().tasks[0].nodes[0].node_values[0], 0)
        const packets = f.call('BattleInfoReduce', report)
        assert.equal(f.state().tasks[0].nodes[0].node_values[0], 0)
        assert.equal(f.state().combat.entities[enemy].hp, 69)
        assert(!packets.some((p) => p.id === 9853))
        assert.throws(
            () => f.call('TaskClientCondAfter', { task_id: 106002, node_id: 59, indexes: [0] }),
            /not complete/,
        )
    } finally {
        f.store.close()
    }
})
test('boss-to-hero reports retain bounded evidence without altering task rules or leaking failed batches', () => {
    const f = fixture(106002, 59, 104)
    try {
        const hero = f.state().player.heros_info.heros[0].guid,
            enemy = ((3n << 56n) | 600003n).toString()
        f.edit((s) => {
            s.combat = {
                map_id: 104,
                skills: {},
                bullets: {},
                elements: {},
                entities: {
                    [enemy]: {
                        uuid: enemy,
                        config_id: 400068,
                        object_id: 600003,
                        slot: 0,
                        max_hp: 3911,
                        hp: 200,
                        alive_state: 0,
                    },
                },
                report_count: 0,
            }
        })
        const hp = f.state().player.heros_info.battle_infos.find((x) => x.hero_id === hero).hp
        f.call('BattleInfoReduce', {
            uint64_dic: [enemy, hero],
            battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -10, cur_hp: 3, cur_phase: 2 } }],
        })
        const trace = f.state().bossBattleTrace
        assert.equal(trace.length, 1)
        assert.equal(trace[0].client_hp, 3)
        assert.equal(trace[0].server_hp, hp - 10)
        assert.equal(trace[0].cur_phase, 2)
        assert.equal(f.state().tasks[0].nodes[0].node_values[0], 0)
        const before = f.state()
        assert.throws(() =>
            f.call('BattleInfoReduce', {
                uint64_dic: [enemy, hero],
                battle_info: [
                    { hurt_info: { from_id: '1', tar_id: '2', hp_change: -10 } },
                    { hurt_info: { from_id: '1', tar_id: '3', hp_change: -1 } },
                ],
            }),
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})
test('late duplicate story-package event after node64 advances is acknowledged without changing task progress', () => {
    const f = fixture(106002, 64, 104)
    try {
        const event = { key: 2519, args: [0xffffffff, 106002, 64, 0, 1] }
        f.call('ClientBehaviourRecord', event)
        f.call('TaskClientCondAfter', { task_id: 106002, node_id: 64, indexes: [0] })
        f.call('TaskClientAfter', { task_id: 106002, node_id: 64 })
        const before = f.state()
        assert.equal(before.tasks[0].nodes[0].node_id, 60)
        f.call('ClientBehaviourRecord', event)
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})
test('configured prologue StoryKill follows story100603 and completes the enemy objective once', () => {
    const f = fixture(106002, 59, 104)
    try {
        const enemy = ((3n << 56n) | 600003n).toString(),
            request = { guid: [enemy] }
        assert.throws(() => f.call('StoryKill', request), /story has not played/)
        f.call('SetStoryId', { story_id: 100603, story_type: 0 })
        const before = f.state().player,
            packets = f.call('StoryKill', request)
        assert.equal(f.state().combat.entities[enemy].hp, 0)
        assert.equal(f.state().tasks[0].nodes[0].node_values[0], 1)
        assert(packets.some((x) => x.id === 10009))
        const reset = packets.find((x) => x.id === 10807)
        assert.ok(reset, 'scripted boss death must release its group battle relation')
        assert.equal(p.decode('cs.CSHatredReset', reset.payload).obj_id, enemy)
        assert.equal(p.decode('cs.CSHatredReset', reset.payload).is_player, false)
        assert.ok(packets.findIndex((x) => x.id === 10009) < packets.indexOf(reset), 'death precedes relation reset')
        assert(packets.some((x) => x.id === 9853))
        assert.deepEqual(f.state().player, before)
        f.call('TaskClientCondAfter', { task_id: 106002, node_id: 59, indexes: [0] })
        f.call('TaskClientAfter', { task_id: 106002, node_id: 59 })
        assert.equal(f.state().tasks[0].nodes[0].node_id, 64)
        const retry = f.call('StoryKill', request)
        assert.ok(!retry.some((x) => p.byId.get(x.id).name === 'CSProtoHatredResetSync'))
        assert.equal(f.state().tasks[0].nodes[0].node_id, 64)
        const saved = f.state()
        assert.throws(() => f.call('StoryKill', { guid: [enemy, '216172782114383812'] }))
        assert.deepEqual(f.state(), saved)
    } finally {
        f.store.close()
    }
})
test('second prologue quest follows actual configured nodes through capture, page, chest, saddle and battle to106009', () => {
    const f = fixture(106002, 56, 102)
    try {
        const visited = []
        while (f.state().tasks.some((t) => t.task_id === 106002) && visited.length < 20) {
            const task = f.state().tasks.find((t) => t.task_id === 106002),
                node = task.nodes[0],
                config = f.graph.nodes.get(node.node_id),
                request = { task_id: 106002, node_id: node.node_id }
            visited.push(node.node_id)
            for (const action of taskActions(config)) {
                const point = action.__type_TaskTransferBaseData?.transferPointId
                if (point) {
                    const map = tables.find('world_borthpos', point).cityId
                    if (map === f.state().world.map_id) f.call('WorldPoint', { point_id: point, client_trans_data: 2 })
                    else f.call('EnterWorldMap', { ...request, map_id: map, point_id: point, client_trans_data: 2 })
                }
            }
            f.call('TaskClientBefore', request)
            const conditions = nodeConditions(config)
            for (let index = 0; index < conditions.length; index++) {
                const q = conditions[index],
                    base = q.__type_TaskConditionBaseData
                if (base.unneedCompleted) continue
                if (q.conditionId === 2526) {
                    const d = base.__type_TaskCondFractalPetCatchData
                    f.call('ClientBehaviourRecord', { key: 2526, args: [106002, d.enemyData.createNpcId, d.uniKey, 2] })
                } else if (q.conditionId === 2508) f.call('ClientBehaviourRecord', { key: 2508, args: [106002, 1] })
                else if (q.conditionId === 2519) {
                    const d = base.__type_TaskCondActiveNPCTriggerData
                    f.call('ClientBehaviourRecord', {
                        key: 2519,
                        args: [
                            base.__type_TaskCondPackageDownloadCompleteData
                                ? 0xffffffff
                                : d.isNowCreate
                                  ? d.npcData.createNpcId
                                  : d.createNpcId,
                            106002,
                            node.node_id,
                            index,
                            1,
                        ],
                    })
                } else if (q.conditionId === 2521) {
                    const d = base.__type_TaskCondEntityStatusData,
                        obj = world.object(d.sceneId, d.npcId)
                    f.edit((s) => {
                        s.world.pos = obj.pos
                    })
                    f.call('WorldObjInteract', {
                        objs: [
                            {
                                obj: { obj_id: d.npcId, complete: true, state_data: { step: d.status } },
                                interact_type: 0,
                            },
                        ],
                    })
                } else if (q.conditionId === 2500) {
                    const d = base.__type_TaskCondBattleTriggerData,
                        hero = f.state().player.heros_info.heros[0].guid
                    f.call('BattleInfoReduce', {
                        uint64_dic: [hero, ((3n << 56n) | BigInt(d.npcId)).toString()],
                        battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -2147483647 } }],
                    })
                } else assert.fail('Unimplemented prologue condition ' + q.conditionId)
            }
            if (conditions.length) f.call('TaskClientCondAfter', { ...request, indexes: conditions.map((_, i) => i) })
            f.call('TaskClientAfter', request)
            if (config.nodeType === 50) f.call('TaskFinish', { u32: 106002 })
        }
        assert.deepEqual(visited, [56, 65, 61, 58, 63, 62, 57, 59, 64, 60])
        assert(f.state().tasks.some((t) => t.task_id === 106009))
        assert.equal(f.state().taskRecords.find((t) => t.task_id === 106002).count, 1)
    } finally {
        f.store.close()
    }
})
