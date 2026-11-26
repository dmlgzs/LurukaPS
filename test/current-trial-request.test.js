import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { TaskGraphs, makeNode, conditionValue } from '../src/tasks.js'
import { resolveCurrentTrialGroup } from '../src/current-scene-trials.js'
import { currentTrialPetSlots } from '../src/current-trial-request-policy.js'

function fixture(name, map = 6226) {
    const config = configuration(),
        tables = new Tables(config.tables),
        protocol = new Protocol(config.base),
        store = new Store(':memory:'),
        game = new Game(protocol, store, tables)
    let session = {},
        seq = 1
    const call = (name, data = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, {
            id: e.id,
            seq: seq++,
            payload: e.req ? protocol.encode(e.req, data) : Buffer.alloc(0),
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
        s.world.map_id = map
    })
    return {
        tables,
        protocol,
        store,
        game,
        call,
        edit,
        state,
        reconnect: () => {
            session = {}
            return call('EnterGame', { open_id: name, reconnect: true })
        },
    }
}

test('current5987 open/trial_id derives the6226 hero/pet roster, syncs real actors and closes without client arrays', () => {
    const f = fixture('trial-current6226')
    try {
        const before = f.state().player,
            roster = resolveCurrentTrialGroup(f.tables, 6226)
        const packets = f.call('TrialGroupChange', { open: true, trial_id: 6226 }),
            s = f.state()
        assert.equal(s.trialGroup.current_group_id, 6226)
        assert.deepEqual(
            s.trialGroup.ids,
            roster.heroes.map((h) => h.id),
        )
        assert.equal(s.player.group_mgrs[0].cur_group, 0)
        assert(s.trialGroup.pets.length > 0)
        const data = f.protocol.byName.get('CSProtoTrialDatas'),
            attrs = f.protocol.byName.get('CSProtoHeroAttrInfoSync')
        assert(packets.find((p) => p.id === data.id))
        assert(packets.find((p) => p.id === attrs.id))
        assert(packets.find((p) => p.id === 5987))
        assert(packets.findIndex((p) => p.id === data.id) < packets.findIndex((p) => p.id === 5987))
        assert.deepEqual(s.player.heros_info.heros, before.heros_info.heros)
        const existing = f.state().trialGroup.heroes.map((h) => h.guid)
        f.call('TrialGroupChange', { open: true, trial_id: 6226 })
        assert.deepEqual(
            f.state().trialGroup.heroes.map((h) => h.guid),
            existing,
        )
        f.call('TrialGroupChange', { open: false })
        assert.equal(f.state().trialGroup, undefined)
        assert.deepEqual(f.state().player.group_mgrs[0].groups, before.group_mgrs[0].groups)
        f.call('TrialGroupChange', { open: false })
    } finally {
        f.store.close()
    }
})

test('current equipped6246 group creates configured ornaments/skills without touching owned inventory and survives login', () => {
    const f = fixture('trial-current6246', 6246)
    try {
        const before = f.state(),
            roster = resolveCurrentTrialGroup(f.tables, 6246)
        const packets = f.call('TrialGroupChange', { open: true, trial_id: 6246 })
        assert.equal(f.state().trialGroup.heroes.length, roster.heroes.length)
        const attr = f.protocol.byName.get('CSProtoHeroAttrInfoSync'),
            payload = f.protocol.decode(attr.rsp, packets.find((p) => p.id === attr.id).payload)
        const modules = payload.heros
            .filter((h) => f.state().trialGroup.heroes.some((t) => t.guid === h.hero_guid))
            .flatMap((h) => h.modules.filter((m) => m.module_type === 2))
        assert(modules.some((m) => m.sub_modules.some((s) => s.attrs.attrs.length > 0)))
        assert(
            modules.some((m) =>
                m.sub_modules.some((s) =>
                    s.skills.skills.some((skill) => [19998208, 19998209].includes(skill.skill_id)),
                ),
            ),
        )
        assert.deepEqual(f.state().ornaments, before.ornaments)
        assert.deepEqual(f.state().player.sbag_infos, before.player.sbag_infos)
        f.reconnect()
        assert.equal(f.state().trialGroup.current_group_id, 6246)
        f.call('TrialGroupChange', { open: false })
        assert.deepEqual(f.state().ornaments, before.ornaments)
    } finally {
        f.store.close()
    }
})

test('wrong current group and injected old arrays fail atomically; current task-controller group expires after scene exit', () => {
    const f = fixture('trial-current-authority')
    try {
        const before = f.state()
        assert.throws(() => f.call('TrialGroupChange', { open: true, trial_id: 6207 }), /not admitted/)
        assert.deepEqual(f.state(), before)
        assert.throws(
            () => f.call('TrialGroupChange', { open: true, trial_id: 6226, trial_heros: [{ pos: 0, id: 107001 }] }),
            /cannot supply/,
        )
        assert.deepEqual(f.state(), before)
        f.edit((s) => {
            s.world.map_id = 102
            // This server runs the ordinary package. Review-only106003 is
            // deliberately quarantined on reconnect, so use its real formal
            // counterpart for the task-controller lifetime assertion.
            s.taskRecords = s.taskRecords.filter((record) => record.task_id !== 106001)
            s.taskEpochs[106001] = 1
            const g = new TaskGraphs(f.tables).get(106001)
            s.tasks = [
                {
                    task_id: 106001,
                    nodes: [{ ...makeNode(g, 5, s), client_before: true }],
                    finish_nodes: [1],
                    reward_nodes: [],
                },
            ]
            s.taskSceneReceipts['106001:1:5'] = true
        })
        f.call('TrialGroupChange', { open: true, trial_id: 1 })
        assert.equal(f.state().trialGroup.current_source, 'task-controller')
        f.reconnect()
        assert.equal(f.state().trialGroup.current_group_id, 1)
        f.edit((s) => {
            s.world.map_id = 100
        })
        f.call('WorldTimeSync', { world_time: 43200 })
        assert.equal(f.state().trialGroup, undefined)
    } finally {
        f.store.close()
    }
})

test('current auto pet maps to the same resolved hero slot; dungeon bool completion never accepts strings', () => {
    const tables = new Tables(configuration().tables),
        roster = resolveCurrentTrialGroup(tables, 3)
    assert.equal(roster.heroes[0].pos, -1)
    assert.equal(roster.pets[0].pos, -1)
    assert.equal(currentTrialPetSlots(roster, new Map([[roster.heroes[0].id, 2]]))[0].pos, 2)
    const state = { storyCampaignClears: { 10071: { count: 1 } } }
    for (const flag of [true, 1])
        assert.equal(
            conditionValue(
                {
                    conditionId: 12017,
                    __type_TaskConditionBaseData: {
                        __type_TaskCondDungeonData: { dungeonId: 10071, isOver: flag, count: 1 },
                    },
                },
                state,
            ),
            1,
        )
    for (const flag of [false, 0, 'true', '1'])
        assert.equal(
            conditionValue(
                {
                    conditionId: 12017,
                    __type_TaskConditionBaseData: {
                        __type_TaskCondDungeonData: { dungeonId: 10071, isOver: flag, count: 1 },
                    },
                },
                state,
            ),
            0,
        )
})
