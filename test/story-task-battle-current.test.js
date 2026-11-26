import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Tables, seedPlayer } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { refreshTaskProgress, TaskGraphs, makeNode } from '../src/tasks.js'
import { deliveryKey } from '../src/task-delivery.js'

const config = configuration(),
    tables = new Tables(config.tables)
function fixture(name) {
    const protocol = new Protocol(config.base),
        store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => Math.floor(nowMs / 1000) }),
        session = {}
    let nowMs = 1800000000000,
        sequence = 1
    const call = (name, value = {}) => {
        const row = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, {
            id: row.id,
            seq: sequence++,
            payload: row.req ? protocol.encode(row.req, value) : Buffer.alloc(0),
        })
    }
    // Qualified independent chapter-entry profile, before its first real
    // login. No internal500030 progress, death, watch or clear is inserted.
    store.login(name, (id, openId) => {
        const state = seedPlayer(tables, id, openId),
            prior = new Set(),
            levels = []
        function visit(taskId) {
            const row = tables.find('task', taskId)
            assert(row, 'current prerequisite is missing')
            for (const part of String(row.unlockcondition).split('|')) {
                const [kind, target] = part.split('#').map(Number)
                if (kind === 2004) levels.push(target)
                if (kind === 2007 && !prior.has(target)) {
                    prior.add(target)
                    visit(target)
                }
            }
        }
        visit(106022)
        assert.equal(prior.size, 18)
        assert(!prior.has(106022) && !prior.has(500030))
        state.taskRecords = [...prior].map((task_id) => ({ task_id, count: 1, time: 1 }))
        state.player.basic_info.lv = Math.max(state.player.basic_info.lv, ...levels)
        const graph = new TaskGraphs(tables).get(106022),
            finished = new Set(),
            parent = graph.nodes.get(10),
            entrance = tables.find(
                'world_borthpos',
                parent.__type_TaskConditionNodeData.conditionList[0].__type_TaskConditionBaseData.mapData.birthId,
            )
        function predecessor(nodeId) {
            if (nodeId === graph.start) return
            for (const previous of graph.nodes.get(nodeId).prevNodeIdList ?? []) {
                assert(graph.nodes.has(previous), 'current non-start predecessor is missing')
                if (finished.has(previous)) continue
                finished.add(previous)
                predecessor(previous)
            }
        }
        predecessor(10)
        assert.equal(entrance.id, 10054)
        Object.assign(state.world, tables.position(entrance))
        state.tasks = [
            {
                task_id: 106022,
                nodes: [makeNode(graph, 10, state)],
                finish_nodes: [...finished],
                reward_nodes: [],
                client_trace: true,
            },
        ]
        return state
    })
    call('EnterGame', { open_id: name })
    assert.equal(store.load(session.id).state.world.map_id, 100)
    call('TaskClientBefore', { task_id: 106022, node_id: 10 })
    call('CampaignCreate', { group_id: 203, difficulty: 1 })
    call('StartDungeonClientOk')
    call('TaskClientBefore', { task_id: 500030, node_id: 2 })
    const state = () => store.load(session.id).state,
        internal = () => state().tasks.find((row) => row.task_id === 500030),
        boss = () => Object.values(state().combat.entities).find((row) => row.object_id === 1500000)
    assert.equal(state().world.map_id, 6214)
    assert.equal(state().storyCampaign.map_id, 6214)
    assert(state().storyCampaign.task_ids.includes(500030))
    assert.equal(state().worldObjects['6214:1500000'].active, true)
    assert(boss().hp > 0)
    const hurt = (amount) => {
        const source = state().player.heros_info.heros.find((row) => row.type === 1 && !row.trail).guid
        return call('BattleInfoReduce', {
            base_time: String(++nowMs),
            uint64_dic: [source, boss().uuid],
            battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -amount } }],
        })
    }
    return { protocol, store, session, call, state, internal, boss, hurt }
}
const witness = (state) => state.taskEvents?.[deliveryKey(state, 500030, 2, 0)] ?? 0

test('real203/6214 entry records map0 dungeon task victory only after its active configured boss actually dies', () => {
    const f = fixture('current-story-task-map0')
    try {
        const hp = f.boss().hp
        f.hurt(1)
        assert.equal(f.boss().hp, hp - 1)
        assert.equal(f.boss().alive_state ?? 0, 0)
        assert.equal(witness(f.state()), 0)
        const partial = f.state()
        assert.throws(
            () => f.call('TaskClientCondAfter', { task_id: 500030, node_id: 2, indexes: [0] }),
            /Server task condition not complete/,
        )
        assert.deepEqual(f.state(), partial)
        f.hurt(f.boss().hp)
        assert.equal(f.boss().hp, 0)
        assert.equal(f.boss().alive_state, 1)
        assert.equal(witness(f.state()), 1)
        assert.equal(f.internal().nodes[0].node_values[0], 1)
        f.call('TaskClientCondAfter', { task_id: 500030, node_id: 2, indexes: [0] })
        assert.equal(f.internal().nodes[0].client_cond_after[0], true)
        f.call('TaskClientAfter', { task_id: 500030, node_id: 2 })
        assert.deepEqual(
            f.internal().nodes.map((row) => row.node_id),
            [3],
        )
        // This case does not send TaskFinish or ending6060. It proves the task
        // witness/ack chain and leaves final campaign settlement pending.
        assert.equal(f.state().storyCampaign.status, 2)
        assert.equal(f.state().storyCampaignClears?.[10022], undefined)
    } finally {
        f.store.close()
    }
})

function graphView(sceneId) {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-story-battle-map-')),
        directory = path.join(temporary, 'Config/Task'),
        graph = JSON.parse(fs.readFileSync(path.resolve(tables.dir, '../Config/Task/ast_task_client_500030.json')))
    fs.mkdirSync(directory, { recursive: true })
    // Controlled graph-data mismatch for the explicit-map negative/control;
    // every table and enemy roster still comes from the actual current source.
    if (sceneId !== undefined)
        graph.nodes.find(
            (row) => row.__type_TaskBaseNodeData.id === 2,
        ).__type_TaskBaseNodeData.__type_TaskConditionNodeData.conditionList[0].__type_TaskConditionBaseData.mapData.sceneId =
            sceneId
    fs.writeFileSync(path.join(directory, 'ast_task_client_500030.json'), JSON.stringify(graph))
    return {
        tables: { dir: path.join(temporary, 'Tables'), get: tables.get.bind(tables), find: tables.find.bind(tables) },
        close() {
            assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()))
            assert(path.basename(temporary).startsWith('lurukaps-story-battle-map-'))
            fs.rmSync(temporary, { recursive: true, force: true })
        },
    }
}
function unwitnessed(snapshot) {
    const state = structuredClone(snapshot)
    state.tasks = state.tasks.filter((row) => row.task_id === 500030)
    delete state.taskEvents[deliveryKey(state, 500030, 2, 0)]
    const node = state.tasks[0].nodes[0]
    node.node_values = [0]
    node.client_cond_after = [false]
    return state
}

test('map0 binding refuses foreign declared membership, wrong run map/scenes, inactive run and ordinary scope; explicit maps keep their contract', () => {
    const f = fixture('current-story-task-map-scope'),
        views = [graphView(), graphView(6215), graphView(6214)]
    try {
        f.hurt(f.boss().hp)
        assert.equal(f.boss().hp, 0)
        const snapshot = f.state()
        for (const change of [
            (s) => {
                s.storyCampaign.task_ids = []
            },
            (s) => {
                s.storyCampaign.dungeon_id = 10010
            },
            (s) => {
                s.storyCampaign.map_id = 6215
            },
            (s) => {
                s.storyCampaign.scenes = [6215]
            },
            (s) => {
                s.storyCampaign.status = 3
            },
            (s) => {
                delete s.storyCampaign
            },
        ]) {
            const state = unwitnessed(snapshot)
            change(state)
            refreshTaskProgress(views[0].tables, state)
            assert.equal(witness(state), 0)
            assert.equal(state.tasks[0].nodes[0].node_values[0], 0)
        }
        const wrong = unwitnessed(snapshot)
        refreshTaskProgress(views[1].tables, wrong)
        assert.equal(witness(wrong), 0, 'explicit wrong map must not inherit dungeon context')
        const ordinary = unwitnessed(snapshot)
        delete ordinary.storyCampaign
        refreshTaskProgress(views[2].tables, ordinary)
        assert.equal(witness(ordinary), 1, 'existing explicit correct-map behavior must remain available')
    } finally {
        for (const view of views) view.close()
        f.store.close()
    }
})

test('task-sync and condition-ACK codec failures roll back actual HP, implicit-map witness and saved progress', () => {
    const f = fixture('current-story-task-map-codec'),
        original = f.protocol.encode
    try {
        const response = f.protocol.byName.get('CSProtoTaskSync').rsp,
            before = f.state(),
            sql = f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id)
        f.protocol.encode = function (name, ...args) {
            if (name === response) throw Error('story-task-sync-codec')
            return original.call(this, name, ...args)
        }
        assert.throws(() => f.hurt(f.boss().hp), /story-task-sync-codec/)
        assert.deepEqual(f.state(), before)
        assert.deepEqual(
            f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
            sql,
        )
        f.protocol.encode = original
        f.hurt(f.boss().hp)
        assert.equal(f.boss().hp, 0)
        assert.equal(witness(f.state()), 1)
        const beforeAck = f.state(),
            ack = f.protocol.byName.get('CSProtoTaskClientCondAfter').rsp
        f.protocol.encode = function (name, ...args) {
            if (name === ack) throw Error('story-task-ack-codec')
            return original.call(this, name, ...args)
        }
        assert.throws(
            () => f.call('TaskClientCondAfter', { task_id: 500030, node_id: 2, indexes: [0] }),
            /story-task-ack-codec/,
        )
        assert.deepEqual(f.state(), beforeAck)
        f.protocol.encode = original
        f.call('TaskClientCondAfter', { task_id: 500030, node_id: 2, indexes: [0] })
        assert.equal(f.internal().nodes[0].client_cond_after[0], true)
    } finally {
        f.protocol.encode = original
        f.store.close()
    }
})
