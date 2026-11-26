// LOCAL current-source compatibility; official fourth-parameter semantics remain TODO.
import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables, seedPlayer } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'
import * as model from '../src/story-campaign-story-receipts.js'
import * as taskModel from '../src/tasks.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables)

function fixture(name, { prewatch = false } = {}) {
    const protocol = new Protocol(cfg.base),
        store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => Math.floor(nowMs / 1000) })
    let session = {},
        sequence = 1,
        nowMs = 1800000000000
    const call = (name, value = {}) => {
        const row = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, {
            id: row.id,
            seq: sequence++,
            payload: row.req ? protocol.encode(row.req, value) : Buffer.alloc(0),
        })
    }
    // Coherent independent chapter-entry baseline, installed before the first
    // real login. Derive prerequisites from current tables so a reconnect
    // cannot legitimately reaccept an unfinished prologue and move to102.
    store.login(name, (id, openId) => {
        const s = seedPlayer(tables, id, openId),
            prior = new Set(),
            levels = []
        function visit(taskId) {
            const row = tables.find('task', taskId)
            assert(row, 'missing current prerequisite')
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
        s.taskRecords = [...prior].map((task_id) => ({ task_id, count: 1, time: 1 }))
        s.player.basic_info.lv = Math.max(s.player.basic_info.lv, ...levels)
        const graph = new taskModel.TaskGraphs(tables).get(106022),
            finished = new Set(),
            parent = graph.nodes.get(10),
            entrance = tables.find(
                'world_borthpos',
                parent.__type_TaskConditionNodeData.conditionList[0].__type_TaskConditionBaseData.mapData.birthId,
            )
        function predecessor(nodeId) {
            if (nodeId === graph.start) return
            for (const previous of graph.nodes.get(nodeId).prevNodeIdList ?? []) {
                assert(graph.nodes.has(previous))
                if (finished.has(previous)) continue
                finished.add(previous)
                predecessor(previous)
            }
        }
        predecessor(10)
        assert.equal(entrance.id, 10054)
        Object.assign(s.world, tables.position(entrance))
        s.tasks = [
            {
                task_id: 106022,
                nodes: [taskModel.makeNode(graph, 10, s)],
                finish_nodes: [...finished],
                reward_nodes: [],
                client_trace: true,
            },
        ]
        return s
    })
    call('EnterGame', { open_id: name })
    if (prewatch) call('SetStoryId', { story_id: 101575, story_type: 0, tag: 0, is_skip: false })
    call('TaskClientBefore', { task_id: 106022, node_id: 10 })
    const state = () => store.load(session.id).state,
        boss = () => Object.values(state().combat.entities).find((row) => row.object_id === 1500000),
        enter = () => {
            call('CampaignCreate', { group_id: 203, difficulty: 1 })
            call('StartDungeonClientOk')
            call('TaskClientBefore', { task_id: 500030, node_id: 2 })
            assert.equal(state().world.map_id, 6214)
            assert.equal(state().worldObjects['6214:1500000'].active, true)
        },
        kill = () => {
            const source = state().player.heros_info.heros.find((row) => row.type === 1 && !row.trail).guid,
                hp = boss().hp
            assert(hp > 0)
            call('BattleInfoReduce', {
                base_time: String(++nowMs),
                uint64_dic: [source, boss().uuid],
                battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -hp } }],
            })
            assert.equal(boss().hp, 0)
            assert.equal(boss().alive_state, 1)
        },
        prepareFinish = () => {
            call('TaskClientCondAfter', { task_id: 500030, node_id: 2, indexes: [0] })
            call('TaskClientAfter', { task_id: 500030, node_id: 2 })
            assert.deepEqual(
                state()
                    .tasks.find((row) => row.task_id === 500030)
                    .nodes.map((row) => row.node_id),
                [3],
            )
        },
        end = (is_skip = false) => call('SetStoryId', { story_id: 101575, story_type: 0, tag: 0, is_skip })
    enter()
    return {
        protocol,
        store,
        game,
        call,
        state,
        boss,
        enter,
        kill,
        prepareFinish,
        end,
        edit: (fn) => store.transact(session.id, 0, fn),
        reload: () => {
            session = {}
            return call('EnterGame', { open_id: name, reconnect: true })
        },
        sql: () => store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(session.id),
    }
}
const finishedInternal = (f) => f.state().taskRecords?.find((row) => row.task_id === 500030)?.count ?? 0
const experience = (f) => f.state().player.basic_info.exp

test('LOCAL2506 actual task completion commits before ending6060, then earns one typed clear and parent12017 proof', () => {
    const f = fixture('candidate-story2506-task-first')
    try {
        f.kill()
        f.prepareFinish()
        const before = experience(f)
        f.call('TaskFinish', { u32: 500030 })
        assert.equal(finishedInternal(f), 1)
        assert.equal(f.state().storyCampaign.status, 2)
        assert.equal(f.state().storyCampaign.story_victory_receipt, undefined)
        assert.equal(f.state().storyCampaignClears?.[10022], undefined)
        f.end()
        assert.equal(f.state().storyCampaign.status, 3)
        assert.equal(experience(f), before + tables.find('dungeon', 10022).userExp)
        const clear = f.state().storyCampaignClears[10022]
        assert.equal(clear.task_proof, undefined)
        assert.equal(clear.story_proof.kind, 2506)
        assert.deepEqual(clear.story_proof.task_ids, [500030])
        assert.equal(taskModel.hasVerifiedTaskDungeonClear(tables, f.state(), 10022), true)
        for (let i = 0; i < 2; i++) {
            f.end()
            f.call('EndDungeonScene', { result: 3 })
        }
        assert.equal(f.state().storyCampaignClears[10022].count, 1)
        assert.equal(experience(f), before + tables.find('dungeon', 10022).userExp)
        f.call('CampaignQuit')
        assert.equal(f.state().storyCampaign, undefined)
        assert.equal(taskModel.hasVerifiedTaskDungeonClear(tables, f.state(), 10022), true)
        f.call('TaskClientCondAfter', { task_id: 106022, node_id: 10, indexes: [0] })
        assert.equal(f.state().tasks.find((row) => row.task_id === 106022).nodes[0].client_cond_after[0], true)
    } finally {
        f.store.close()
    }
})

test('LOCAL2506 actual ending6060 receipt survives reconnect while real task is pending; skip is completion metadata', () => {
    const f = fixture('candidate-story2506-story-first')
    try {
        f.kill()
        // Deliberate protocol-level skip vector. The current101575 UI itself
        // disables skipping; this does not claim that UI offers a skip button.
        f.end(true)
        const receipt = f.state().storyCampaign.story_victory_receipt
        assert.equal(receipt.is_skip, true)
        assert.equal(f.state().storyWatches['101575:0:0'].full_watch, false)
        assert.equal(f.state().storyCampaign.status, 2)
        f.reload()
        assert.deepEqual(f.state().storyCampaign.story_victory_receipt, receipt)
        assert.equal(f.state().world.map_id, 6214)
        assert.equal(f.boss().hp, 0)
        f.prepareFinish()
        f.call('TaskFinish', { u32: 500030 })
        assert.equal(f.state().storyCampaign.status, 3)
        assert.equal(f.state().storyCampaignClears[10022].story_proof.receipt.is_skip, true)
    } finally {
        f.store.close()
    }
})

test('LOCAL2506 global old watches do not create a receipt in either the first or next active instance', () => {
    const f = fixture('candidate-story2506-old-watch', { prewatch: true })
    try {
        assert(f.state().storyIds.includes(101575))
        assert.equal(f.state().storyCampaign.story_victory_receipt, undefined)
        f.kill()
        f.prepareFinish()
        f.call('TaskFinish', { u32: 500030 })
        assert.equal(f.state().storyCampaign.status, 2)
        f.end()
        const first = f.state().storyCampaign.story_victory_receipt.scope.instance_id,
            earned = experience(f)
        f.call('CampaignQuit')
        f.enter()
        assert.notEqual(f.state().storyCampaign.instance_id, first)
        assert.equal(f.state().storyCampaign.story_victory_receipt, undefined)
        f.kill()
        f.prepareFinish()
        f.call('TaskFinish', { u32: 500030 })
        assert.equal(f.state().storyCampaign.status, 2)
        f.end()
        assert.equal(f.state().storyCampaign.status, 3)
        assert.equal(experience(f), earned, 'existing first-clear experience must not be granted again')
        assert.notEqual(f.state().storyCampaignClears[10022].story_proof.receipt.scope.instance_id, first)
    } finally {
        f.store.close()
    }
})

test('LOCAL2506 wrong story/type/tag cannot issue a receipt, unsupported shapes close, copied scope is rejected', () => {
    const f = fixture('candidate-story2506-scope')
    try {
        for (const value of [
            { story_id: 101573, story_type: 0, tag: 0 },
            { story_id: 101575, story_type: 1, tag: 0 },
            { story_id: 101575, story_type: 0, tag: 1 },
        ]) {
            f.call('SetStoryId', value)
            assert.equal(f.state().storyCampaign.story_victory_receipt, undefined)
        }
        const original = tables.find('dungeon', 10022)
        for (const condition of ['2506#101575#1#1', '2506#101575#0#2', '2506#101575#0#1#1']) {
            const view = {
                get: tables.get.bind(tables),
                find: (name, id) =>
                    name === 'dungeon' && id === original.id
                        ? { ...original, victoryCondition: condition }
                        : tables.find(name, id),
            }
            assert.throws(
                () => model.storyCampaignStoryRule(view, original.id),
                (error) => error.code === ErrorCode.FunctionClosed,
            )
        }
        assert.equal(tables.get('dungeon_task').find((row) => row.dungeonId === original.id).autoExit, 0)
        const autoExitView = {
            find: tables.find.bind(tables),
            get: (name) =>
                name === 'dungeon_task'
                    ? tables.get(name).map((row) => (row.dungeonId === original.id ? { ...row, autoExit: 1 } : row))
                    : tables.get(name),
        }
        assert.throws(
            () => model.storyCampaignStoryRule(autoExitView, original.id),
            (error) => error.code === ErrorCode.FunctionClosed,
        )
        f.end()
        // Explicit corruption negative only, never a successful receipt setup.
        f.edit((s) => {
            s.storyCampaign.story_victory_receipt.scope.instance_id++
        })
        const before = f.state()
        assert.throws(
            () => f.end(),
            (error) => error.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})

test('CANDIDATE6060 campaign-sync codec failure rolls back actual watch, scoped receipt, clear and experience', () => {
    const f = fixture('candidate-story2506-story-codec'),
        original = f.protocol.encode
    try {
        f.kill()
        f.prepareFinish()
        f.call('TaskFinish', { u32: 500030 })
        const before = f.state(),
            sql = f.sql(),
            response = f.protocol.byName.get('CSProtoCampaignInfoSync').rsp
        f.protocol.encode = function (name, ...args) {
            if (name === response) throw Error('candidate-story-clear-codec')
            return original.call(this, name, ...args)
        }
        assert.throws(() => f.end(), /candidate-story-clear-codec/)
        assert.deepEqual(f.state(), before)
        assert.deepEqual(f.sql(), sql)
        f.protocol.encode = original
        f.end()
        assert.equal(f.state().storyCampaign.status, 3)
    } finally {
        f.protocol.encode = original
        f.store.close()
    }
})

test('LOCAL2506 finalTask ACK codec failure retains the legitimate pending story receipt and can retry', () => {
    const f = fixture('candidate-story2506-task-codec'),
        original = f.protocol.encode
    try {
        f.kill()
        f.end()
        f.prepareFinish()
        const before = f.state(),
            sql = f.sql(),
            response = f.protocol.byName.get('CSProtoTaskFinish').rsp
        f.protocol.encode = function (name, ...args) {
            if (name === response) throw Error('candidate-final-task-codec')
            return original.call(this, name, ...args)
        }
        assert.throws(() => f.call('TaskFinish', { u32: 500030 }), /candidate-final-task-codec/)
        assert.deepEqual(f.state(), before)
        assert.deepEqual(f.sql(), sql)
        f.protocol.encode = original
        f.call('TaskFinish', { u32: 500030 })
        assert.equal(f.state().storyCampaign.status, 3)
        f.reload()
        assert.equal(taskModel.hasVerifiedTaskDungeonClear(tables, f.state(), 10022), true)
    } finally {
        f.protocol.encode = original
        f.store.close()
    }
})
