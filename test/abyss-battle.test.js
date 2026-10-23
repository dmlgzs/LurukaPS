import test from 'node:test'
import assert from 'node:assert/strict'
import { abyssFixture } from './abyss-fixture.js'
import { abyssTables, abyssRoute } from '../src/abyss-catalog.js'
import { abyssBattlePlan } from '../src/abyss-battle-config.js'
import { ensureAbyssScene } from '../src/abyss-scene.js'
import { abyssTaskTags } from '../src/abyss-battle.js'
import { enemyDefinition } from '../src/enemy-state.js'
import { ErrorCode } from '../src/error-codes.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { activeAbyssRotation } from '../src/abyss-rotation.js'
import { configTime } from '../src/shops.js'

function hit(f, target, delta, pet = false) {
    const run = f.state().abyssRun,
        source = (pet ? run.pets : run.heroes)[0].guid
    return f.call('BattleInfoReduce', {
        uint64_dic: [source, target],
        battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: delta } }],
    })
}
function killWave(f, pet = false) {
    const s = f.state(),
        ids = Object.values(s.combat.entities).filter((x) => s.abyssRun.wave_objects.includes(x.object_id) && x.hp > 0)
    let packets = []
    for (const x of ids) packets = hit(f, x.uuid, -x.hp, pet)
    return packets
}
test('11462 actual 6805 room starts two configured waves; scaled HP, pet final blows, dead slots and end packets remain authoritative', () => {
    const f = abyssFixture('abyss-real-start')
    try {
        const original = f.state().player.group_mgrs.find((x) => x.type === 1)
        f.call('AbyssChallenge', f.request())
        const start = f.call('AbyssChallengeRealStart'),
            run = f.state().abyssRun
        assert.equal(run.phase, 'running')
        assert.deepEqual(run.wave_objects, [1500006])
        assert.equal(
            f.decode(start, 'CSProtoWorldMapSync').map_info.objs.find((x) => x.obj_id === 1500006).active,
            true,
        )
        assert(
            !start.some((x) => [9513, 10501, 10502].includes(x.id)),
            'single-player abyss does not send multiplayer AOI/campaign manager packets',
        )
        const enemy = Object.values(f.state().combat.entities).find((x) => x.object_id === 1500006)
        assert.equal(enemy.max_hp, enemyDefinition(f.tables, f.state(), enemy.uuid).max_hp)
        hit(f, enemy.uuid, -1, true)
        assert.equal(f.state().combat.entities[enemy.uuid].hp, enemy.max_hp - 1)
        const startedAt = f.state().abyssRun.real_start_time
        f.time.now += 2
        f.call('AbyssChallengeRealStart')
        assert.equal(f.state().abyssRun.real_start_time, startedAt)
        f.time.now += 18
        const second = killWave(f, true),
            s = f.state()
        assert.deepEqual(s.abyssRun.wave_objects, [1500008])
        assert.equal(s.abyssRun.phase, 'running')
        const scene = f.decode(second, 'CSProtoWorldMapSync').map_info.objs,
            dead = scene.find((x) => x.obj_id === 1500006),
            alive = scene.find((x) => x.obj_id === 1500008)
        assert.equal(dead.active, false)
        assert.equal(dead.complete, true)
        assert.deepEqual(dead.expand_data.battle_group.world_indexes, [])
        assert.equal(alive.active, true)
        assert.equal(alive.expand_data.battle_group.world_indexes.length, 4)
        f.time.now += 15
        const ended = killWave(f, true),
            end = f.decode(ended, 'CSProtoAbyssDungeonEndSync'),
            done = f.state()
        assert.equal(end.state, 3)
        assert.equal(end.last_dungeon, true)
        assert.equal(end.cost_time, 35)
        assert.equal(end.total_cost_time, 35)
        assert.equal(end.star, 3)
        assert(end.task_tags_list.every((x) => x.status === 2))
        assert.equal(done.abyss.modes[1].levels[10001].passed, true)
        assert.equal(done.abyss.modes[1].levels[10001].star_num, 3)
        assert.equal(done.abyss.modes[1].levels[10001].pass_level_reward_flag, false)
        assert.deepEqual(
            done.player.group_mgrs.find((x) => x.type === 1),
            original,
        )
        const repeated = hit(f, enemy.uuid, -1, true)
        assert(!repeated.some((x) => x.id === 11461), 'late damage cannot settle or respawn a finished wave')
    } finally {
        f.store.close()
    }
})
test('11462 all 36 actual rooms encode current nonzero levels, complete pack slots, scaled HP, wave gates and dead-slot cleanup', () => {
    const f = abyssFixture('abyss-room-wire')
    try {
        f.call('AbyssChallenge', f.request())
        const template = f.state(),
            tables = abyssTables(f.tables),
            dungeonIds = [
                ...new Set(tables.get('abbys_level').flatMap((x) => String(x.dungeonId).split('|').map(Number))),
            ]
        assert.equal(dungeonIds.length, 36)
        for (const id of dungeonIds) {
            const s = structuredClone(template),
                { route, point } = abyssRoute(tables, id),
                plan = abyssBattlePlan(tables, id)
            Object.assign(s.world, tables.position(point))
            Object.assign(s.abyssRun, {
                map_id: route.map_id,
                dungeon_id: id,
                phase: 'running',
                wave_index: 0,
                wave_objects: plan.waves[0].objects.slice(),
                completed_objects: [],
            })
            delete s.abyssRun.initialized_map
            ensureAbyssScene(f.tables, s, f.time.now)
            for (const row of s.abyssRun.scene_objects.filter((x) => route.object_ids.includes(x.obj_id))) {
                const monsters = row.expand_data.battle_group.monsters
                assert(monsters.length > 0 && monsters.every((x) => x.level > 0 && x.hp > 0))
                assert.equal(row.active, plan.waves[0].objects.includes(row.obj_id))
                for (const m of monsters) assert.equal(m.hp, enemyDefinition(f.tables, s, m.uid).max_hp)
            }
            const deadId = plan.waves[0].objects[0],
                dead = s.abyssRun.scene_objects.find((x) => x.obj_id === deadId)
            for (const m of dead.expand_data.battle_group.monsters)
                Object.assign(s.combat.entities[m.uid], { hp: 0, alive_state: 1 })
            s.abyssRun.completed_objects = [deadId]
            ensureAbyssScene(f.tables, s, f.time.now)
            const wire = {
                    cmd: 47,
                    creator_id: f.session.id,
                    map_id: route.map_id,
                    map_info: { creator_id: f.session.id, map_id: route.map_id, objs: s.abyssRun.scene_objects },
                },
                e = f.p.byName.get('CSProtoWorldMapSync'),
                decoded = f.p.decode(e.rsp, f.p.encode(e.rsp, wire)),
                obj = decoded.map_info.objs.find((x) => x.obj_id === deadId)
            assert.equal(obj.complete, true)
            assert.equal(obj.active, false)
            assert.deepEqual(obj.expand_data.battle_group.world_indexes, [])
        }
    } finally {
        f.store.close()
    }
})
test('11462 timeout and real formation deaths fail without stars; malformed and codec-failed battle batches roll back the small runtime and world changes', () => {
    const f = abyssFixture('abyss-battle-rollback')
    try {
        assert.throws(
            () => f.call('AbyssChallengeRealStart'),
            (e) => e.code === ErrorCode.AbyssNoChallengeList,
        )
        f.call('AbyssChallenge', f.request())
        f.call('AbyssChallengeRealStart')
        const before = f.state(),
            pet = before.abyssRun.pets[0].guid
        assert.throws(() =>
            f.call('BattleInfoReduce', {
                uint64_dic: [pet],
                battle_info: [
                    { hurt_info: { tar_id: '1', hp_change: -5 } },
                    { hurt_info: { tar_id: '9', hp_change: -1 } },
                ],
            }),
        )
        assert.deepEqual(f.state(), before)
        const encode = f.p.encode.bind(f.p),
            hero = before.abyssRun.heroes[0].guid
        f.p.encode = (type, value) => {
            if (type === 'cs.SCAbyssDungeonEndSync') throw Error('abyss settlement codec')
            return encode(type, value)
        }
        assert.throws(() => hit(f, hero, -100000000), /abyss settlement codec/)
        f.p.encode = encode
        assert.deepEqual(f.state(), before)
        const failed = hit(f, hero, -100000000),
            result = f.decode(failed, 'CSProtoAbyssDungeonEndSync')
        assert.equal(result.state, 4)
        assert.equal(result.star, 0)
        assert.equal(f.state().abyssRun.dead_hero_ids.length, 1)
        assert.equal(f.state().abyss.modes[1].levels[10001].passed, false)
    } finally {
        f.store.close()
    }
    const t = abyssFixture('abyss-battle-timeout')
    try {
        t.call('AbyssChallenge', t.request())
        t.call('AbyssChallengeRealStart')
        t.time.now += 300
        const packets = t.call('BattleInfoReduce', { battle_info: [] }),
            end = t.decode(packets, 'CSProtoAbyssDungeonEndSync')
        assert.equal(end.state, 4)
        assert.equal(end.star, 0)
        assert.equal(end.total_cost_time, 300)
    } finally {
        t.store.close()
    }
})
test('abyss star goals are table-driven, cumulative and count hero falls separately from pet HP', () => {
    const f = abyssFixture('abyss-star-goals')
    try {
        f.call('AbyssChallenge', f.request())
        f.call('AbyssChallengeRealStart')
        const s = f.state(),
            run = s.abyssRun
        assert.deepEqual(
            abyssTaskTags(f.tables, run, f.time.now, true).map((x) => x.status),
            [2, 2, 2],
        )
        run.total_battle_time = 120
        assert.deepEqual(
            abyssTaskTags(f.tables, run, f.time.now, true).map((x) => x.status),
            [2, 2, 3],
        )
        run.dead_hero_ids = [run.heroes[0].guid]
        assert.deepEqual(
            abyssTaskTags(f.tables, run, f.time.now, true).map((x) => x.status),
            [2, 3, 3],
        )
    } finally {
        f.store.close()
    }
})
test('11462 SQLite reconnect preserves the active wave and pet health; completing it records only real clear and unclaimed reward state', () => {
    const parent = path.resolve(os.tmpdir()),
        dir = fs.mkdtempSync(path.join(parent, 'abyss-battle-')),
        file = path.join(dir, 'state.sqlite')
    let f = abyssFixture('abyss-real-start-sql', file)
    try {
        f.call('AbyssChallenge', f.request())
        f.call('AbyssChallengeRealStart')
        const owned = structuredClone(f.state().pets),
            pet = f.state().abyssRun.pets[0].guid
        hit(f, pet, -10)
        f.time.now += 20
        killWave(f, true)
        const before = f.state().abyssRun
        f.store.close()
        f = abyssFixture('abyss-real-start-sql', file, true)
        f.time.now += 20
        assert.equal(f.state().abyssRun.phase, 'running')
        assert.deepEqual(f.state().abyssRun.wave_objects, [1500008])
        assert.deepEqual(f.state().abyssRun.pet_hp, before.pet_hp)
        f.time.now += 15
        const done = killWave(f, true)
        assert.equal(f.decode(done, 'CSProtoAbyssDungeonEndSync').total_cost_time, 35)
        assert.deepEqual(f.state().pets, owned)
        assert.equal(f.state().abyss.modes[1].levels[10001].pass_level_reward_flag, false)
        f.store.close()
        f = abyssFixture('abyss-real-start-sql', file, true)
        assert.equal(f.state().abyss.modes[1].levels[10001].passed, true)
        assert(
            f
                .state()
                .abyssRun.scene_objects.filter((x) => [1500006, 1500008].includes(x.obj_id))
                .every((x) => x.complete && !x.active),
        )
    } finally {
        f.store.close()
        if (path.dirname(path.resolve(dir)) !== parent || !path.basename(dir).startsWith('abyss-battle-'))
            throw Error('Unexpected cleanup target')
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
test('abyss offline extension reuses only the latest existing season key and the existing activity end policy; strict and future bounds stay closed', () => {
    const f = abyssFixture('abyss-season-policy')
    try {
        const t = abyssTables(f.tables),
            row = t.get('abbys_time')[0],
            now = configTime(row.endTime) + 1,
            extended = activeAbyssRotation(t, now)
        assert.equal(extended.id, row.id)
        assert.equal(extended.startTime, row.startTime)
        assert(extended.effectiveEnd > now)
        assert.equal(extended.extended, true)
        assert.equal(activeAbyssRotation(t, now, { expiredRotation: 'closed' }), null)
        assert.equal(activeAbyssRotation(t, configTime(row.startTime) - 1), null)
        assert.equal(activeAbyssRotation(t, extended.effectiveEnd), null)
    } finally {
        f.store.close()
    }
})
