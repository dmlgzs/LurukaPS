import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Protocol } from '../src/protocol.js'
import { Game } from '../src/game.js'
import { TaskGraphs, makeNode } from '../src/tasks.js'
import { boundedSet } from '../src/combat-state.js'
import { combatEntityStates, combatEnemyRoot } from '../src/combat-enemy-lifecycle.js'
import { ensureStoryCampaignScene, storyCampaignConfig } from '../src/story-campaign.js'
import { ensureEntrustSceneObjects, getEntrustCatalog } from '../src/entrust.js'
import { abyssFixture } from './abyss-fixture.js'
import { ensureAbyssScene } from '../src/abyss-scene.js'
import { fixture as cultFixture } from './cult-archive-fixture.js'
import { ensureCultTrialScene } from '../src/cult-trial.js'

function fixture(name) {
    const config = configuration(),
        tables = new Tables(config.tables),
        protocol = new Protocol(config.base),
        store = new Store(':memory:')
    let now = 1800000000,
        seq = 1,
        session = {}
    const game = new Game(protocol, store, tables, { clock: () => now })
    const call = (name, request = {}) => {
        const entry = protocol.byName.get(name) ?? protocol.byName.get('CSProto' + name)
        return game.dispatch(session, {
            id: entry.id,
            seq: seq++,
            payload: entry.req ? protocol.encode(entry.req, request) : Buffer.alloc(0),
        })
    }
    call('EnterGame', { open_id: name })
    const edit = (fn) => store.transact(session.id, 0, fn),
        state = () => store.load(session.id).state
    edit((s) => {
        s.tasks = []
        s.taskRecords = tables
            .get('task')
            .filter((r) => r.type === 1)
            .map((r) => ({ task_id: r.id, count: 1 }))
        s.player.basic_info.lv = 60
        Object.assign(s.world, tables.position(tables.find('world_borthpos', 10045)))
    })
    return {
        tables,
        protocol,
        store,
        game,
        call,
        edit,
        state,
        now: () => now,
        advance: () => ++now,
        session: () => session,
        reconnect: () => {
            session = {}
            return call('EnterGame', { open_id: name, reconnect: true })
        },
    }
}
function enterStory(f, group) {
    const config = storyCampaignConfig(f.tables, group, 1),
        graphs = new TaskGraphs(f.tables)
    let entry
    for (const row of f.tables.get('task')) {
        const graph = graphs.get(row.id)
        for (const node of graph.nodes.values())
            if (
                (node.__type_TaskConditionNodeData?.conditionList ?? []).some(
                    (c) => c.__type_TaskConditionBaseData?.__type_TaskCondDungeonData?.dungeonId === config.dungeon.id,
                )
            ) {
                entry = { row, graph, node }
                break
            }
        if (entry) break
    }
    assert(entry, 'current parent task explicitly admits the dungeon')
    f.edit((s) => {
        s.taskEpochs[entry.row.id] = 1
        s.taskSceneReceipts[`${entry.row.id}:1:${entry.node.id}`] = true
        s.tasks = [
            {
                task_id: entry.row.id,
                nodes: [{ ...makeNode(entry.graph, entry.node.id, s), client_before: true }],
                finish_nodes: [],
                reward_nodes: [],
            },
        ]
        s.taskRecords = s.taskRecords.filter((r) => r.task_id !== entry.row.id)
    })
    return f.call('CampaignCreate', { group_id: group, difficulty: 1 })
}
function hit(f, id, delta, timestamp) {
    f.advance()
    const s = f.state(),
        source = s.player.heros_info.heros.find((h) => h.type === 1).guid
    return f.call('BattleInfoReduce', {
        base_time: timestamp ?? String(f.now() * 1000),
        uint64_dic: [source, id],
        battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: delta } }],
    })
}
function evict(f, id) {
    f.edit((s) => {
        for (let index = 0; index < 520; index++) {
            const uuid = ((3n << 56n) | BigInt(1900000000 + index)).toString()
            boundedSet(
                s.combat.entities,
                uuid,
                { uuid, object_id: 1900000000 + index, hp: 1, alive_state: 0, updated_at: f.now() },
                512,
            )
        }
        assert(!s.combat.entities[id])
    })
}

test('actual task6207 initializes friendly AI before9141, keeps terminal HP through eviction/login, and re-enters a fresh same-pack run', () => {
    const f = fixture('current-task-scene-lifecycle')
    try {
        enterStory(f, 219)
        let s = f.state(),
            enemy = s.worldObjects['6207:600001'].expand_data.battle_group.monsters[0],
            ally = s.worldObjects['6207:600002'].expand_data.battle_group.monsters[0]
        assert.equal(s.storyCampaign.stage_conditions, false)
        const response = f.call('CSWorldObjAIHeroInfo', { enemy_pack_id: ally.enemy_pack })
        assert(response.findIndex((p) => p.id === 10009) < response.findIndex((p) => p.id === 9141))
        const root = combatEnemyRoot(enemy.uid),
            generation = s.combat.enemyActivations[root].generation
        f.call('TaskClientBefore', { task_id: 500018, node_id: 2 })
        hit(f, enemy.uid, -enemy.hp)
        s = f.state()
        assert.equal(s.combat.entities[enemy.uid].hp, 0)
        assert.equal(s.combat.entities[ally.uid].hp, ally.hp)
        assert.equal(s.tasks.find((t) => t.task_id === 500018).nodes[0].node_values[0], 1)
        evict(f, enemy.uid)
        f.advance()
        f.reconnect()
        s = f.state()
        assert.equal(s.combat.entities[enemy.uid].hp, 0)
        assert.equal(s.combat.enemyActivations[root].generation, generation)
        assert(!s.worldObjects['6207:600001'].expand_data.battle_group.world_indexes.includes(0))
        f.call('TaskClientCondAfter', { task_id: 500018, node_id: 2, indexes: [0] })
        f.call('TaskClientAfter', { task_id: 500018, node_id: 2 })
        assert.equal(f.state().tasks.find((t) => t.task_id === 500018).nodes[0].node_id, 3)
        f.call('CampaignQuit')
        assert(!f.state().tasks.some((t) => t.task_id === 500018))
        f.advance()
        enterStory(f, 219)
        s = f.state()
        const fresh = s.worldObjects['6207:600001'].expand_data.battle_group.monsters[0]
        assert.equal(fresh.uid, enemy.uid)
        assert.equal(fresh.enemy_pack, enemy.enemy_pack)
        assert(fresh.hp > 0)
        hit(f, fresh.uid, -fresh.hp, '1800000000000')
        assert.equal(
            f.state().combat.entities[fresh.uid].hp,
            fresh.hp,
            'old-run report cannot kill a newly admitted actor',
        )
    } finally {
        f.store.close()
    }
})

test('current task-route10020 never compiles old common stages and creates all three current task scenes', () => {
    const f = fixture('current-task-route10020')
    try {
        const config = storyCampaignConfig(f.tables, 201, 1)
        assert.deepEqual(config.taskIds, [500025, 500026, 500027])
        assert.equal(config.stageConditions, false)
        enterStory(f, 201)
        for (const scene of config.scenes) {
            f.edit((s) => {
                s.world.map_id = scene.scene.id
                s.storyCampaign.map_id = scene.scene.id
                delete s.storyCampaign.initialized_scene
                ensureStoryCampaignScene(f.tables, s, f.now())
            })
            assert(f.state().worldObjects[scene.scene.id + ':' + f.tables.get('worldmap_' + scene.scene.id)[0].id])
        }
        f.call('CampaignQuit')
        assert(!f.state().storyCampaign)
    } finally {
        f.store.close()
    }
})

test('actual material entry projects current terminal facts and restart admits the same UUID and pack as a new run', () => {
    const f = fixture('current-material-lifecycle')
    try {
        f.edit((s) => {
            s.player.attr_infos.attrs.find((r) => r.attr_id === 3).attr_val = '500'
        })
        const material = f.tables.get('dungeon_material').find((row) => row.unlock === '2004#1')
        f.call('MultiCampaignCreate', { dungeon_id: material.dungeonId, scene_type: 12 })
        f.call('MultiCampaignPlayerLoadFinish')
        let s = f.state(),
            catalog = getEntrustCatalog(f.tables),
            stages = catalog.stages(s.entrust.run.entrust_id, s.entrust.run.kind),
            marker = stages[0].row
        f.call('WorldObjInteract', {
            objs: [{ obj: { obj_id: marker.id, complete: true, state_data: { step: 0 } }, interact_type: 2 }],
        })
        s = f.state()
        const live = s.entrust.run.scene_objects
                .filter((r) => r.active && r.expand_data?.battle_group)
                .flatMap((r) => r.expand_data.battle_group.monsters),
            enemy = live[0]
        assert(enemy)
        hit(f, enemy.uid, -enemy.hp)
        evict(f, enemy.uid)
        f.edit((state) => ensureEntrustSceneObjects(f.tables, state, f.now()))
        assert.equal(combatEntityStates(f.state().combat)[enemy.uid].hp, 0)
        const old = f.state().entrust.run.instance_id
        f.advance()
        f.call('MultiCampaignRestart')
        s = f.state()
        assert(s.entrust.run.instance_id > old)
        const fresh = s.entrust.run.scene_objects
            .flatMap((r) => r.expand_data?.battle_group?.monsters ?? [])
            .find((r) => r.uid === enemy.uid)
        assert(fresh?.hp > 0)
        assert.equal(fresh.enemy_pack, enemy.enemy_pack)
    } finally {
        f.store.close()
    }
})

test('actual abyss preload and start use a new same-pack active generation while later room projections preserve earlier deaths', () => {
    const f = abyssFixture('current-abyss-lifecycle')
    try {
        f.call('AbyssChallenge', f.request())
        let s = f.state()
        const candidates = Object.entries(s.combat.enemyActivations),
            before = candidates.map(([root, a]) => ({ root, ...a }))
        assert(before.length && before.every((a) => a.active === false))
        f.time.now++
        f.call('AbyssChallengeRealStart')
        s = f.state()
        const root = Object.keys(s.combat.enemyActivations).find((id) => s.combat.enemyActivations[id].active),
            active = s.combat.enemyActivations[root],
            prior = before.find((a) => a.root === root)
        assert(active.generation > prior.generation)
        assert.deepEqual(active.packIds, prior.packIds)
        const enemy = Object.values(s.combat.entities).find((e) => combatEnemyRoot(e.uuid) === root)
        const source = s.abyssRun.heroes[0].guid
        f.time.now++
        f.call('BattleInfoReduce', {
            base_time: String(f.time.now * 1000),
            uint64_dic: [source, enemy.uuid],
            battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -enemy.hp } }],
        })
        s = f.state()
        assert.equal(combatEntityStates(s.combat)[enemy.uuid].hp, 0)
        const generation = s.combat.enemyActivations[root].generation
        f.store.transact(f.session.id, 0, (state) => {
            delete state.combat.entities[enemy.uuid]
            ensureAbyssScene(f.tables, state, f.time.now + 20)
        })
        assert.equal(combatEntityStates(f.state().combat)[enemy.uuid].hp, 0)
        assert.equal(f.state().combat.enemyActivations[root].generation, generation)
    } finally {
        f.store.close()
    }
})

test('actual cultivation entry/start admits its configured wave and reprojects dead slots without resetting them', () => {
    const f = cultFixture('current-cult-scene-lifecycle', ':memory:', true)
    try {
        f.store.transact(f.session.id, 0, (state) => {
            state.tasks = []
            state.taskRecords = [106010, 102025, 404002].map((task_id) => ({ task_id, count: 1 }))
        })
        f.start()
        f.store.transact(f.session.id, 0, (s) => {
            s.tasks = []
            s.taskRecords = f.tables
                .get('task')
                .filter((r) => r.type === 1 || r.id === 404002)
                .map((r) => ({ task_id: r.id, count: 1 }))
            Object.assign(s.world, f.tables.position(f.tables.find('world_borthpos', 20005)))
            // Trusted current first-examination checkpoint; ending/archive
            // generation is a separate producer and not fabricated here.
            s.activities[60001].growup.cur_stage = 1
            s.activities[60001].growup.cur_growup_trail_stage = 1
        })
        f.call('EnterCultTrial', { activity_id: 60001, trial_id: 101 })
        f.call('MultiCampaignPlayerLoaded')
        let s = f.state()
        assert.equal(s.cultTrial.current_wave, 1)
        const active = s.cultTrial.scene_objects.find((row) => row.active && row.expand_data?.battle_group)
        const enemy = active.expand_data.battle_group.monsters[0],
            root = combatEnemyRoot(enemy.uid),
            generation = s.combat.enemyActivations[root].generation
        const source = s.cultTrial.heroes[0].guid
        f.call('BattleInfoReduce', {
            base_time: '1800000000010',
            uint64_dic: [source, enemy.uid],
            battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -enemy.hp } }],
        })
        s = f.state()
        assert.equal(combatEntityStates(s.combat)[enemy.uid].hp, 0)
        f.store.transact(f.session.id, 0, (state) => {
            delete state.combat.entities[enemy.uid]
            ensureCultTrialScene(f.tables, state, 1800000001)
        })
        assert.equal(combatEntityStates(f.state().combat)[enemy.uid].hp, 0)
        assert.equal(f.state().combat.enemyActivations[root].generation, generation)
    } finally {
        f.store.close()
    }
})

test('current sparse6230 stage route advances only its three hostile groups while friendly groups remain alive', () => {
    const f = fixture('current-sparse6230')
    try {
        enterStory(f, 218)
        let s = f.state()
        assert.deepEqual(s.storyCampaign.scenes, [6230])
        assert.equal(s.storyCampaign.stage_conditions, true)
        const friendly = Object.values(s.combat.entities)
            .filter((e) => f.tables.find('enemy_pack', e.pack_id)?.ECampType === 2)
            .map((e) => e.uuid)
        assert(friendly.length > 0)
        for (const objectId of [1500118, 1500140, 1500141]) {
            const row = f.state().worldObjects['6230:' + objectId]
            assert.equal(row.active, true)
            for (const monster of row.expand_data.battle_group.monsters) hit(f, monster.uid, -monster.hp)
        }
        s = f.state()
        assert.equal(s.storyCampaign.status, 3)
        assert.equal(s.storyCampaign.stage_index, 3)
        assert(
            friendly.every((id) => s.combat.entities[id]?.hp > 0),
            'friendly preview actors are never required as enemy victory proof',
        )
        assert.equal(s.storyCampaignClears[10070].count, 1)
        const exp = s.player.basic_info.exp
        f.call('EndDungeonScene', { result: 3 })
        assert.equal(f.state().player.basic_info.exp, exp)
        f.call('CampaignQuit')
        assert(!f.state().storyCampaign)
    } finally {
        f.store.close()
    }
})

test('current local-playable10074 creates its real scene and roster, accepts62071 once and clears only run facts on exit', () => {
    const f = fixture('current-full10074')
    try {
        enterStory(f, 222)
        let s = f.state()
        assert.equal(s.world.map_id, 6226)
        assert.deepEqual(s.storyCampaign.local_playable_condition, [2525, 62071, 1])
        const owned = structuredClone(s.player.heros_info.heros),
            bag = structuredClone(s.player.sbag_infos)
        f.call('TrialGroupChange', { open: true, trial_id: 6226 })
        assert.equal(f.state().trialGroup.current_group_id, 6226)
        f.call('StartDungeonClientOk')
        f.call('ClientBehaviourRecord', { key: 1004, args: [s.storyCampaign.opening_story, 1] })
        f.call('PlayableStart', { u32: 62071 })
        f.call('PlayableStep', { playId: 62071, is_step: true, finish_step: 1 })
        f.call('PlayableFinish', { playId: 62071, score: 0 })
        s = f.state()
        assert.equal(s.storyCampaign.status, 3)
        assert.equal(s.storyCampaignClears[10074].count, 1)
        const exp = s.player.basic_info.exp
        f.call('PlayableFinish', { playId: 62071, score: 0 })
        assert.equal(f.state().player.basic_info.exp, exp)
        f.reconnect()
        assert.equal(f.state().storyCampaign.status, 3)
        f.call('ClientBehaviourRecord', { key: 1004, args: [f.state().storyCampaign.ending_story, 1] })
        f.call('CampaignQuit')
        s = f.state()
        assert(!s.storyCampaign)
        assert(!s.trialGroup)
        assert.equal(s.playableRuns?.[62071], undefined)
        assert.deepEqual(s.player.heros_info.heros, owned)
        assert.deepEqual(s.player.sbag_infos, bag)
    } finally {
        f.store.close()
    }
})

test('actual legacy6200 first wave still advances the next group and keeps dead metadata before an abort reset', () => {
    const f = fixture('current-legacy6200')
    try {
        enterStory(f, 200)
        let s = f.state()
        assert.equal(s.world.map_id, 6200)
        assert.equal(s.storyCampaign.stage_conditions, false)
        const first = s.worldObjects['6200:1500002']
        assert(first.active)
        for (const monster of first.expand_data.battle_group.monsters) hit(f, monster.uid, -monster.hp)
        s = f.state()
        assert.equal(s.storyCampaign.stage_index, 1)
        assert.equal(s.worldObjects['6200:1500002'].active, false)
        assert(s.worldObjects['6200:1500002'].expand_data.battle_group.monsters.every((m) => m.hp === 0))
        assert.deepEqual(s.worldObjects['6200:1500002'].expand_data.battle_group.world_indexes, [])
        assert.equal(s.worldObjects['6200:1500004'].active, true)
        assert(s.worldObjects['6200:1500004'].expand_data.battle_group.monsters.every((m) => m.hp > 0))
        f.call('CampaignQuit')
        assert(!f.state().storyCampaign)
        assert.equal(f.state().storyCampaignClears?.[10010], undefined)
    } finally {
        f.store.close()
    }
})

test('same-second quit/reentry with the same UUID and pack rejects a late previous-run millisecond report', () => {
    const f = fixture('current-same-second-reentry')
    try {
        enterStory(f, 219)
        f.call('TaskClientBefore', { task_id: 500018, node_id: 2 })
        const enemy = f.state().worldObjects['6207:600001'].expand_data.battle_group.monsters[0]
        const source = f.state().player.heros_info.heros.find((h) => h.type === 1).guid
        const oldFrame = {
            base_time: String(f.now() * 1000 + 500),
            uint64_dic: [source, enemy.uid],
            battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -enemy.hp } }],
        }
        f.call('BattleInfoReduce', oldFrame)
        assert.equal(combatEntityStates(f.state().combat)[enemy.uid].hp, 0)
        f.call('CampaignQuit')
        enterStory(f, 219)
        const fresh = f.state().worldObjects['6207:600001'].expand_data.battle_group.monsters[0]
        assert.equal(fresh.uid, enemy.uid)
        assert.equal(fresh.enemy_pack, enemy.enemy_pack)
        assert(fresh.hp > 0)
        f.call('BattleInfoReduce', oldFrame)
        assert.equal(
            combatEntityStates(f.state().combat)[enemy.uid].hp,
            fresh.hp,
            'accepted prior-run timestamp must survive the deleted battle context as a barrier',
        )
        const activation = f.state().combat.enemyActivations[combatEnemyRoot(enemy.uid)]
        f.call('BattleInfoReduce', { ...oldFrame, base_time: String(BigInt(activation.activatedAtMs) + 1n) })
        assert.equal(
            combatEntityStates(f.state().combat)[enemy.uid].hp,
            0,
            'fresh same-pack actor remains damageable by a genuinely new report',
        )
    } finally {
        f.store.close()
    }
})
