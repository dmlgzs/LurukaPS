import test from 'node:test'
import assert from 'node:assert/strict'
import { abyssFixture } from './abyss-fixture.js'
import { ErrorCode } from '../src/error-codes.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
function enter(f) {
    f.store.transact(f.session.id, 0, (s) => {
        s.abyss = { modes: { 1: { levels: { 10007: { passed: true, star_num: 3 } }, starClaims: [] } } }
    })
    return f.call('AbyssChallenge', f.request(2, 20001))
}
function clearRoom(f) {
    let packets
    while (f.state().abyssRun.phase === 'running') {
        const s = f.state(),
            run = s.abyssRun,
            targets = Object.values(s.combat.entities).filter((x) => run.wave_objects.includes(x.object_id) && x.hp > 0)
        assert(targets.length > 0)
        for (const target of targets)
            packets = f.call('BattleInfoReduce', {
                uint64_dic: [
                    run.heroes.find((x) => x.guid === run.challenges[run.part_index].control).guid,
                    target.uuid,
                ],
                battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -target.hp } }],
            })
    }
    return packets
}
test('11458 requires actual room victory, loads the table-defined next scene/team, and only the last room completes a two-part level', () => {
    const f = abyssFixture('abyss-next')
    try {
        const owned = f.state().player.group_mgrs.find((x) => x.type === 1)
        enter(f)
        assert.throws(
            () => f.call('AbyssChallengeNext'),
            (e) => e.code === ErrorCode.AbyssInvalidChallengeLevel,
        )
        f.call('AbyssChallengeRealStart')
        f.time.now += 80
        const first = clearRoom(f),
            completed = f.state().abyssRun,
            firstEnd = f.decode(first, 'CSProtoAbyssDungeonEndSync')
        assert.equal(firstEnd.last_dungeon, false)
        assert.equal(firstEnd.state, 3)
        assert.equal(f.state().abyss.modes[2].levels[20001].passed, false)
        const packets = f.call('AbyssChallengeNext'),
            second = f.state().abyssRun,
            map = f.decode(packets, 'CSProtoWorldMapSync')
        assert.equal(second.part_index, 1)
        assert.equal(second.phase, 'ready')
        assert.equal(second.dungeon_id, completed.rooms[1].dungeon_id)
        assert.equal(map.map_id, completed.rooms[1].map_id)
        assert.notEqual(map.map_id, completed.map_id)
        assert.equal(second.total_battle_time, 80)
        assert.equal(f.state().player.group_mgrs.find((x) => x.type === 7).cur_group, 2)
        assert.equal(
            f.state().player.group_mgrs.find((x) => x.type === 7).groups[1].control,
            second.challenges[1].control,
        )
        assert.notEqual(second.challenges[0].control, second.challenges[1].control)
        assert(
            packets.findIndex((x) => x.id === 11460) <
                packets.findIndex(
                    (x) =>
                        x.id === 9103 && f.p.decode(f.p.byName.get('CSProtoWorldMapSync').rsp, x.payload).cmd === 256,
                ),
        )
        assert.equal(f.state().combat.map_id, second.map_id)
        assert(Object.values(f.state().combat.entities).every((x) => x.hp === x.max_hp && x.hp > 0))
        const before = f.state().abyssRun
        f.call('AbyssChallengeNext')
        assert.deepEqual(f.state().abyssRun, before)
        f.call('AbyssChallengeRealStart')
        f.time.now += 90
        const last = clearRoom(f),
            end = f.decode(last, 'CSProtoAbyssDungeonEndSync')
        assert.equal(end.last_dungeon, true)
        assert.equal(end.total_cost_time, 170)
        assert.equal(end.star, 3)
        assert.equal(f.state().abyss.modes[2].levels[20001].passed, true)
        assert(f.state().abyss.modes[2].levels[20001].challenge_list.every((x) => x.win))
        assert.deepEqual(
            f.state().player.group_mgrs.find((x) => x.type === 1),
            owned,
        )
        assert.throws(
            () => f.call('AbyssChallengeNext'),
            (e) => e.code === ErrorCode.AbyssInvalidChallengeLevel,
        )
    } finally {
        f.store.close()
    }
})
test('11458 next scene encoding failure retains the won room, cumulative time and unmodified second team', () => {
    const f = abyssFixture('abyss-next-codec')
    try {
        enter(f)
        f.call('AbyssChallengeRealStart')
        f.time.now += 25
        clearRoom(f)
        const before = f.state(),
            encode = f.p.encode.bind(f.p),
            type = f.p.byName.get('CSProtoWorldMapSync').rsp
        f.p.encode = (t, v) => {
            if (t === type) throw Error('abyss next codec')
            return encode(t, v)
        }
        assert.throws(() => f.call('AbyssChallengeNext'), /abyss next codec/)
        f.p.encode = encode
        assert.deepEqual(f.state(), before)
        f.call('AbyssChallengeNext')
        assert.equal(f.state().abyssRun.part_index, 1)
    } finally {
        f.store.close()
    }
})
test('11458 SQLite resumes a won first room and retains the second-room identity after transition and reconnect', () => {
    const parent = path.resolve(os.tmpdir()),
        dir = fs.mkdtempSync(path.join(parent, 'abyss-next-')),
        file = path.join(dir, 'state.sqlite')
    let f = abyssFixture('abyss-next-sql', file)
    try {
        enter(f)
        f.call('AbyssChallengeRealStart')
        f.time.now += 25
        clearRoom(f)
        const first = f.state().abyssRun
        f.store.close()
        f = abyssFixture('abyss-next-sql', file, true)
        f.time.now += 25
        assert.equal(f.state().abyssRun.phase, 'won')
        f.call('AbyssChallengeNext')
        const next = f.state().abyssRun
        assert.equal(next.total_battle_time, 25)
        assert.equal(next.part_index, 1)
        f.store.close()
        f = abyssFixture('abyss-next-sql', file, true)
        assert.equal(f.state().world.map_id, next.map_id)
        assert.notEqual(f.state().world.map_id, first.map_id)
        assert.equal(f.state().abyssRun.phase, 'ready')
        assert.equal(f.state().player.group_mgrs.find((x) => x.type === 7).cur_group, 2)
        const callback = f.call('EnterDungeonScene', { scene_id: next.map_id })
        assert.equal(f.decode(callback, 'CSProtoWorldMapSync').map_id, next.map_id)
        assert.equal(f.state().abyss.modes[2].levels[20001].passed, false)
    } finally {
        f.store.close()
        if (path.dirname(path.resolve(dir)) !== parent || !path.basename(dir).startsWith('abyss-next-'))
            throw Error('Unexpected cleanup target')
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
