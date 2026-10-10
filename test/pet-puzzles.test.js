import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Game } from '../src/game.js'
import { Store } from '../src/store.js'
import { WorldObjectCatalog } from '../src/world-objects.js'
import { petPuzzleRule } from '../src/pet-puzzles.js'
import { playableSnapshot } from '../src/handlers/playable-lifecycle.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
const catalog = new WorldObjectCatalog(tables)
function fixture() {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables),
        session = {}
    let seq = 1
    const call = (name, data, who = session) => {
        const e = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(who, { id: e.id, seq: seq++, payload: protocol.encode(e.req, data) })
            .map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    }
    call('EnterGame', { open_id: 'puzzle-regression' })
    store.transact(session.id, 0, (s) => {
        s.tasks = []
        s.taskRecords = tables.get('task').map((row) => ({ task_id: row.id, count: 1, time: 1 }))
        delete s.pendingTaskStorySync
    })
    return { store, session, call, state: () => store.load(session.id).state }
}

test('nine table-bound puzzle families retain intermediate visibility and reversible component snapshots', () => {
    const f = fixture()
    try {
        const representatives = [
            [921, 300031],
            [930, 1200000],
            [921, 300028],
            [900, 1500020],
            [100, 300326],
            [923, 1400001],
            [1103, 1400009],
            [100, 300064],
            [921, 300019],
        ]
        const paths = new Set()
        for (const [map, id] of representatives) {
            const { row, spawner, pos } = catalog.object(map, id)
            paths.add(petPuzzleRule(tables, row, spawner).path)
            f.store.transact(f.session.id, 0, (s) => {
                s.world.map_id = map
                s.world.pos = pos
                s.tasks = []
            })
            const before = structuredClone(f.state().player)
            const send = (step, children = []) =>
                f
                    .call('WorldObjInteract', {
                        objs: [
                            {
                                obj: { obj_id: id, state_data: { step, complete: true, children } },
                                interact_type: 0,
                            },
                        ],
                    })
                    .find((p) => p.id === 9133).data.objs[0]
            const solved = send(4, [{ step: 2, complete: true }])
            assert.equal(solved.obj.active, true)
            assert.equal(solved.obj.complete, false)
            assert.deepEqual(solved.rewards.rewards, [])
            const reset = send(0)
            assert.equal(reset.obj.state_data.step, 0)
            assert.deepEqual(reset.obj.state_data.children ?? [], [])
            assert.deepEqual(f.state().player, before)
            assert.equal(f.state().worldObjects[map + ':' + id].active, true)
        }
        assert.equal(paths.size, 9)
    } finally {
        f.store.close()
    }
})

test('solving a rewarded puzzle leaves its chest available; claiming pays once and migration preserves the solved state', () => {
    const f = fixture()
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.tasks = []
            s.world.map_id = 100
            s.world.pos = catalog.object(100, 300064).pos
            s.taskRecords = tables
                .get('task')
                .filter((r) => r.type === 1)
                .map((r) => ({ task_id: r.id, count: 1, time: 1 }))
        })
        const req = { objs: [{ obj: { obj_id: 300064, state_data: { step: 4, complete: true } } }] }
        const solved = f.call('WorldObjInteract', req).find((p) => p.id === 9133).data.objs[0]
        assert.deepEqual(solved.rewards.rewards, [])
        f.store.transact(f.session.id, 0, (s) => {
            delete s.worldObjects['100:300064'].active
        })
        f.call('EnterGame', { open_id: 'puzzle-regression' }, {})
        assert.equal(f.state().worldObjects['100:300064'].active, true)
        req.objs[0].obj.complete = true
        const claim = f.call('WorldObjInteract', req).find((p) => p.id === 9133).data.objs[0]
        assert.ok(claim.rewards.rewards.length > 0)
        const after = structuredClone(f.state().player)
        assert.deepEqual(f.call('WorldObjInteract', req).find((p) => p.id === 9133).data.objs[0].rewards.rewards, [])
        assert.deepEqual(f.state().player, after)
    } finally {
        f.store.close()
    }
})

test('configured stage rewards pay once and persist flags; absent 10068 drops fail atomically', () => {
    const f = fixture()
    try {
        const configs = JSON.parse(
            fs.readFileSync(new URL('../configs/playable-tables/playable.json', import.meta.url)),
        )
        for (const row of configs.filter((r) => r.stepRewards && r.id !== 60001)) {
            f.store.transact(f.session.id, 0, (s) => {
                s.world.map_id = 100
                s.tasks = []
                s.playableRuns = {
                    [row.id]: { play_id: row.id, map_id: 100, status: 1, finish_step: 0, sub_datas: [], time: 1 },
                }
            })
            let mask = 0n
            for (const token of row.stepRewards.split('|')) {
                const [step, drop] = token.split('#').map(Number)
                const request = { playId: row.id, is_step: true, finish_step: step }
                if (!catalog.get('drop').some((r) => r.dropId === drop)) {
                    const before = f.state()
                    assert.throws(() => f.call('PlayableStep', request), /Unknown world drop/)
                    assert.deepEqual(f.state(), before)
                    continue
                }
                const result = f.call('PlayableStep', request).find((p) => p.id === 9406).data
                assert.deepEqual(result.drop_id, [drop])
                assert.ok(result.rewards.rewards.length > 0)
                const after = structuredClone(f.state().player)
                assert.deepEqual(f.call('PlayableStep', request).find((p) => p.id === 9406).data.rewards.rewards, [])
                assert.deepEqual(f.state().player, after)
                mask |= 1n << BigInt(step)
            }
            if (!mask) continue // The map6157 playable10068 references three absent CBT3 drop groups.
            assert.equal(playableSnapshot(f.state()).step_flags.find((r) => r.play_id === row.id).flag, String(mask))
            f.call('PlayableCancel', { playId: row.id })
            f.store.transact(f.session.id, 0, (s) => {
                s.playableRuns[row.id] = {
                    play_id: row.id,
                    map_id: 100,
                    status: 1,
                    finish_step: 0,
                    sub_datas: [],
                    time: 2,
                }
            })
            assert.deepEqual(
                f.call('PlayableStep', { playId: row.id, is_step: true, finish_step: 1 }).find((p) => p.id === 9406)
                    .data.rewards.rewards,
                [],
            )
        }
    } finally {
        f.store.close()
    }
})

test('playable child enum can reset without resetting parent progress or paying a reward', () => {
    const f = fixture()
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.world.map_id = 100
            s.tasks = []
            s.playableRuns = {
                11028: {
                    play_id: 11028,
                    map_id: 100,
                    status: 1,
                    finish_step: 5,
                    sub_datas: [{ sub_id: 0, finish_step: 4, complete: true }],
                    time: 1,
                },
            }
        })
        const before = structuredClone(f.state().player)
        f.call('PlayableStep', {
            playId: 11028,
            is_step: false,
            sub_datas: [{ sub_id: 0, finish_step: 0, complete: false }],
        })
        assert.equal(f.state().playableRuns[11028].finish_step, 5)
        assert.deepEqual(f.state().playableRuns[11028].sub_datas[0], { sub_id: 0, finish_step: 0, complete: false })
        assert.deepEqual(f.state().player, before)
    } finally {
        f.store.close()
    }
})

test('repeatable playable restarts after completion and retains score claims through cancellation', () => {
    const f = fixture()
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.world.map_id = 100
            s.playableRuns = {
                11028: { play_id: 11028, map_id: 100, status: 3, finish_step: 10, sub_datas: [], time: 1 },
            }
            s.playableFinishes = { 11028: { play_id: 11028, map_id: 100, score: 30, reward_info: 2 } }
        })
        const start = f.call('PlayableStart', { u32: 11028 }).find((p) => p.id === 9400).data
        assert.deepEqual(start.del_finish_plays, [11028])
        assert.equal(f.state().playableRuns[11028].finish_step, 0)
        f.call('PlayableCancel', { playId: 11028 })
        f.call('PlayableStart', { u32: 11028 })
        f.call('PlayableStep', { playId: 11028, is_step: true, finish_step: 10 })
        f.call('PlayableFinish', { playId: 11028, score: 30 })
        assert.equal(f.state().playableFinishes[11028].reward_info, 2)
    } finally {
        f.store.close()
    }
})

test('configured child puzzle starts beneath its active parent without deleting that parent; parent cancel removes children', () => {
    const f = fixture()
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.world.map_id = 102
            s.playableRuns = {
                10145: { play_id: 10145, map_id: 102, status: 1, finish_step: 0, sub_datas: [], time: 1 },
            }
        })
        f.call('PlayableStart', { u32: 10203 })
        assert.equal(f.state().playableRuns[10145].status, 1)
        assert.equal(f.state().playableRuns[10203].status, 1)
        f.call('PlayableCancel', { playId: 10145 })
        assert.deepEqual(f.state().playableRuns, {})
        assert.throws(() => f.call('PlayableStart', { u32: 10203 }), /current map/)
    } finally {
        f.store.close()
    }
})
