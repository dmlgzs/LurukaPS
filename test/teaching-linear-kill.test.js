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
import { ErrorCode } from '../src/error-codes.js'
import { teachingKillReady } from '../src/teaching-kill-conditions.js'
import config from '../configs/battle-config/teaching-kill-conditions.json' with { type: 'json' }

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
const linear = config.rules.filter((r) => r.sourceShape === 'linear-skill-v1')
function setup(rule, filename = ':memory:') {
    const train = tables
            .get('train_task')
            .find((t) => t.groupType === 2 && t.heroId === Math.floor(rule.battleFsmType / 10)),
        store = new Store(filename),
        session = {}
    assert.ok(train)
    let now = 1800000000,
        stamp = 1800000000000,
        sequence = 1
    const game = new Game(protocol, store, tables, { clock: () => now })
    const call = (name, request = {}) => {
        const p = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: p.id, seq: sequence++, payload: protocol.encode(p.req, request) })
    }
    call('EnterGame', { open_id: 'linear-kill-' + rule.battleFsmType })
    store.transact(session.id, 0, (s) => {
        s.player.basic_info.lv = 40
        s.world.map_id = 100
        s.tasks = []
        s.taskRecords = tables
            .get('task')
            .filter((t) => t.type === 1)
            .map((t) => ({ task_id: t.id, count: 1, time: 1 }))
    })
    call('TeachStart', { id: train.taskid })
    call('StartDungeonClientOk')
    call('TrialGroupChange', {
        open: true,
        force: true,
        trial_heros: [{ pos: 0, id: Number(String(train.showTeamInterim).split('|')[0]) }],
        trial_pets: [{ pos: 0, id: 0 }],
    })
    const state = () => store.load(session.id).state,
        actor = state().trialGroup.heroes[0].guid,
        group = tables.get('world_enemy_group').find((g) => g.battleFsmType === rule.battleFsmType),
        row = tables.get('worldmap_' + state().world.map_id).find((row) => row.expandId === group.id),
        entity = Object.values(state().combat.entities).find((e) => e.object_id === row?.id)
    assert.ok(
        entity,
        JSON.stringify({ map: state().world.map_id, group: group.id, row, entities: state().combat.entities }),
    )
    const objectId = entity.object_id,
        mapId = state().world.map_id
    const cast = (step, who = actor, at = String(++stamp)) => {
        const request = { unit_id: who, op_time: at, skill: { skill_id: step.id, index: step.index, begin_time: at } }
        call('SkillStart', request)
        return request
    }
    return {
        store,
        session,
        game,
        state,
        call,
        actor,
        group,
        objectId,
        mapId,
        rule,
        cast,
        tick: (n) => {
            now += n
        },
        now: () => now,
        proof: () => state().combat.teachingProof?.[objectId],
        kills: () => ({
            guid: Object.values(state().combat.entities)
                .filter((e) => e.object_id === objectId)
                .map((e) => e.uuid),
        }),
        ready: () => !!teachingKillReady(tables, state(), objectId, now),
        complete: () => {
            for (const step of rule.steps) cast(step)
        },
    }
}
test('actual linear teaching graphs retain ordered skill IDs/indexes, final wait, stable receipts and cleanup', () => {
    assert.deepEqual(
        linear.map((r) => r.battleFsmType),
        [1010071, 1070031],
    )
    for (const rule of linear) {
        const f = setup(rule)
        try {
            const dbBefore = f.store.playerById.get(f.session.id)
            assert.throws(
                () => f.call('StoryKill', f.kills()),
                (e) => e.code === ErrorCode.InvalidArgument,
            )
            f.cast(rule.steps.at(-1))
            assert.equal(f.proof(), undefined)
            const request = f.cast(rule.steps[0])
            f.call('SkillStart', request)
            assert.equal(f.proof().step, 1)
            f.cast({ ...rule.steps[1], index: 999 })
            assert.equal(f.proof().step, 1)
            for (const step of rule.steps.slice(1)) f.cast(step)
            assert.equal(f.proof().completed_at, f.now())
            assert.equal(f.ready(), false)
            assert.deepEqual(
                f.store.playerById.get(f.session.id),
                dbBefore,
                'skill proof stays on deferred memory path',
            )
            assert.throws(() => f.call('EndDungeonScene', { result: 3 }), /not defeated/)
            f.tick(rule.completionDelaySeconds - 1)
            assert.equal(f.ready(), false)
            assert.throws(() => f.call('StoryKill', f.kills()))
            f.tick(1)
            assert.equal(f.ready(), true)
            const packets = f.call('StoryKill', f.kills())
            assert.ok(packets.some((p) => p.id === protocol.byName.get('CSProtoObjBattleInfoSync').id))
            for (const id of f.kills().guid) assert.equal(f.state().combat.entities[id].hp, 0)
            assert.ok(f.state().storyCampaign.completed_scenes.includes(f.mapId))
            const receipts = f.state().storyKillReceipts,
                player = f.state().player
            f.call('StoryKill', f.kills())
            assert.deepEqual(f.state().storyKillReceipts, receipts)
            assert.deepEqual(f.state().player, player)
        } finally {
            f.store.close()
        }
    }
})

test('linear proof rejects owned non-trial actors, isolates failed memory requests and does not accept a missing timer receipt', () => {
    const f = setup(linear[0])
    try {
        const owned = f.state().player.heros_info.heros[0].guid
        f.cast(linear[0].steps[0], owned)
        assert.equal(f.proof(), undefined)
        const p = protocol.byName.get('CSProtoSkillStart'),
            original = f.game.handlers.get(p.id)
        f.game.handlers.set(p.id, (c, r) => {
            original(c, r)
            throw Error('linear-proof-rollback')
        })
        assert.throws(() => f.cast(linear[0].steps[0]), /linear-proof-rollback/)
        assert.equal(f.proof(), undefined)
        f.game.handlers.set(p.id, original)
        f.complete()
        f.tick(10)
        f.store.transact(f.session.id, 0, (s) => {
            delete s.combat.teachingProof[f.objectId].completed_at
        })
        assert.equal(f.ready(), false)
        assert.throws(() => f.call('StoryKill', f.kills()))
    } finally {
        f.store.close()
    }
})

test('10799 response encoding and SQLite failures roll back timed proof consumption, kills and scene completion', () => {
    const f = setup(linear[1])
    try {
        f.complete()
        f.tick(linear[1].completionDelaySeconds)
        const snapshot = () => ({
            saved: f.store.playerById.get(f.session.id),
            state: f.state(),
            pending: structuredClone([...f.store.pending]),
        })
        const before = snapshot(),
            old = protocol.encode,
            target = protocol.byName.get('CSProtoObjBattleInfoSync').rsp
        protocol.encode = function (name, data) {
            if (name === target) throw Error('linear-kill-codec')
            return old.call(this, name, data)
        }
        try {
            assert.throws(() => f.call('StoryKill', f.kills()), /linear-kill-codec/)
        } finally {
            protocol.encode = old
        }
        assert.deepEqual(snapshot(), before)
        f.store.db.exec(
            "CREATE TRIGGER linear_kill_fail BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT, 'linear-kill-sql'); END",
        )
        assert.throws(() => f.call('StoryKill', f.kills()), /linear-kill-sql/)
        assert.deepEqual(snapshot(), before)
        f.store.db.exec('DROP TRIGGER linear_kill_fail')
        f.call('StoryKill', f.kills())
        assert.ok(f.state().storyCampaign.completed_scenes.includes(f.mapId))
    } finally {
        f.store.close()
    }
})

test('a pet final hit completes actual enemies and later scripted cleanup neither revives them nor grants another reward', () => {
    const f = setup(linear[0])
    try {
        const s = f.state(),
            targets = f.kills().guid,
            pet = s.pets[0]
        assert.ok(pet)
        f.call('BattleInfoReduce', {
            uint64_dic: [pet.guid, ...targets],
            battle_info: targets.map((id, i) => ({
                hurt_info: { from_id: '1', tar_id: String(i + 2), hp_change: -s.combat.entities[id].hp },
            })),
        })
        for (const id of targets) assert.equal(f.state().combat.entities[id].hp, 0)
        const before = f.state()
        f.call('StoryKill', { guid: targets })
        assert.deepEqual(f.state().storyKillReceipts, before.storyKillReceipts)
        assert.deepEqual(f.state().player, before.player)
        for (const id of targets) assert.equal(f.state().combat.entities[id].hp, 0)
    } finally {
        f.store.close()
    }
})

test('SQLite reopen retains the genuine cast receipt and elapsed server wait for the same active teaching instance', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luruka-linear-kill-')),
        filename = path.join(dir, 'state.sqlite')
    const f = setup(linear[1], filename)
    let reopened
    try {
        f.complete()
        f.tick(linear[1].completionDelaySeconds)
        const proof = f.proof(),
            run = f.state().storyCampaign,
            request = f.kills()
        f.store.close()
        reopened = new Store(filename)
        const game = new Game(protocol, reopened, tables, { clock: () => f.now() }),
            session = {},
            login = protocol.byName.get('CSProtoEnterGame')
        game.dispatch(session, {
            id: login.id,
            seq: 1,
            payload: protocol.encode(login.req, { open_id: 'linear-kill-' + linear[1].battleFsmType }),
        })
        const current = () => reopened.load(session.id).state
        assert.equal(current().storyCampaign.instance_id, run.instance_id)
        assert.deepEqual(current().combat.teachingProof[f.objectId], proof)
        assert.ok(teachingKillReady(tables, current(), f.objectId, f.now()))
        const p = protocol.byName.get('CSProtoStoryKill')
        game.dispatch(session, { id: p.id, seq: 2, payload: protocol.encode(p.req, request) })
        for (const id of request.guid) assert.equal(current().combat.entities[id].hp, 0)
    } finally {
        if (f.store.db.open) f.store.close()
        reopened?.close()
        assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()))
        assert(path.basename(dir).startsWith('luruka-linear-kill-'))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
