import test from 'node:test'
import assert from 'node:assert/strict'
import { abyssFixture } from './abyss-fixture.js'
import { ErrorCode } from '../src/error-codes.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
function clear(f) {
    let packets
    while (f.state().abyssRun.phase === 'running') {
        const s = f.state(),
            run = s.abyssRun
        for (const target of Object.values(s.combat.entities).filter(
            (x) => run.wave_objects.includes(x.object_id) && x.hp > 0,
        ))
            packets = f.call('BattleInfoReduce', {
                uint64_dic: [run.challenges[run.part_index].control, target.uuid],
                battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -target.hp } }],
            })
    }
    return packets
}
test('11463 restores the exact entrance and original owned formation/HP, retires FO30/31, and repeats harmlessly without granting progress', () => {
    const f = abyssFixture('abyss-quit')
    try {
        const before = f.state(),
            party = before.player.group_mgrs.find((x) => x.type === 1)
        f.call('AbyssChallenge', f.request())
        f.call('AbyssChallengeRealStart')
        const copy = f.state().abyssRun.heroes[0].guid
        f.call('BattleInfoReduce', { uint64_dic: [copy], battle_info: [{ hurt_info: { tar_id: '1', hp_change: -1 } }] })
        const packets = f.call('AbyssChallengeQuit'),
            s = f.state()
        assert.equal(s.abyssRun, undefined)
        assert.equal(s.combat, undefined)
        assert.deepEqual(
            s.player.group_mgrs.find((x) => x.type === 1),
            party,
        )
        assert.deepEqual(s.player.heros_info.heros, before.player.heros_info.heros)
        assert.deepEqual(s.pets, before.pets)
        assert.equal(s.world.map_id, before.world.map_id)
        assert.deepEqual(s.world.pos, before.world.pos)
        assert(!s.player.heros_info.battle_infos.some((x) => x.hero_id === copy))
        assert(s.retiredTrialActors.includes(copy))
        assert.equal(f.decode(packets, 'CSProtoOnlineModeChange').mode, 1)
        assert.equal(f.decode(packets, 'CSProtoWorldMapSync').map_id, before.world.map_id)
        assert.equal(s.abyss.modes[1].levels[10001].passed, false)
        assert.equal(s.abyss.modes[1].levels[10001].resume, undefined)
        const repeated = f.call('AbyssChallengeQuit')
        assert.equal(repeated.length, 1)
        f.call('SkillStop', { unit_id: copy, skill_id: 1 })
    } finally {
        f.store.close()
    }
})
test('11463 retains only authoritative won inter-room checkpoints, without preserving or inventing unfinished-room waves', () => {
    const f = abyssFixture('abyss-quit-checkpoint')
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.abyss = { modes: { 1: { levels: { 10007: { passed: true, star_num: 3 } } } } }
        })
        f.call('AbyssChallenge', f.request(2, 20001))
        f.call('AbyssChallengeRealStart')
        f.time.now += 30
        clear(f)
        const first = f.state().abyssRun
        f.call('AbyssChallengeNext')
        f.call('AbyssChallengeRealStart')
        f.time.now += 10
        f.call('AbyssChallengeQuit')
        const record = f.state().abyss.modes[2].levels[20001],
            checkpoint = record.resume
        assert.equal(record.passed, false)
        assert.equal(checkpoint.completed_parts, 1)
        assert.equal(checkpoint.total_battle_time, 30)
        assert.equal(checkpoint.challenges[0].win, true)
        assert.equal(checkpoint.challenges[1].win, false)
        assert.equal(checkpoint.challenges[1].battle_time, 0)
        assert.deepEqual(checkpoint.heroAttrs, first.heroAttrs)
        assert.equal(checkpoint.scene_objects, undefined)
        assert.equal(checkpoint.combat, undefined)
        assert.equal(record.pass_level_reward_flag, false)
    } finally {
        f.store.close()
    }
})
test('11463 unavailable entrance or response encoding failure rolls back active copies and owned state; other map transfers also retire abyss runtime', () => {
    const f = abyssFixture('abyss-quit-codec')
    try {
        f.call('AbyssChallenge', f.request())
        const before = f.state(),
            encode = f.p.encode.bind(f.p),
            type = f.p.byName.get('CSProtoWorldMapSync').rsp
        f.p.encode = (t, v) => {
            if (t === type) throw Error('abyss quit codec')
            return encode(t, v)
        }
        assert.throws(() => f.call('AbyssChallengeQuit'), /abyss quit codec/)
        f.p.encode = encode
        assert.deepEqual(f.state(), before)
        f.store.transact(f.session.id, 0, (s) => {
            s.abyssRun.return_world.map_id = 999999999
        })
        assert.throws(
            () => f.call('AbyssChallengeQuit'),
            (e) => e.code === ErrorCode.InstanceSceneConfNotExist,
        )
        f.store.transact(f.session.id, 0, (s) => {
            s.abyssRun.return_world = before.abyssRun.return_world
        })
        f.call('EnterWorldMap', { map_id: 100, point_id: 10045 })
        assert.equal(f.state().abyssRun, undefined)
        assert.equal(f.state().world.map_id, 100)
        assert(!f.state().player.group_mgrs.some((x) => x.type === 7))
    } finally {
        f.store.close()
    }
})
test('11463 SQLite reconnect keeps the returned world and legitimate half-clear checkpoint, with no active copied actors', () => {
    const parent = path.resolve(os.tmpdir()),
        dir = fs.mkdtempSync(path.join(parent, 'abyss-quit-')),
        file = path.join(dir, 'state.sqlite')
    let f = abyssFixture('abyss-quit-sql', file)
    try {
        const world = f.state().world
        f.store.transact(f.session.id, 0, (s) => {
            s.abyss = { modes: { 1: { levels: { 10007: { passed: true, star_num: 3 } } } } }
        })
        f.call('AbyssChallenge', f.request(2, 20001))
        f.call('AbyssChallengeRealStart')
        f.time.now += 30
        clear(f)
        f.call('AbyssChallengeQuit')
        const saved = f.state().abyss.modes[2].levels[20001].resume
        f.store.close()
        f = abyssFixture('abyss-quit-sql', file, true)
        assert.equal(f.state().world.map_id, world.map_id)
        assert.deepEqual(f.state().world.pos, world.pos)
        assert.equal(f.state().abyssRun, undefined)
        assert.deepEqual(f.state().abyss.modes[2].levels[20001].resume, saved)
        assert(!f.state().player.heros_info.battle_infos.some((x) => BigInt(x.hero_id) >> 56n === 30n))
    } finally {
        f.store.close()
        if (path.dirname(path.resolve(dir)) !== parent || !path.basename(dir).startsWith('abyss-quit-'))
            throw Error('Unexpected cleanup target')
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
