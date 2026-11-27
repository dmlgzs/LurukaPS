import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { TaskGraphs, makeNode } from '../src/tasks.js'
import { grantRewards } from '../src/rewards.js'
import { ErrorCode } from '../src/error-codes.js'
const config = configuration(),
    tables = new Tables(config.tables),
    protocol = new Protocol(config.base),
    graphs = new TaskGraphs(tables)

// Qualified already-selected/finished/page-closed recovery fixture,not
// normal earned progression or evidence that a real Unity page was closed.
function fixture(step) {
    const source = graphs.get(106010).nodes.get(148)
    const group =
        source.__type_TaskConditonBranchNodeData.conditionList[step - 1].__type_TaskConditionBaseData
            .__type_TaskCondPetCheckData.petId
    const branch = source.nextNodeIdList[step - 1],
        drop = new Map(
            tables
                .find('playable', 60001)
                .stepRewards.split('|')
                .map((token) => token.split('#').map(Number)),
        ).get(step),
        reward = tables.get('drop').filter((row) => row.dropId === drop)
    assert.equal(reward.length, 1)
    assert.equal(reward[0].type, 30)
    const customized = reward[0].itemId
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => 1800000000 })
    let session = {},
        seq = 1
    const call = (name, data = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, data) })
    }
    const login = () => {
        session = {}
        return call('EnterGame', { open_id: 'current-page-recovery-' + step })
    }
    login()
    store.transact(session.id, 0, (state) => {
        state.world.map_id = 100
        state.taskRecords = [
            { task_id: 106001, count: 1, time: 1 },
            { task_id: 106002, count: 1, time: 2 },
            { task_id: 106009, count: 1, time: 3 },
        ]
        state.taskEpochs[106010] = 1
        state.tasks = [
            {
                task_id: 106010,
                nodes: [{ ...makeNode(graphs.get(106010), branch, state), client_before: true }],
                finish_nodes: [151, 148],
                reward_nodes: [],
            },
        ]
        const pet = grantRewards(tables, state, [{ itemtype: 30, itemid: customized, itemnum: 1 }])[0]
        const selection = { selected_step: step, selected_pet_group: group, selected_pet_guid: pet.guid }
        state.playableRuns = {
            60001: {
                play_id: 60001,
                map_id: 100,
                finish_step: 10,
                sub_datas: [],
                status: 3,
                time: 1799999900,
                ...selection,
            },
        }
        state.playableFinishes = { 60001: { play_id: 60001, map_id: 100, score: 0, reward_info: 0, ...selection } }
        state.playableChoiceReceipts = {
            '106010:1:60001': { step, drop_id: drop, pet_guid: pet.guid, pet_group: group },
        }
        state.taskPetChoices = { 106010: group }
    })
    const state = () => store.load(session.id).state
    const node = () => state().tasks.find((task) => task.task_id === 106010).nodes[0]
    const failed = () => store.log.run(session.id, 9404, 'error:' + ErrorCode.InvalidArgument, 1799999901000)
    return { store, call, login, state, node, failed, group, branch, id: () => session.id }
}

for (const step of [1, 2, 3])
    test(`current pet choice${step} restores only its source-selected closed page after a logged failed finish`, () => {
        const f = fixture(step)
        try {
            f.login()
            assert.equal(f.node().node_values[0], 0)
            const before = f.state(),
                count = before.pets.length
            f.failed()
            const packets = f.login()
            assert.equal(f.node().node_id, f.branch)
            assert.equal(f.node().node_values[0], 1)
            assert.equal(f.node().client_cond_after[0], false)
            assert.equal(f.state().pets.length, count)
            assert.deepEqual(f.state().playableFinishes, before.playableFinishes)
            const sync = protocol.decode(
                protocol.byId.get(9853).rsp,
                packets.find((packet) => packet.id === 9853).payload,
            )
            assert.equal(sync.tasks.find((task) => task.task_id === 106010).nodes[0].node_values[0], 1)
            assert(
                f.state().tasks.find((task) => task.task_id === 106010).nodes[0].node_id === f.branch,
                'Recovery does not run CondAfter/After or the following story',
            )
            const settled = f.state()
            f.login()
            assert.deepEqual(f.node(), settled.tasks.find((task) => task.task_id === 106010).nodes[0])
            assert.equal(f.state().pets.length, count)
        } finally {
            f.store.close()
        }
    })
for (const [step, previous] of [
    [1, 52],
    [2, 55],
    [3, 56],
])
    test(`consistent historical choice group${previous} migrates from owned current pet facts without new assets`, () => {
        const f = fixture(step)
        try {
            f.store.transact(f.id(), 0, (state) => {
                state.taskPetChoices[106010] = previous
                state.playableRuns[60001].selected_pet_group = previous
                state.playableFinishes[60001].selected_pet_group = previous
                state.playableChoiceReceipts['106010:1:60001'].pet_group = previous
            })
            const before = f.state()
            f.failed()
            f.login()
            assert.equal(f.node().node_id, f.branch)
            assert.equal(f.node().node_values[0], 1)
            assert.equal(f.state().taskPetChoices[106010], f.group)
            assert.equal(f.state().playableChoiceReceipts['106010:1:60001'].pet_group, f.group)
            assert.deepEqual(f.state().pets, before.pets)
            assert.deepEqual(f.state().player.sbag_infos, before.player.sbag_infos)
            assert.equal(f.state().compatibilityDiagnostics.petChoiceGroups['106010:60001'].previous, previous)
        } finally {
            f.store.close()
        }
    })
test('current closed-page recovery rejects a mismatching selected receipt and a different active branch', () => {
    for (const mismatch of ['receipt', 'branch']) {
        const f = fixture(1)
        try {
            f.store.transact(f.id(), 0, (state) => {
                if (mismatch === 'receipt') state.playableChoiceReceipts['106010:1:60001'].pet_group = 4
                else state.tasks[0].nodes = [{ ...makeNode(graphs.get(106010), 182, state), client_before: true }]
            })
            f.failed()
            f.login()
            assert.equal(f.node().node_values[0], 0)
        } finally {
            f.store.close()
        }
    }
})
test('current closed-page recovery and assets roll back on task-sync encoding failure,then retry once', () => {
    const f = fixture(2),
        encode = protocol.encode
    try {
        f.failed()
        const before = f.state()
        protocol.encode = function (type, data) {
            if (type === protocol.byId.get(9853).rsp) throw Error('current-pet-page-codec')
            return encode.call(this, type, data)
        }
        assert.throws(() => f.login(), /current-pet-page-codec/)
        assert.deepEqual(f.state(), before)
        protocol.encode = encode
        f.login()
        assert.equal(f.node().node_values[0], 1)
        assert.equal(f.state().pets.length, before.pets.length)
    } finally {
        protocol.encode = encode
        f.store.close()
    }
})
