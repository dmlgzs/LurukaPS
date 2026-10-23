import test from 'node:test'
import assert from 'node:assert/strict'
import { abyssFixture } from './abyss-fixture.js'
import { abyssIntroPlan } from '../src/abyss-intro.js'
import { abyssTables } from '../src/abyss-catalog.js'
import { ErrorCode } from '../src/error-codes.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function enter(f) {
    f.store.transact(f.session.id, 0, (s) => {
        s.abyss = {
            modes: {
                1: { levels: { 10007: { passed: true, star_num: 3 } } },
                2: { levels: { 20006: { passed: true, star_num: 3 } } },
            },
        }
    })
    f.call('AbyssChallenge', f.request(2, 20007))
    return f.call('AbyssChallengeRealStart')
}
test('11468 is produced only by four actual scene story/target parameter pairs; unrelated rooms invent no intro', () => {
    const f = abyssFixture('abyss-intro-catalog')
    try {
        const tables = abyssTables(f.tables),
            found = []
        for (const scene of tables.get('dungeon_scene').filter((x) => tables.find('world_city', x.id)?.type === 26)) {
            const objects = tables
                    .get('worldmap_' + scene.id)
                    .filter((x) => x.expandId && tables.find('world_enemy_group', x.expandId))
                    .map((x) => x.id),
                intro = abyssIntroPlan(f.tables, { map_id: scene.id, wave_index: 0, wave_objects: objects })
            if (intro) found.push([scene.id, intro.stage_id, intro.target_id])
        }
        assert.deepEqual(found, [
            [6824, 6110004, 1500008],
            [6835, 6110007, 1500009],
            [6837, 6110004, 1500009],
            [6840, 6110005, 1500009],
        ])
    } finally {
        f.store.close()
    }
})
test('11467 starts the configured real boss intro, ignores cinematic HP packets, and 11468 resumes its clock without granting a win', () => {
    const f = abyssFixture('abyss-intro-real')
    try {
        const start = enter(f),
            run = f.state().abyssRun,
            packet = f.decode(start, 'SCProtoAbyssBossIntro')
        assert.deepEqual(packet, { stage_id: 6110004, target_id: 1500008 })
        assert.equal(run.phase, 'intro')
        assert(
            start.findIndex((x) => x.id === 9103) < start.findIndex((x) => x.id === 11467),
            'configured monster group snapshot precedes its intro',
        )
        const enemy = Object.values(f.state().combat.entities).find((x) => x.object_id === 1500008)
        f.call('BattleInfoReduce', {
            uint64_dic: [run.challenges[0].control, enemy.uuid],
            battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -enemy.hp } }],
        })
        assert.equal(f.state().combat.entities[enemy.uuid].hp, enemy.hp)
        assert.throws(
            () => f.call('AbyssBossIntroDone', { stage_id: 1 }),
            (e) => e.code === ErrorCode.AbyssInvalidChallengeLevel,
        )
        f.time.now += 30
        f.call('AbyssBossIntroDone', { stage_id: 6110004 })
        assert.equal(f.state().abyssRun.real_start_time, f.time.now)
        assert.equal(f.state().abyssRun.phase, 'running')
        assert.equal(f.state().abyss.modes[2].levels[20007].passed, false)
        f.time.now += 5
        f.call('AbyssBossIntroDone', { stage_id: 6110004 })
        assert.equal(f.state().abyssRun.real_start_time, f.time.now - 5)
        f.call('BattleInfoReduce', {
            uint64_dic: [run.challenges[0].control, enemy.uuid],
            battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -enemy.hp } }],
        })
        assert.equal(f.state().abyssRun.phase, 'won')
        assert.equal(f.state().abyssRun.total_battle_time, 5)
    } finally {
        f.store.close()
    }
})
test('11468 codec failure preserves its pending cinematic and retry issues the same configured story for a fresh attempt', () => {
    const f = abyssFixture('abyss-intro-codec')
    try {
        enter(f)
        const before = f.state(),
            encode = f.p.encode.bind(f.p)
        // The exact empty ACK type is read from the registered protocol, never guessed.
        const ackType = f.p.byName.get('CSProtoAbyssBossIntroDone').rsp
        f.p.encode = (type, value) => {
            if (type === ackType) throw Error('abyss intro codec')
            return encode(type, value)
        }
        assert.throws(() => f.call('AbyssBossIntroDone', { stage_id: 6110004 }), /abyss intro codec/)
        f.p.encode = encode
        assert.deepEqual(f.state(), before)
        f.call('AbyssChallengeRetry')
        assert.equal(f.state().abyssRun.phase, 'ready')
        assert.equal(f.state().abyssRun.intro, undefined)
        const started = f.call('AbyssChallengeRealStart')
        assert.equal(f.decode(started, 'SCProtoAbyssBossIntro').stage_id, 6110004)
    } finally {
        f.store.close()
    }
})
test('11468 pending story survives SQLite reconnect, replays once per connection and does not accept an intro from another scene', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abyss-intro-')),
        file = path.join(dir, 'save.sqlite')
    let f
    try {
        f = abyssFixture('abyss-intro-sql', file)
        enter(f)
        const instance = f.state().abyssRun.instance_id
        f.store.close()
        f = abyssFixture('abyss-intro-sql', file, true)
        assert.equal(f.state().abyssRun.phase, 'intro')
        assert.equal(f.state().abyssRun.instance_id, instance)
        const packets = f.call('EnterDungeonScene', { scene_id: 6824 })
        assert.equal(f.decode(packets, 'SCProtoAbyssBossIntro').stage_id, 6110004)
        assert.equal(f.call('EnterDungeonScene', { scene_id: 6824 }).filter((x) => x.id === 11467).length, 0)
        assert.throws(
            () => f.call('AbyssBossIntroDone', { stage_id: 6110007 }),
            (e) => e.code === ErrorCode.AbyssInvalidChallengeLevel,
        )
        f.call('AbyssBossIntroDone', { stage_id: 6110004 })
        assert.equal(f.state().abyssRun.phase, 'running')
    } finally {
        f?.store.close()
        if (
            path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep) &&
            path.basename(dir).startsWith('abyss-intro-')
        )
            fs.rmSync(dir, { recursive: true, force: true })
    }
})
