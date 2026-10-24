import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { materialStoryPlan } from '../src/multiple-material-story.js'
import { ErrorCode } from '../src/error-codes.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const tables = new Tables(configuration().tables),
    protocol = new Protocol(configuration().base)
function fixture(name, store = new Store(':memory:'), initialize = true) {
    let now = 1800000000,
        seq = 1,
        session = {}
    const game = new Game(protocol, store, tables, { clock: () => now })
    const call = (name, r = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, {
            id: e.id,
            seq: seq++,
            payload: e.req ? protocol.encode(e.req, r) : Buffer.alloc(0),
        })
    }
    const login = () => {
        session = {}
        return call('EnterGame', { open_id: name })
    }
    login()
    const edit = (fn) => store.transact(session.id, 0, fn)
    if (initialize)
        edit((s) => {
            s.player.basic_info.lv = 45
            ;(s.taskRecords ??= []).push({ task_id: 106013, count: 1 })
            s.entrust ??= { records: {}, starRewards: {}, nextInstanceId: 1 }
            s.entrust.records[8] = { entrust_id: 8, entrust_star: 1, success_time: String(now) }
            s.player.attr_infos.attrs.find((x) => x.attr_id === 3).attr_val = '500'
        })
    const state = () => store.load(session.id).state,
        run = () => state().entrust?.run
    const start = () => {
        call('MultiCampaignCreate', { dungeon_id: 35750, scene_type: 12 })
        call('MultiCampaignPlayerLoadFinish')
        const p = materialStoryPlan(tables, run())
        edit((s) => {
            s.world.pos = { ...p.pos }
        })
        call('WorldObjInteract', {
            objs: [{ obj: { obj_id: p.marker_id, complete: true, state_data: { step: 0 } }, interact_type: 2 }],
        })
        return p
    }
    const vote = (id = run().materialStory.story_id) => call('WorldVotingStartReq', { type: 1, params: [String(id)] })
    const end = () => call('PlayerStoryStop', { story_id: run().materialStory.story_id, op: 1 })
    return { store, call, login, edit, state, run, start, vote, end, tick: (n) => (now += n), now: () => now }
}
const msg = (packets, name) => {
    const e = protocol.byName.get(name),
        p = packets.find((p) => p.id === e.id)
    return p && protocol.decode(e.rsp, p.payload)
}
test('10850 weekly local Skip sends a packed single-Yes vote, closes it and requests stop, while only real 11271 END opens the boss', () => {
    const f = fixture('local-weekly-story-vote')
    try {
        const plan = f.start(),
            tasks = structuredClone(f.state().tasks),
            packets = f.vote(),
            v = msg(packets, 'SCProtoWorldVotingSync')
        assert.equal(v.type, 1)
        assert.equal(v.voting_num, 1)
        assert.equal(v.voting_val, '3')
        assert.equal(v.curr_voting, 3)
        assert.equal(v.start_sec, String(f.now() * 1000))
        assert.equal(v.duration, 10000)
        assert.ok(v.id > 0)
        assert.equal(msg(packets, 'SCProtoWorldVotingCloseSync').id, v.id)
        assert.equal(msg(packets, 'SCProtoPlayerStoryStop').story_id, plan.story_id)
        const ids = packets.map((p) => p.id)
        assert.ok(
            ids.indexOf(10850) < ids.indexOf(10851) &&
                ids.indexOf(10851) < ids.indexOf(10853) &&
                ids.indexOf(10853) < ids.indexOf(11272),
        )
        assert.equal(f.run().materialStory.phase, 'playing')
        assert.equal(f.run().battle_start_time, undefined)
        assert.equal(f.state().worldObjects[`${plan.map_id}:${plan.boss_id}`].active, true)
        assert.deepEqual(f.state().tasks, tasks)
        f.tick(4)
        f.end()
        assert.equal(f.run().materialStory.phase, 'done')
        assert.equal(f.run().battle_start_time, f.now())
        assert.equal(f.state().worldObjects[`${plan.map_id}:${plan.boss_id}`].active, true)
        const next = f.state().nextLocalStoryVoteId,
            clock = f.run().battle_start_time,
            again = f.vote()
        assert.equal(f.state().nextLocalStoryVoteId, next)
        assert.equal(f.run().battle_start_time, clock)
        assert.ok(!again.some((p) => [10851, 10853, 11272].includes(p.id)))
    } finally {
        f.store.close()
    }
})
test('10850 weekly bound vote receipt survives real SQLite reopen and requires the new connection load barrier before END', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-vote-b24-')),
        file = path.join(folder, 'state.db'),
        stores = []
    try {
        const a = new Store(file)
        stores.push(a)
        const first = fixture('weekly-vote-disk', a)
        first.start()
        const vote = msg(first.vote(), 'SCProtoWorldVotingSync'),
            instance = first.run().instance_id
        a.close()
        const b = new Store(file)
        stores.push(b)
        const second = fixture('weekly-vote-disk', b, false)
        assert.equal(second.run().instance_id, instance)
        assert.equal(second.run().materialStory.skip_vote.id, vote.id)
        assert.throws(
            () => second.vote(),
            (e) => e.code === ErrorCode.InvalidLogic,
        )
        second.call('MultiCampaignPlayerLoadFinish')
        assert.equal(msg(second.vote(), 'SCProtoWorldVotingSync').id, vote.id)
        assert.equal(second.state().nextLocalStoryVoteId, vote.id + 1)
        assert.equal(second.run().battle_start_time, undefined)
        second.end()
        assert.equal(second.run().materialStory.phase, 'done')
    } finally {
        for (const s of stores) if (s.db.open) s.close()
        const resolved = path.resolve(folder)
        assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep))
        fs.rmSync(resolved, { recursive: true, force: true })
    }
})
test('10850 weekly duplicate and reconnect reuse the same bound receipt, and leaving/re-entry cannot reuse the old epoch vote', () => {
    const f = fixture('local-weekly-story-vote-reconnect')
    try {
        const p = f.start(),
            first = msg(f.vote(), 'SCProtoWorldVotingSync'),
            instance = f.run().instance_id
        f.tick(3)
        assert.equal(msg(f.vote(), 'SCProtoWorldVotingSync').id, first.id)
        assert.equal(f.state().nextLocalStoryVoteId, first.id + 1)
        f.store.flushPending()
        f.tick(100)
        f.login()
        assert.throws(
            () => f.vote(),
            (e) => e.code === ErrorCode.InvalidLogic,
        )
        f.call('MultiCampaignPlayerLoadFinish')
        assert.equal(f.run().instance_id, instance)
        assert.equal(f.run().materialStory.skip_vote.id, first.id)
        assert.equal(msg(f.vote(), 'SCProtoWorldVotingSync').id, first.id)
        f.end()
        f.call('CampaignQuit')
        assert.equal(f.run(), undefined)
        assert.throws(
            () => f.vote(p.story_id),
            (e) => e.code === ErrorCode.DungeonNotIn,
        )
        f.start()
        const fresh = msg(f.vote(), 'SCProtoWorldVotingSync')
        assert.ok(fresh.id > first.id)
        assert.ok(f.run().instance_id > instance)
    } finally {
        f.store.close()
    }
})
test('10850 weekly wrong story/type/parameter, unstarted plot, foreign epoch and multiplayer participant lists cannot authorize skipping', () => {
    const f = fixture('local-weekly-story-vote-invalid')
    try {
        f.call('MultiCampaignCreate', { dungeon_id: 35750, scene_type: 12 })
        assert.throws(
            () => f.vote(6110002),
            (e) => e.code === ErrorCode.DungeonNotIn,
        )
        f.call('CampaignQuit')
        const p = f.start()
        let before = f.state()
        for (const req of [
            { type: 1, params: [] },
            { type: 1, params: ['6110002', '1'] },
            { type: 1, params: ['999999'] },
            { type: 0, params: ['6110002'] },
        ])
            assert.throws(
                () => f.call('WorldVotingStartReq', req),
                (e) => e.code === ErrorCode.InvalidArgument,
            )
        assert.throws(
            () => f.call('WorldVotingStartReq', { type: 2, params: [String(p.story_id)] }),
            (e) => e.code === ErrorCode.FunctionClosed,
        )
        assert.deepEqual(f.state(), before)
        f.vote()
        f.edit((s) => {
            s.entrust.run.materialStory.skip_vote.duration_millis = 0
        })
        before = f.state()
        assert.throws(
            () => f.vote(),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
        f.edit((s) => s.entrust.run.materialStory.participants.push(999))
        before = f.state()
        assert.throws(
            () => f.vote(),
            (e) => e.code === ErrorCode.FunctionClosed,
        )
        assert.deepEqual(f.state(), before)
        f.edit((s) => {
            s.entrust.run.materialStory.participants = [s.player.basic_info.id]
            s.entrust.run.materialStory.instance_id++
        })
        before = f.state()
        assert.throws(
            () => f.vote(),
            (e) => e.code === ErrorCode.InvalidLogic,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})
test('10850 weekly either vote-state, close-state or story-stop codec failure restores receipt, sequence allocation and all run state', () => {
    const f = fixture('local-weekly-story-vote-codec')
    try {
        f.start()
        for (const name of ['SCProtoWorldVotingSync', 'SCProtoWorldVotingCloseSync', 'SCProtoPlayerStoryStop']) {
            const before = f.state(),
                old = protocol.encode
            protocol.encode = function (type, r) {
                if (type === protocol.byName.get(name).rsp) throw Error('vote codec failure ' + name)
                return old.call(this, type, r)
            }
            try {
                assert.throws(() => f.vote(), /vote codec failure/)
            } finally {
                protocol.encode = old
            }
            assert.deepEqual(f.state(), before)
        }
    } finally {
        f.store.close()
    }
})
