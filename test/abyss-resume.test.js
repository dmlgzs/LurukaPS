import test from 'node:test'
import assert from 'node:assert/strict'
import { abyssFixture } from './abyss-fixture.js'
import { ErrorCode } from '../src/error-codes.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
function checkpoint(f) {
    f.store.transact(f.session.id, 0, (s) => {
        s.abyss = { modes: { 1: { levels: { 10007: { passed: true, star_num: 3 } } } } }
    })
    f.call('AbyssChallenge', f.request(2, 20001))
    f.call('AbyssChallengeRealStart')
    f.time.now += 40
    while (f.state().abyssRun.phase === 'running') {
        const s = f.state(),
            r = s.abyssRun
        for (const x of Object.values(s.combat.entities).filter(
            (x) => r.wave_objects.includes(x.object_id) && x.hp > 0,
        ))
            f.call('BattleInfoReduce', {
                uint64_dic: [r.challenges[0].control, x.uuid],
                battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -x.hp } }],
            })
    }
    f.call('AbyssChallengeQuit')
    return f.state().abyss.modes[2].levels[20001].resume
}
test('11451 resume follows real inter-room progress into the first un-won scene, preserves the frozen actors and ignores forged result fields', () => {
    const f = abyssFixture('abyss-resume')
    try {
        const saved = checkpoint(f)
        f.store.transact(f.session.id, 0, (s) => {
            s.player.heros_info.heros[0].hero_lv = 50
        })
        const request = f.request(2, 20001)
        for (const row of request.challenge_list) {
            row.win = true
            row.battle_time = 1
            row.dead_hero_num = 0
            for (const h of row.heros) h.hp = 99999999
        }
        const packets = f.call('AbyssChallenge', request),
            run = f.state().abyssRun
        assert.equal(run.part_index, 1)
        assert.equal(run.phase, 'ready')
        assert.equal(run.total_battle_time, 40)
        assert.equal(run.challenges[0].win, true)
        assert.equal(run.challenges[1].win, false)
        assert.deepEqual(run.heroAttrs, saved.heroAttrs)
        assert.equal(f.decode(packets, 'CSProtoWorldMapSync').map_id, run.rooms[1].map_id)
        assert.equal(f.state().player.group_mgrs.find((x) => x.type === 7).cur_group, 2)
        assert.equal(f.state().abyss.modes[2].levels[20001].passed, false)
        assert.equal(f.state().abyss.modes[2].levels[20001].resume, undefined)
    } finally {
        f.store.close()
    }
})
test('11451 resume rejects changed locked teams and corrupt saved progress, and encoding failure preserves the checkpoint', () => {
    const f = abyssFixture('abyss-resume-rollback')
    try {
        checkpoint(f)
        const swapped = f.request(2, 20001),
            a = swapped.challenge_list[0],
            b = swapped.challenge_list[1]
        ;[a.heros, b.heros] = [b.heros, a.heros]
        ;[a.control, b.control] = [b.control, a.control]
        assert.throws(
            () => f.call('AbyssChallenge', swapped),
            (e) => e.code === ErrorCode.AbyssInvalidTroop,
        )
        const before = f.state(),
            encode = f.p.encode.bind(f.p)
        f.p.encode = (type, value) => {
            if (type === 'cs.SCAbyssDungeonInfoSync') throw Error('abyss resume codec')
            return encode(type, value)
        }
        assert.throws(() => f.call('AbyssChallenge', f.request(2, 20001)), /abyss resume codec/)
        f.p.encode = encode
        assert.deepEqual(f.state(), before)
        f.store.transact(f.session.id, 0, (s) => {
            s.abyss.modes[2].levels[20001].resume.total_battle_time++
        })
        assert.throws(
            () => f.call('AbyssChallenge', f.request(2, 20001)),
            (e) => e.code === ErrorCode.GameConfig,
        )
    } finally {
        f.store.close()
    }
})
test('11451 SQLite reentry consumes only the actual saved half-clear and remains in the second scene on another reconnect', () => {
    const parent = path.resolve(os.tmpdir()),
        dir = fs.mkdtempSync(path.join(parent, 'abyss-resume-')),
        file = path.join(dir, 'state.sqlite')
    let f = abyssFixture('abyss-resume-sql', file)
    try {
        const saved = checkpoint(f)
        f.store.close()
        f = abyssFixture('abyss-resume-sql', file, true)
        f.call('AbyssChallenge', f.request(2, 20001))
        const run = f.state().abyssRun
        assert.equal(run.part_index, 1)
        assert.deepEqual(run.heroAttrs, saved.heroAttrs)
        f.store.close()
        f = abyssFixture('abyss-resume-sql', file, true)
        assert.equal(f.state().world.map_id, run.rooms[1].map_id)
        assert.equal(f.state().abyssRun.total_battle_time, 40)
        assert.equal(f.state().abyssRun.phase, 'ready')
    } finally {
        f.store.close()
        if (path.dirname(path.resolve(dir)) !== parent || !path.basename(dir).startsWith('abyss-resume-'))
            throw Error('Unexpected cleanup target')
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
