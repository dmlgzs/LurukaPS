import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { teachingKillReady, observeTimedTeachingProof } from '../src/teaching-kill-conditions.js'
import config from '../configs/battle-config/teaching-kill-conditions.json' with { type: 'json' }
import policy from '../configs/teaching-vm-policy.json' with { type: 'json' }

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base),
    timed = config.rules.filter((r) => r.sourceShape === 'timed-linear-v2')
function setup(rule = timed[0], filename = ':memory:') {
    let ms = 1800000000000,
        seq = 1,
        nonce = 1
    const store = new Store(filename),
        session = {},
        game = new Game(protocol, store, tables, { clock: () => Math.floor(ms / 1000), arenaClockMs: () => ms }),
        openId = 'timed-vm-' + rule.battleFsmType,
        train = tables
            .get('train_task')
            .find((t) => t.groupType === 2 && t.heroId === Math.floor(rule.battleFsmType / 10))
    const dispatch = (g, ses, name, request = {}) => {
        const p = protocol.byName.get('CSProto' + name)
        return g.dispatch(ses, { id: p.id, seq: seq++, payload: protocol.encode(p.req, request) })
    }
    const call = (name, r) => dispatch(game, session, name, r),
        state = () => store.load(session.id).state
    call('EnterGame', { open_id: openId })
    store.transact(session.id, 0, (s) => {
        s.player.basic_info.lv = 40
        s.world.map_id = 100
        s.tasks = []
        s.taskRecords = tables
            .get('task')
            .filter((t) => t.type === 1)
            .map((t) => ({ task_id: t.id, count: 1, time: 1 }))
    })
    const trialRequest = {
        open: true,
        force: true,
        trial_heros: [{ pos: 0, id: Number(String(train.showTeamInterim).split('|')[0]) }],
        trial_pets: [{ pos: 0, id: 0 }],
    }
    const enter = () => {
        call('TeachStart', { id: train.taskid })
        call('StartDungeonClientOk')
        call('TrialGroupChange', trialRequest)
    }
    enter()
    const actor = state().trialGroup.heroes[0].guid,
        group = tables.get('world_enemy_group').find((g) => g.battleFsmType === rule.battleFsmType),
        row = tables.get('worldmap_' + state().world.map_id).find((r) => r.expandId === group.id),
        map = state().world.map_id
    assert.ok(row)
    const skillRequest = (op, who = actor, key = String(++nonce)) => ({
        unit_id: who,
        op_time: key,
        skill: { skill_id: op.id, index: op.index, begin_time: key },
    })
    const elementRequest = (op, who = actor, unique = String(990000 + ++nonce), executor = who) => ({
        uint64_dic: [who, unique, String(op.id), executor],
        battle_info: [
            {
                element_info: {
                    op: 1,
                    tar_id: '1',
                    uniqueId: '2',
                    buff: { cfg_id: 3, executor_id: '4', creator_id: '1' },
                },
            },
        ],
    })
    const fire = (op, who = actor) => {
        const request = op.kind === 'skill' ? skillRequest(op, who) : elementRequest(op, who)
        call(op.kind === 'skill' ? 'SkillStart' : 'BattleInfoReduce', request)
        return request
    }
    const complete = (ops = rule.ops) => {
        for (const op of ops)
            if (op.kind === 'wait') ms += op.milliseconds
            else fire(op)
    }
    return {
        store,
        session,
        game,
        train,
        rule,
        actor,
        group,
        row,
        map,
        state,
        call,
        fire,
        enter,
        complete,
        openId,
        trialRequest,
        dispatch,
        skillRequest,
        elementRequest,
        ms: () => ms,
        setMs: (n) => {
            ms = n
        },
        tick: (n) => {
            ms += n
        },
        proof: () => state().combat.teachingProof?.[row.id],
        ready: () => !!teachingKillReady(tables, state(), row.id, Math.floor(ms / 1000), ms),
        kills: () => ({
            guid: Object.values(state().combat.entities)
                .filter((e) => e.object_id === row.id)
                .map((e) => e.uuid),
        }),
    }
}

test('four actual graphs retain generated skill, Hero-element and millisecond waits without changing old rule order', () => {
    assert.deepEqual(
        timed.map((r) => r.battleFsmType),
        [1010141, 1070021, 1080051, 1120021],
    )
    assert.deepEqual(
        config.rules.slice(0, 4).map((r) => r.battleFsmType),
        [1010101, 1020011, 1010071, 1070031],
    )
    assert.ok(!config.rules.some((r) => [1090011, 1080021].includes(r.battleFsmType)))
    for (const rule of timed) {
        const f = setup(rule)
        try {
            const beforeDb = f.store.playerById.get(f.session.id)
            for (const op of rule.ops) {
                if (op.kind === 'wait') {
                    assert.equal(f.ready(), false)
                    assert.throws(() => f.call('StoryKill', f.kills()))
                    f.tick(op.milliseconds - 1)
                    assert.equal(f.ready(), false)
                    f.tick(1)
                } else f.fire(op)
            }
            assert.equal(f.proof().op, rule.ops.length)
            assert.equal(f.ready(), true)
            assert.deepEqual(f.store.playerById.get(f.session.id), beforeDb, 'all observations stay deferred')
            f.call('EndDungeonScene', { result: 3 })
            f.call('StoryKill', f.kills())
            assert.ok(f.state().storyCampaign.completed_scenes.includes(f.map))
            for (const id of f.kills().guid) assert.equal(f.state().combat.entities[id].hp, 0)
            const receipt = f.state().storyKillReceipts,
                player = f.state().player
            f.call('StoryKill', f.kills())
            assert.deepEqual(f.state().storyKillReceipts, receipt)
            assert.deepEqual(f.state().player, player)
        } finally {
            f.store.close()
        }
    }
})

test('early next cast cannot be replayed after a 1.5-second wait; client timestamps never satisfy server deadlines', () => {
    const f = setup(timed[0])
    try {
        f.fire(f.rule.ops[0])
        f.tick(1000)
        f.fire(f.rule.ops[2])
        const early = f.skillRequest(f.rule.ops[4], f.actor, '18446744073709551615')
        f.call('SkillStart', early)
        assert.equal(f.proof().op, 4)
        const deadline = f.proof().not_before_ms
        f.tick(1499)
        f.call('SkillStart', early)
        assert.equal(f.proof().not_before_ms, deadline)
        f.tick(1)
        f.call('SkillStart', early)
        assert.equal(f.proof().op, 4, 'new frame sequence does not turn an early nonce into a new cast')
        f.fire(f.rule.ops[4])
        assert.equal(f.proof().op, 6)
        const step = f.proof().op,
            previousMs = f.ms()
        f.setMs(previousMs - 10000)
        f.fire(f.rule.ops[6])
        assert.equal(f.proof().op, step)
        f.setMs(previousMs + 1500)
        f.fire(f.rule.ops[6])
        f.tick(6000)
        assert.equal(f.ready(), true)
    } finally {
        f.store.close()
    }
})

test('Hero element producer executor, premature uniqueId, trial ownership, wrong index and configuration gates remain strict', () => {
    const f = setup(timed.find((r) => r.ops[0].kind === 'element'))
    try {
        const owned = f.state().player.heros_info.heros[0].guid,
            op = f.rule.ops[0]
        f.call('BattleInfoReduce', f.elementRequest(op, f.actor, '991001', owned))
        assert.equal(f.proof(), undefined)
        for (const operation of [7, 10]) {
            const request = f.elementRequest(op)
            request.battle_info[0].element_info.op = operation
            f.call('BattleInfoReduce', request)
            assert.equal(f.proof(), undefined, 'Combine/RemoteAdd are not element injection events')
        }
        f.fire(op, owned)
        assert.equal(f.proof(), undefined)
        f.fire(op)
        const early = f.skillRequest(f.rule.ops[2])
        f.call('SkillStart', early)
        f.tick(1000)
        f.call('SkillStart', early)
        assert.equal(f.proof().op, 2)
        f.fire({ ...f.rule.ops[2], index: 999 })
        assert.equal(f.proof().op, 2)
        f.fire(f.rule.ops[2])
        f.tick(2000)
        f.fire(f.rule.ops[4])
        f.tick(3000)
        assert.equal(f.ready(), true)
        const raw = tables.find.bind(tables)
        tables.find = (name, id) =>
            name === 'world_enemy_group' && Number(id) === f.group.id
                ? { ...raw(name, id), canForceKill: 0 }
                : raw(name, id)
        try {
            assert.equal(f.ready(), false)
            assert.throws(() => f.call('StoryKill', f.kills()))
        } finally {
            tables.find = raw
        }
    } finally {
        f.store.close()
    }
})

test('actual compressed Hero element replays are ignored and generic future elements cannot cross a wait by replay', () => {
    const f = setup(timed.find((r) => r.ops[0].kind === 'element'))
    try {
        const request = f.elementRequest(f.rule.ops[0])
        f.call('BattleInfoReduce', request)
        const first = f.proof()
        f.tick(5000)
        f.call('BattleInfoReduce', request)
        assert.deepEqual(f.proof(), first)
        const uid = request.uint64_dic[1],
            id = f.rule.ops[0].id
        f.call('BattleInfoReduce', {
            uint64_dic: [f.actor, String(id), uid],
            battle_info: [
                {
                    element_info: {
                        op: 1,
                        tar_id: '1',
                        uniqueId: '3',
                        buff: { cfg_id: 2, executor_id: '1', creator_id: '1' },
                    },
                },
            ],
        })
        assert.deepEqual(f.proof(), first, 'changing compressed dictionary indexes does not produce a new element')
        assert.equal(f.ready(), false)
        // This op order is a generic interpreter boundary fixture, not a claim
        // that any current graph contains a later Hero-element wait.
        const state = structuredClone(f.state()),
            rule = {
                ...f.rule,
                ops: [
                    { kind: 'skill', id: 71, index: 0 },
                    { kind: 'wait', milliseconds: 1500 },
                    { kind: 'element', id: 72, executorTypes: [1], networkOperation: 1 },
                ],
            },
            c = { state, arena_now_ms: f.ms() }
        delete state.combat.teachingProof
        observeTimedTeachingProof(c, f.actor, { kind: 'skill', id: 71, index: 0 }, 's:first', f.row, rule)
        const event = { kind: 'element', id: 72, heroExecutor: true, operation: 1, fresh: true }
        observeTimedTeachingProof(c, f.actor, event, 'e:early', f.row, rule)
        assert.equal(state.combat.teachingProof[f.row.id].op, 2)
        c.arena_now_ms += 1500
        observeTimedTeachingProof(c, f.actor, event, 'e:early', f.row, rule)
        assert.equal(state.combat.teachingProof[f.row.id].op, 2)
        observeTimedTeachingProof(c, f.actor, event, 'e:fresh', f.row, rule)
        assert.equal(state.combat.teachingProof[f.row.id].op, 3)
    } finally {
        f.store.close()
    }
})

test('restored elements and deleted old UIDs cannot masquerade as a fresh teaching injection', () => {
    const f = setup(timed.find((r) => r.ops[0].kind === 'element'))
    try {
        const op = f.rule.ops[0],
            ids = ['9007199254741997', '9007199254741999']
        f.store.transact(f.session.id, 0, (s) => {
            for (const id of ids)
                s.combat.elements[id] = {
                    op: 1,
                    tar_id: f.actor,
                    uniqueId: id,
                    buff: { cfg_id: op.id, executor_id: f.actor, creator_id: f.actor },
                }
        })
        f.call('BattleInfoReduce', f.elementRequest(op, f.actor, ids[0]))
        assert.equal(f.proof().op, 0)
        for (const id of ids) {
            f.call('BattleInfoReduce', {
                uint64_dic: [f.actor, id],
                battle_info: [
                    {
                        element_info: { op: 2, tar_id: '1', uniqueId: '2' },
                    },
                ],
            })
            f.call('BattleInfoReduce', f.elementRequest(op, f.actor, id))
            assert.equal(f.proof().op, 0)
        }
        f.fire(op)
        assert.equal(f.proof().op, 2)
        assert.equal(f.proof().not_before_ms, f.ms() + 1000)
    } finally {
        f.store.close()
    }
})

test('proof source, map, instance, actor and timer version cannot be guessed into a successful migration', () => {
    for (const corrupt of [
        (p) => {
            p.source = 'wrong'
        },
        (p) => {
            p.instance = 'other'
        },
        (p) => {
            p.map++
        },
        (p) => {
            delete p.not_before_ms
        },
        (p) => {
            delete p.version
        },
        (p) => {
            p.actor = '0'
        },
        (p) => {
            p.not_before_ms = NaN
        },
    ]) {
        const f = setup()
        try {
            f.complete()
            assert.equal(f.ready(), true)
            f.store.transact(f.session.id, 0, (s) => {
                corrupt(s.combat.teachingProof[f.row.id])
            })
            assert.equal(f.ready(), false)
            assert.throws(() => f.call('StoryKill', f.kills()))
        } finally {
            f.store.close()
        }
    }
})

test('same-instance real SQLite reopen preserves deadline, receipts and deterministic trial GUID through renewed formation', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luruka-timed-vm-')),
        filename = path.join(dir, 'state.sqlite'),
        f = setup(timed[0], filename)
    let reopened
    try {
        f.fire(f.rule.ops[0])
        f.tick(1000)
        f.fire(f.rule.ops[2])
        f.tick(500)
        const proof = f.proof(),
            instance = f.state().storyCampaign.instance_id,
            killRequest = f.kills()
        f.store.close()
        f.tick(1000)
        reopened = new Store(filename)
        const session = {},
            game = new Game(protocol, reopened, tables, { clock: () => Math.floor(f.ms() / 1000), arenaClockMs: f.ms })
        f.dispatch(game, session, 'EnterGame', { open_id: f.openId })
        f.dispatch(game, session, 'TrialGroupChange', f.trialRequest)
        const state = () => reopened.load(session.id).state
        assert.equal(state().trialGroup.heroes[0].guid, f.actor)
        assert.equal(state().storyCampaign.instance_id, instance)
        assert.deepEqual(state().combat.teachingProof[f.row.id], proof)
        for (const op of f.rule.ops.slice(4))
            if (op.kind === 'wait') f.tick(op.milliseconds)
            else f.dispatch(game, session, 'SkillStart', f.skillRequest(op))
        f.dispatch(game, session, 'StoryKill', killRequest)
        assert.ok(state().storyCampaign.completed_scenes.includes(f.map))
    } finally {
        if (f.store.db.open) f.store.close()
        reopened?.close()
        assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()))
        assert.ok(path.basename(dir).startsWith('luruka-timed-vm-'))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('codec/SQLite failures roll back kills and timed proof; a committed pet final hit is never resurrected for cleanup', () => {
    const f = setup(timed[1])
    try {
        f.complete()
        const snapshot = () => ({
                state: f.state(),
                db: f.store.playerById.get(f.session.id),
                pending: structuredClone([...f.store.pending]),
            }),
            before = snapshot(),
            original = protocol.encode,
            target = protocol.byName.get('CSProtoObjBattleInfoSync').rsp
        protocol.encode = function (name, value) {
            if (name === target) throw Error('timed-codec')
            return original.call(this, name, value)
        }
        try {
            assert.throws(() => f.call('StoryKill', f.kills()), /timed-codec/)
        } finally {
            protocol.encode = original
        }
        assert.deepEqual(snapshot(), before)
        f.store.db.exec(
            "CREATE TRIGGER timed_sql_fail BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT, 'timed-sql'); END",
        )
        assert.throws(() => f.call('StoryKill', f.kills()), /timed-sql/)
        assert.deepEqual(snapshot(), before)
        f.store.db.exec('DROP TRIGGER timed_sql_fail')
        const s = f.state(),
            targets = f.kills().guid,
            pet = s.pets[0]
        f.call('BattleInfoReduce', {
            uint64_dic: [pet.guid, ...targets],
            battle_info: targets.map((id, i) => ({
                hurt_info: { from_id: '1', tar_id: String(i + 2), hp_change: -s.combat.entities[id].hp },
            })),
        })
        const dead = f.state()
        f.call('StoryKill', { guid: targets })
        for (const id of targets) assert.equal(f.state().combat.entities[id].hp, 0)
        assert.deepEqual(f.state().player, dead.player)
    } finally {
        f.store.close()
    }
})

test('failed high-frequency handler changes no proof, instance exit resets it, and receipt overflow stays bounded', () => {
    const f = setup()
    try {
        const p = protocol.byName.get('CSProtoSkillStart'),
            original = f.game.handlers.get(p.id)
        f.game.handlers.set(p.id, (c, r) => {
            original(c, r)
            throw Error('timed-memory-rollback')
        })
        assert.throws(() => f.fire(f.rule.ops[0]), /timed-memory-rollback/)
        assert.equal(f.proof(), undefined)
        f.game.handlers.set(p.id, original)
        f.fire(f.rule.ops[0])
        const receiptsBeforeNoise = f.proof().receipts.length
        for (let i = 0; i < 64; i++) f.fire({ kind: 'skill', id: 10100704, index: 0 })
        assert.equal(
            f.proof().receipts.length,
            receiptsBeforeNoise,
            'unrelated real skills do not exhaust proof receipts',
        )
        const pending = f.proof(),
            instance = f.state().storyCampaign.instance_id
        f.store.transact(f.session.id, 0, (s) => {
            s.combat.teachingProof[f.row.id].receipts = Array.from({ length: policy.maxReceipts }, (_, i) => 'old-' + i)
        })
        f.fire(f.rule.ops[2])
        assert.equal(f.proof().blocked, true)
        assert.equal(f.proof().receipts.length, policy.maxReceipts)
        f.tick(100000)
        assert.equal(f.ready(), false)
        f.call('CampaignQuit')
        f.enter()
        assert.notEqual(f.state().storyCampaign.instance_id, instance)
        assert.equal(f.proof(), undefined)
        f.complete()
        assert.equal(f.ready(), true)
        assert.notDeepEqual(f.proof(), pending)
    } finally {
        f.store.close()
    }
})

test('invalid actual teaching run IDs never authorize proofs; legacy valid flows stay intact and only a new instance recovers', () => {
    for (const invalid of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
        const f = setup()
        try {
            f.store.transact(f.session.id, 0, (s) => {
                if (invalid === undefined) delete s.storyCampaign.instance_id
                else s.storyCampaign.instance_id = invalid
            })
            assert.doesNotThrow(() => f.complete())
            assert.equal(f.proof(), undefined)
            assert.equal(f.ready(), false)
            assert.throws(
                () => f.call('StoryKill', f.kills()),
                (e) => !(e instanceof TypeError),
            )
            const state = structuredClone(f.state()),
                c = { state, arena_now_ms: f.ms() },
                op = f.rule.ops[0]
            assert.doesNotThrow(() => observeTimedTeachingProof(c, f.actor, op, 'invalid-run-probe', f.row, f.rule))
            assert.equal(state.combat.teachingProof?.[f.row.id], undefined)
            f.call('CampaignQuit')
            f.enter()
            assert.ok(
                Number.isSafeInteger(f.state().storyCampaign.instance_id) && f.state().storyCampaign.instance_id > 0,
            )
            f.complete()
            assert.equal(f.ready(), true)
        } finally {
            f.store.close()
        }
    }
    const legacy = config.rules.find((r) => r.sourceShape === 'linear-skill-v1'),
        f = setup(legacy)
    try {
        f.complete(legacy.steps)
        f.tick(legacy.completionDelaySeconds * 1000)
        assert.equal(f.ready(), true, 'a genuine legacy proof keeps its successful behavior')
        for (const invalid of [0, undefined]) {
            f.store.transact(f.session.id, 0, (s) => {
                if (invalid === undefined) delete s.storyCampaign.instance_id
                else s.storyCampaign.instance_id = invalid
            })
            assert.equal(f.ready(), false, 'legacy complete proof must still belong to a valid actual run')
            assert.throws(
                () => f.call('StoryKill', f.kills()),
                (e) => !(e instanceof TypeError),
            )
        }
    } finally {
        f.store.close()
    }
})
