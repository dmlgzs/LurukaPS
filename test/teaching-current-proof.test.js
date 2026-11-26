import test from 'node:test'
import assert from 'node:assert/strict'
import { Tables } from '../src/player.js'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import {
    currentTeachingActor,
    currentTeachingProofReady,
    observeCurrentTeachingProof,
    currentTeachingShape,
    currentTeachingIntentReady,
} from '../src/current-teaching-proof.js'

const config = configuration(),
    tables = new Tables(config.tables),
    protocol = new Protocol(config.base)
const snapshots = new Map()
function fixture(taskId) {
    if (!snapshots.has(taskId)) {
        const store = new Store(':memory:')
        const game = new Game(protocol, store, tables, { clock: () => 1800000000, arenaClockMs: () => 1800000000000 })
        const session = {}
        let seq = 1
        const call = (name, req = {}) => {
            const p = protocol.byName.get('CSProto' + name)
            return game.dispatch(session, {
                id: p.id,
                seq: seq++,
                payload: p.req ? protocol.encode(p.req, req) : Buffer.alloc(0),
            })
        }
        call('EnterGame', { open_id: 'current-proof-' + taskId })
        store.transact(session.id, 0, (state) => {
            state.tasks = []
            state.taskRecords = tables
                .get('task')
                .filter((r) => r.type === 1)
                .map((r) => ({ task_id: r.id, count: 1 }))
            state.player.basic_info.lv = 60
            Object.assign(state.world, tables.position(tables.find('world_borthpos', 10045)))
        })
        call('TeachStart', { id: taskId })
        call('TrialGroupChange', { open: true, trial_id: store.load(session.id).state.world.map_id })
        call('StartDungeonClientOk')
        snapshots.set(taskId, structuredClone(store.load(session.id).state))
        store.close()
    }
    const state = structuredClone(snapshots.get(taskId))
    const row = tables
        .get('worldmap_' + state.world.map_id)
        .find((row) => tables.find('world_spawner', row.spawnerId)?.objectType === 50)
    const c = { tables, state, now: 1800000000, arena_now_ms: 1800000000000 }
    return { c, row, hero: (id) => state.trialGroup.heroes.find((h) => h.conf_id === id).guid }
}

// These explicit unit rules exercise the IR contract. Default imported asset
// profiles and real wire completion are covered separately by integration tests.
function rule(ops, extra = {}) {
    return {
        sourceShape: currentTeachingShape,
        sourceSha256: 'a'.repeat(64),
        proofPolicy: 'local-server-clock-v1',
        ops,
        ...extra,
    }
}
function inject(f, r, cfg, executor, uid, attacker = executor, overrides = {}) {
    const element = {
        op: 1,
        uniqueId: String(uid),
        tar_id: executor,
        buff: { cfg_id: cfg, executor_id: executor, attacker_id: attacker },
        verify_info: { op_time: String(f.c.arena_now_ms) },
        ...overrides,
    }
    observeCurrentTeachingProof(f.c, executor, { kind: 'element', element, fresh: true }, 'e:' + uid, f.row, r)
}
const ready = (f, r) => currentTeachingProofReady(f.c.state, f.row, r, f.c.arena_now_ms)

test('current slot proof checks published skill, consumes cast retries and enforces the local server wait', () => {
    const f = fixture(201),
        actor = f.hero(107001)
    const r = rule([
        { kind: 'skill-slot', slot: 203, count: 1 },
        { kind: 'skill-slot', slot: 203, count: 1 },
        { kind: 'wait', milliseconds: 2000 },
    ])
    const cast = (skill, slot, receipt) =>
        observeCurrentTeachingProof(
            f.c,
            actor,
            { kind: 'skill', id: skill, slot, cast: String(f.c.arena_now_ms), stamp: String(f.c.arena_now_ms) },
            receipt,
            f.row,
            r,
        )
    cast(10700121, 2, 'wrong-slot')
    cast(10700101, 203, 'wrong-skill')
    assert.equal(f.c.state.combat.teachingProof, undefined)
    cast(10700121, undefined, 'cast1')
    cast(10700121, undefined, 'cast1')
    assert.equal(f.c.state.combat.teachingProof[f.row.id].op, 1)
    cast(10700121, 203, 'cast2')
    assert.equal(ready(f, r), false)
    assert.equal(currentTeachingIntentReady(f.c.state, f.row, r), true)
    f.c.arena_now_ms += 1999
    assert.equal(ready(f, r), false)
    f.c.arena_now_ms++
    assert.equal(ready(f, r), true)
    const reloaded = structuredClone(f.c.state)
    assert.equal(currentTeachingProofReady(reloaded, f.row, r, f.c.arena_now_ms), true)
    reloaded.storyCampaign.instance_id++
    assert.equal(currentTeachingProofReady(reloaded, f.row, r, f.c.arena_now_ms), false)
})

test('attack injections count the selected attacker across two heroes, with tags and damage type instead of HP loss', () => {
    const f = fixture(202),
        first = f.hero(108003),
        second = f.hero(108001)
    const r = rule(
        [
            { kind: 'attack-hit', actor: { heroId: 108003 }, requiredTag: 22, damageTypes: [1, 2, 3, 4], count: 10 },
            { kind: 'attack-hit', actor: { heroId: 108001 }, requiredTag: 22, damageTypes: [1, 2, 3, 4], count: 30 },
        ],
        {
            damageElements: {
                91: { kind: 'damage', tags: [22], damageType: 1 },
                92: { kind: 'damage', tags: [], damageType: 1 },
                93: { kind: 'damage', tags: [22], damageType: 9 },
                94: {
                    variants: [{ config: { tags: [22], damageType: 1 } }, { config: { tags: [22], damageType: 8 } }],
                },
            },
        },
    )
    inject(f, r, 91, first, 1, second)
    inject(f, r, 92, first, 2)
    inject(f, r, 93, first, 3)
    inject(f, r, 94, first, 4)
    inject(f, r, 91, first, 5, first, { op: 7 })
    inject(f, r, 91, '0', 6, first)
    assert.equal(f.c.state.combat.teachingProof[f.row.id].count, 0)
    for (let n = 0; n < 10; n++) inject(f, r, 91, second, 100 + n, first)
    assert.equal(f.c.state.combat.teachingProof[f.row.id].op, 1)
    inject(f, r, 91, first, 1, second)
    assert.equal(f.c.state.combat.teachingProof[f.row.id].count, 0, 'a future-stage injection cannot be replayed')
    for (let n = 0; n < 30; n++) inject(f, r, 91, first, 200 + n, second)
    assert.equal(ready(f, r), true)
})

test('element proof distinguishes actual Player10 and Monster14 executors, counts independent injections and waits', () => {
    const f = fixture(203),
        hero = f.hero(108003)
    const player = ((24n << 56n) | BigInt(f.c.state.player.basic_info.id)).toString()
    const enemy = ((3n << 56n) | BigInt(f.row.id)).toString()
    assert.equal(currentTeachingActor(tables, f.c.state, hero).entityType, 1)
    assert.equal(currentTeachingActor(tables, f.c.state, player).entityType, 10)
    assert.equal(currentTeachingActor(tables, f.c.state, enemy).entityType, 14)
    assert.equal(currentTeachingActor(tables, f.c.state, (BigInt(player) + 1n).toString()), null)
    const r = rule([
        { kind: 'element', id: 250, executorTypes: [10], count: 3 },
        { kind: 'wait', milliseconds: 1000 },
        { kind: 'element', id: 296, executorTypes: [14], count: 3 },
        { kind: 'wait', milliseconds: 1000 },
    ])
    inject(f, r, 250, hero, 1, player)
    assert.equal(f.c.state.combat.teachingProof, undefined, 'attacker cannot stand in for executor')
    inject(f, r, 250, player, 2, player, {
        verify_info: { op_time: String(f.c.state.storyCampaign.start_time * 1000 - 1) },
    })
    assert.equal(f.c.state.combat.teachingProof, undefined, 'a pre-entry injection cannot create current proof')
    for (let n = 0; n < 3; n++) inject(f, r, 250, player, 10 + n)
    inject(f, r, 296, enemy, 20)
    f.c.arena_now_ms += 1000
    inject(f, r, 296, enemy, 20)
    assert.equal(f.c.state.combat.teachingProof[f.row.id].count, 0)
    for (let n = 0; n < 3; n++) inject(f, r, 296, enemy, 30 + n)
    assert.equal(ready(f, r), false)
    f.c.arena_now_ms += 1000
    assert.equal(ready(f, r), true)
    f.c.state.trialGroup.heroes[0].guid = '999'
    assert.equal(ready(f, r), false)
})

test('current proof refuses bad persisted counts and rolls back through a detached transaction copy', () => {
    const f = fixture(203)
    const player = ((24n << 56n) | BigInt(f.c.state.player.basic_info.id)).toString()
    const r = rule([{ kind: 'element', id: 250, executorTypes: [10], count: 3 }])
    const base = structuredClone(f.c.state)
    inject(f, r, 250, player, 1)
    assert.equal(base.combat.teachingProof, undefined)
    const valid = structuredClone(f.c.state.combat.teachingProof[f.row.id])
    Object.assign(f.c.state.combat.teachingProof[f.row.id], { op: 1, count: 0 })
    assert.throws(
        () => ready(f, r),
        /proof state is malformed/,
        'a valid-range terminal index still needs enough receipts',
    )
    f.c.state.combat.teachingProof[f.row.id] = valid
    f.c.state.combat.teachingProof[f.row.id].count = 3
    assert.throws(() => ready(f, r), /proof state is malformed/)
    assert.throws(
        () =>
            observeCurrentTeachingProof(f.c, player, {}, 'bad', f.row, { ...r, ops: [{ kind: 'unknown', count: 1 }] }),
        /trigger is not implemented/,
    )
    assert.throws(
        () => observeCurrentTeachingProof(f.c, player, {}, 'null-op', f.row, { ...r, ops: [null] }),
        /trigger is malformed/,
    )
})

test('a new teaching instance rejects the exact old cast and accepts a genuinely newer operation time', () => {
    const f = fixture(201),
        actor = f.hero(107001)
    const r = rule([{ kind: 'skill-slot', slot: 203, count: 3 }])
    const oldTime = String(f.c.arena_now_ms)
    const cast = (stamp, receipt) =>
        observeCurrentTeachingProof(f.c, actor, { kind: 'skill', id: 10700121, cast: stamp, stamp }, receipt, f.row, r)
    cast(oldTime, 'old-cast')
    assert.equal(f.c.state.combat.teachingProof[f.row.id].count, 1)
    f.c.state.storyCampaign = { ...f.c.state.storyCampaign, instance_id: f.c.state.storyCampaign.instance_id + 1 }
    f.c.state.combat = { ...f.c.state.combat, teachingProof: undefined }
    cast(oldTime, 'old-cast')
    assert.equal(f.c.state.combat.teachingProof, undefined)
    f.c.arena_now_ms++
    cast(String(f.c.arena_now_ms), 'new-cast')
    assert.equal(f.c.state.combat.teachingProof[f.row.id].count, 1)
    assert.equal(f.c.state.teachingObservationEpoch.floor_ms, String(BigInt(oldTime) + 1n))
})

test('current epoch keeps same-millisecond injections, blocks new-run replay and uses copy-on-write on failed work', () => {
    const f = fixture(203),
        player = ((24n << 56n) | BigInt(f.c.state.player.basic_info.id)).toString()
    const r = rule([{ kind: 'element', id: 250, executorTypes: [10], count: 3 }])
    inject(f, r, 250, player, 1)
    inject(f, r, 250, player, 2)
    assert.equal(f.c.state.combat.teachingProof[f.row.id].count, 2)
    const base = f.c.state,
        epoch = base.teachingObservationEpoch,
        proofMap = base.combat.teachingProof
    const frozen = JSON.stringify({ epoch, proofMap })
    const fork = { ...base, combat: { ...base.combat } }
    const detached = { ...f, c: { ...f.c, state: fork, arena_now_ms: f.c.arena_now_ms + 1 } }
    assert.throws(() => {
        inject(detached, r, 250, player, 3)
        assert.notEqual(fork.teachingObservationEpoch, epoch)
        throw Error('simulated encode failure after observation')
    }, /encode failure/)
    assert.equal(base.teachingObservationEpoch, epoch)
    assert.equal(base.combat.teachingProof, proofMap)
    assert.equal(JSON.stringify({ epoch, proofMap }), frozen)
    f.c.state.storyCampaign = { ...base.storyCampaign, instance_id: base.storyCampaign.instance_id + 1 }
    f.c.state.combat = { ...base.combat, teachingProof: undefined }
    inject(f, r, 250, player, 1)
    assert.equal(f.c.state.combat.teachingProof, undefined)
    f.c.arena_now_ms++
    inject(f, r, 250, player, 4)
    assert.equal(f.c.state.combat.teachingProof[f.row.id].count, 1)
    inject(f, r, 250, player, 5, player, { verify_info: undefined })
    assert.equal(f.c.state.combat.teachingProof[f.row.id].count, 1)
    assert.throws(
        () => inject(f, r, 250, player, 6, player, { verify_info: { op_time: 'bad' } }),
        /operation time is malformed/,
    )
})
