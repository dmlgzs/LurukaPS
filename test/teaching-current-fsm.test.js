import test from 'node:test'
import assert from 'node:assert/strict'
import { currentTeachingFsmFixture } from './teaching-current-fsm-fixture.js'
import { currentTeachingProofCapability } from '../src/teaching-kill-conditions.js'

const assets = (s) => ({
    heroes: s.player.heros_info.heros,
    pets: s.pets,
    bag: s.player.sbag_infos,
    souls: s.player.soulessence_infos,
    ornaments: s.ornaments,
})
function targets(f) {
    const enemies = f
        .state()
        .storyCampaign.scene_objects.filter((row) => row.active)
        .flatMap((row) => row.expand_data?.battle_group?.monsters ?? [])
    const objectIds = [...new Set(enemies.map((enemy) => enemy.obj_key.obj_id))]
    const expected = objectIds.reduce((sum, id) => {
        const row = f.tables.find('worldmap_' + f.scene.id, id)
        const group = f.tables.find('world_enemy_group', row.expandId)
        return sum + String(group.enemyList).split('|').filter(Boolean).length
    }, 0)
    assert(expected > 0)
    assert.equal(enemies.length, expected, 'use all actual current group packs, independently of preview counts')
    return enemies
}
const target = (f) => targets(f)[0]
function proof(f) {
    const rows = Object.values(f.state().combat.teachingProof ?? {})
    assert(rows.length <= 1)
    return rows[0]
}
function skill(f, actor, id, options = {}) {
    const { slot, index = 1, stamp = f.nowMs() } = options
    return f.frame('SkillStart', {
        unit_id: actor,
        skill: { skill_id: id, begin_time: String(stamp), index, ...(slot === undefined ? {} : { slot }) },
        op_time: String(stamp),
    })
}
function element(f, { cfg, executor, attacker = executor, receiver = executor, uid, op = 1 }) {
    const dictionary = [...new Set([receiver, String(uid), String(cfg), executor, attacker])]
    const ix = (value) => String(dictionary.indexOf(String(value)) + 1)
    return f.frame('BattleInfoReduce', {
        base_time: String(f.nowMs()),
        uint64_dic: dictionary,
        battle_info: [
            {
                element_info: {
                    op,
                    tar_id: ix(receiver),
                    uniqueId: ix(uid),
                    verify_info: { op_time: '0' },
                    buff: { cfg_id: ix(cfg), begin_time: '0', executor_id: ix(executor), attacker_id: ix(attacker) },
                },
            },
        ],
    })
}
function rejectsKillWithoutMutation(f, enemy) {
    const before = f.state()
    assert.throws(() => f.call('StoryKill', { guid: [enemy.uid] }))
    assert.deepEqual(f.state(), before, 'rejected StoryKill must roll back all state')
}
function finish(f, taskId, enemy, pending) {
    const allEnemies = targets(f)
    const ids = allEnemies.map((row) => row.uid)
    const kill = f.call('StoryKill', { guid: ids })
    assert(
        kill.some((p) => p.id === 10009),
        'terminal HP synchronization is emitted by the successful kill',
    )
    let s = f.state()
    for (const id of ids) {
        assert.equal(s.combat.entities[id].hp, 0)
        const terminal = s.combat.enemyTerminals[id]
        assert.equal(terminal.hp, 0)
        assert.equal(terminal.pack_id, s.combat.entities[id].pack_id)
        assert.equal(terminal.config_id, s.combat.entities[id].config_id)
    }
    if (!pending) f.call('EndDungeonScene', { result: 3 })
    s = f.state()
    assert.equal(s.storyCampaign.status, 3)
    assert.equal(s.teachingRecords.filter((id) => id === taskId).length, 1)
    const awarded = structuredClone(assets(s))
    f.call('StoryKill', { guid: [...ids, enemy.uid] })
    f.call('EndDungeonScene', { result: 3 })
    assert.deepEqual(assets(f.state()), awarded)
    f.edit((state) => {
        state.combat.entities = {}
    })
    f.reconnect()
    s = f.state()
    const projected = s.storyCampaign.scene_objects.flatMap((row) => row.expand_data?.battle_group?.monsters ?? [])
    for (const id of ids) {
        assert.equal(s.combat.enemyTerminals[id].hp, 0)
        assert.equal(
            projected.find((row) => row.uid === id).hp,
            0,
            'cache eviction and relogin preserve scripted death',
        )
    }
    assert.equal(s.teachingRecords.filter((id) => id === taskId).length, 1)
    assert.deepEqual(assets(s), awarded)
    f.call('CampaignQuit')
    assert(!f.state().storyCampaign)
    assert(!f.state().trialGroup)
    assert.deepEqual(assets(f.state()), awarded)
    assert.deepEqual(f.state().player.heros_info.heros, f.initialAssets.heroes)
    assert.deepEqual(f.state().pets, f.initialAssets.pets)
    return awarded
}

test('current1001 actual SkillStart omits slot, deduplicates cast/index, waits, then StoryKill clears once across relogin', () => {
    assert.equal(currentTeachingProofCapability(1001).available, true, 'Main must install the current source IR')
    const f = currentTeachingFsmFixture(201)
    try {
        const actor = f.trialActor(107001).guid,
            enemy = target(f)
        rejectsKillWithoutMutation(f, enemy)
        f.dispatch(skill(f, actor, 10700101, { slot: 203 }))
        assert.equal(proof(f), undefined, 'an attack skill cannot impersonate the published entry203 skill')
        const first = skill(f, actor, 10700121)
        f.dispatch(first)
        assert.equal(proof(f).op, 1)
        f.dispatch(skill(f, actor, 10700121, { index: 9 }))
        assert.equal(proof(f).op, 1, 'a different index does not turn the same cast into a second stage')
        assert.throws(() => f.call('EndDungeonScene', { result: 3 }))
        f.reconnect()
        assert.equal(proof(f).op, 1)
        f.advanceMs(1)
        f.dispatch(skill(f, actor, 10700121))
        f.call('EndDungeonScene', { result: 3 })
        assert.equal(f.state().storyCampaign.pending_end_scene, f.scene.id)
        f.advanceMs(1999)
        rejectsKillWithoutMutation(f, enemy)
        f.advanceMs(1)
        const awarded = finish(f, 201, enemy, true)
        f.call('TeachStart', { id: 201 })
        f.call('TrialGroupChange', { open: true, trial_id: f.scene.trialsId })
        f.call('StartDungeonClientOk')
        f.dispatch(first)
        assert.equal(proof(f), undefined, 'old accepted cast does not seed a new instance')
        rejectsKillWithoutMutation(f, target(f))
        assert.deepEqual(assets(f.state()), awarded)
        f.call('CampaignQuit')
    } finally {
        f.store.close()
    }
})

test('current2001 actual element reports require selected attacker and40 distinct accepted hits before StoryKill', () => {
    assert.equal(
        currentTeachingProofCapability(2001).available,
        true,
        'Main must install current IR and damage predicates',
    )
    const f = currentTeachingFsmFixture(202)
    try {
        const first = f.trialActor(108003).guid,
            second = f.trialActor(108001).guid,
            enemy = target(f)
        // Current skill_control tracks bind108003 via bullet10800301 InjectTargetElement,
        // and108001 via its direct InjectToTarget keyframe. See TEACH-DAMAGE-BINDINGS.md.
        const firstCfg = 108003002,
            secondCfg = 108001097
        let uid = 900000
        const inject = (cfg, attacker, fixedUid) =>
            f.dispatch(
                element(f, {
                    cfg,
                    attacker,
                    executor: enemy.uid,
                    receiver: enemy.uid,
                    uid: fixedUid ?? uid++,
                }),
            )
        rejectsKillWithoutMutation(f, enemy)
        inject(firstCfg, second)
        assert.equal(proof(f)?.count ?? 0, 0)
        for (let n = 0; n < 9; n++) inject(firstCfg, first)
        assert.equal(proof(f).count, 9)
        rejectsKillWithoutMutation(f, enemy)
        const retryUid = uid++
        inject(firstCfg, first, retryUid)
        assert.equal(proof(f).op, 1)
        inject(secondCfg, second, retryUid)
        assert.equal(proof(f).count, 0, 'same injected element UID cannot count again after an actor switch')
        f.reconnect()
        for (let n = 0; n < 29; n++) inject(secondCfg, second)
        assert.equal(proof(f).count, 29)
        assert.throws(() => f.call('EndDungeonScene', { result: 3 }))
        rejectsKillWithoutMutation(f, enemy)
        inject(secondCfg, second)
        finish(f, 202, enemy, false)
    } finally {
        f.store.close()
    }
})

test('current3001 real Player24 and Monster executors satisfy current3+3 elements with both server waits', () => {
    assert.equal(currentTeachingProofCapability(3001).available, true, 'Main must install the current source IR')
    const f = currentTeachingFsmFixture(203)
    try {
        const player = f.playerActorId(),
            hero = f.trialActor(108003).guid,
            enemy = target(f)
        let uid = 910000
        const inject = (cfg, executor, fixedUid) =>
            f.dispatch(
                element(f, {
                    cfg,
                    executor,
                    attacker: hero,
                    receiver: enemy.uid,
                    uid: fixedUid ?? uid++,
                }),
            )
        inject(250, hero)
        assert.equal(proof(f), undefined, 'Hero1 cannot impersonate Player10 even when it is controlled locally')
        for (let n = 0; n < 2; n++) inject(250, player)
        assert.equal(proof(f).count, 2)
        rejectsKillWithoutMutation(f, enemy)
        inject(250, player)
        const earlyUid = uid++
        inject(296, enemy.uid, earlyUid)
        assert.equal(proof(f).count, 0)
        assert.throws(() => f.call('EndDungeonScene', { result: 3 }))
        f.advanceMs(1000)
        inject(296, enemy.uid, earlyUid)
        assert.equal(proof(f).count, 0, 'injection received during the intermediate wait remains consumed')
        f.reconnect()
        for (let n = 0; n < 3; n++) inject(296, enemy.uid)
        f.call('EndDungeonScene', { result: 3 })
        f.advanceMs(999)
        rejectsKillWithoutMutation(f, enemy)
        f.advanceMs(1)
        finish(f, 203, enemy, true)
    } finally {
        f.store.close()
    }
})

test('current mechanism proof and accepted timestamp epoch roll back after execution or response encoding fails', () => {
    assert.equal(currentTeachingProofCapability(1001).available, true, 'current IR required')
    assert.equal(currentTeachingProofCapability(3001).available, true, 'current IR required')
    const f = currentTeachingFsmFixture(201)
    const skillId = f.protocol.byName.get('CSProtoSkillStart').id
    const handler = f.game.handlers.get(skillId)
    try {
        const actor = f.trialActor(107001).guid
        f.dispatch(skill(f, actor, 10700121))
        f.advanceMs(1)
        const request = skill(f, actor, 10700121)
        const before = structuredClone(f.state()),
            retained = f.state()
        const oldEpoch = retained.teachingObservationEpoch,
            oldProof = structuredClone(retained.combat.teachingProof)
        let executed = false
        f.game.handlers.set(skillId, (c, r) => {
            handler(c, r)
            assert.equal(Object.values(c.state.combat.teachingProof)[0].op, 3)
            executed = true
            throw Error('injected-current-teaching-defer')
        })
        assert.throws(() => f.dispatch(request), /injected-current-teaching-defer/)
        assert.equal(executed, true, 'failure occurs after the real handler changes its detached proof')
        assert.deepEqual(f.state(), before)
        assert.deepEqual(retained.combat.teachingProof, oldProof)
        assert.strictEqual(retained.teachingObservationEpoch, oldEpoch)
        assert.deepEqual(oldEpoch, before.teachingObservationEpoch)
        f.game.handlers.set(skillId, handler)
        f.dispatch(request)
        assert.equal(proof(f).op, 3, 'an unaccepted request remains admissible after rollback')
        assert.notStrictEqual(f.state().teachingObservationEpoch, oldEpoch)
        f.call('CampaignQuit')
    } finally {
        f.game.handlers.set(skillId, handler)
        f.store.close()
    }
    const g = currentTeachingFsmFixture(203),
        encode = g.protocol.encode
    try {
        const player = g.playerActorId(),
            hero = g.trialActor(108003).guid,
            enemy = target(g)
        g.dispatch(element(g, { cfg: 250, executor: player, attacker: hero, receiver: enemy.uid, uid: 920001 }))
        g.advanceMs(1)
        const raw = {
            base_time: String(g.nowMs()),
            uint64_dic: [player, enemy.uid, '920002', '250', hero],
            battle_info: [
                {
                    element_info: {
                        op: 1,
                        tar_id: '2',
                        uniqueId: '3',
                        verify_info: { op_time: '0' },
                        buff: { cfg_id: '4', begin_time: '0', executor_id: '1', attacker_id: '5' },
                    },
                },
                { hurt_info: { from_id: '5', tar_id: '2', hp_change: -1 } },
            ],
        }
        const request = g.frame('BattleInfoReduce', raw)
        const before = structuredClone(g.state()),
            retained = g.state(),
            oldEpoch = retained.teachingObservationEpoch
        const oldProof = structuredClone(retained.combat.teachingProof)
        let codecCalled = false
        g.protocol.encode = function (type, value) {
            if (type.endsWith('SCObjBattleInfoSync') && value.infos?.some((row) => row.uuid === enemy.uid)) {
                codecCalled = true
                throw Error('injected-current-teaching-codec')
            }
            return encode.call(this, type, value)
        }
        assert.throws(() => g.dispatch(request), /injected-current-teaching-codec/)
        assert.equal(codecCalled, true, 'only response/push encoding fails after the preencoded request executes')
        assert.deepEqual(g.state(), before)
        assert.deepEqual(retained.combat.teachingProof, oldProof)
        assert.strictEqual(retained.teachingObservationEpoch, oldEpoch)
        assert.deepEqual(oldEpoch, before.teachingObservationEpoch)
        g.protocol.encode = encode
        g.dispatch(request)
        assert.equal(proof(g).count, 2)
        assert.notStrictEqual(g.state().teachingObservationEpoch, oldEpoch)
        g.call('CampaignQuit')
    } finally {
        g.protocol.encode = encode
        g.store.close()
    }
})
