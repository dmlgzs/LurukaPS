import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { abyssFixture } from './abyss-fixture.js'
import { ErrorCode } from '../src/error-codes.js'
test('11451 materializes the actual first abyss scene and isolated FO30/31 snapshots before activation, without fabricating battle or stars', () => {
    const f = abyssFixture()
    try {
        const before = f.state(),
            packets = f.call('AbyssChallenge', f.request()),
            s = f.state(),
            run = s.abyssRun
        assert.equal(s.world.map_id, 6805)
        assert.equal(run.dungeon_id, 34760)
        assert.equal(run.phase, 'ready')
        assert.equal(s.player.group_mgrs.find((x) => x.type === 7).cur_group, 1)
        assert.equal(Number(BigInt(run.heroes[0].guid) >> 56n), 30)
        assert.equal(Number(BigInt(run.pets[0].guid) >> 56n), 31)
        assert.deepEqual(s.player.heros_info.heros, before.player.heros_info.heros)
        assert.deepEqual(s.pets, before.pets)
        assert.deepEqual(
            s.player.group_mgrs.find((x) => x.type === 1),
            before.player.group_mgrs.find((x) => x.type === 1),
        )
        assert(
            packets.findIndex((x) => x.id === 11460) < packets.findIndex((x) => x.id === 9103),
            'Copy data precedes scene/group activation',
        )
        assert.equal(f.decode(packets, 'SCProtoAbyssDungeonInfoSync').dungeon_id, 34760)
        const map = f.decode(packets, 'CSProtoWorldMapSync')
        assert.equal(map.map_id, 6805)
        assert.equal(f.decode(packets, 'CSProtoOnlineModeChange').mode, 5)
        const monsters = Object.values(s.combat.entities)
        assert.equal(monsters.length, 8)
        assert(monsters.every((x) => x.level === 40 && x.hp === x.max_hp && x.hp > 0))
        assert(s.worldObjects['6805:1500006'].active === false && s.worldObjects['6805:1500008'].active === false)
        const progress = f.decode(f.call('AbyssData'), 'CSProtoAbyssData').newer_mode_info[0]
        assert.equal(progress.passed, false)
        assert.equal(progress.star_num, 0)
        assert.equal(progress.challenge_list[0].win, false)
        assert.equal(progress.challenge_list[0].battle_time, 0)
        assert(!packets.some((x) => x.id === 11461), 'No synthetic dungeon completion')
    } finally {
        f.store.close()
    }
})
test('11451 rejects system, predecessor, ownership and room selection failures without locking a party or creating rewards', () => {
    const f = abyssFixture('abyss-challenge-gates')
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.taskRecords = s.taskRecords.filter((x) => x.task_id !== 107016)
        })
        assert.throws(
            () => f.call('AbyssChallenge', f.request()),
            (e) => e.code === ErrorCode.AbyssSysLock,
        )
        f.store.transact(f.session.id, 0, (s) => {
            s.taskRecords.push({ task_id: 107016, count: 1 })
        })
        assert.throws(
            () => f.call('AbyssChallenge', f.request(2, 20001)),
            (e) => e.code === ErrorCode.AbyssPreModeNotFinished,
        )
        const bad = f.request()
        bad.challenge_list[0].dungeon_id = 34770
        assert.throws(
            () => f.call('AbyssChallenge', bad),
            (e) => e.code === ErrorCode.AbyssInvalidDungeonID,
        )
        assert.equal(f.state().abyssRun, undefined)
        assert.equal(f.state().abyss, undefined)
    } finally {
        f.store.close()
    }
})
test('11451 entry encoding failure rolls back room, copy records and mode progress', () => {
    const f = abyssFixture('abyss-challenge-codec')
    try {
        const before = f.state(),
            encode = f.p.encode.bind(f.p)
        f.p.encode = (type, value) => {
            if (type === 'cs.SCAbyssDungeonInfoSync') throw Error('abyss entry codec')
            return encode(type, value)
        }
        assert.throws(() => f.call('AbyssChallenge', f.request()), /abyss entry codec/)
        f.p.encode = encode
        assert.deepEqual(f.state(), before)
        f.call('AbyssChallenge', f.request())
        assert.equal(f.state().world.map_id, 6805)
    } finally {
        f.store.close()
    }
})
test('11451 SQLite reconnect recovers the same ready room and immutable copy stats through actual dungeon-enter callback', () => {
    const parent = path.resolve(os.tmpdir()),
        temp = fs.mkdtempSync(path.join(parent, 'abyss-entry-')),
        file = path.join(temp, 'state.sqlite')
    let f = abyssFixture('abyss-challenge-sql', file)
    try {
        f.call('AbyssChallenge', f.request())
        const run = f.state().abyssRun
        f.store.close()
        f = abyssFixture('abyss-challenge-sql', file, true)
        assert.equal(f.state().world.map_id, 6805)
        assert.deepEqual(f.state().abyssRun.heroAttrs, run.heroAttrs)
        assert(f.login.some((x) => x.id === 11460) && f.login.some((x) => x.id === 11464))
        const entered = f.call('EnterDungeonScene', { scene_id: 6805 })
        assert.equal(f.decode(entered, 'CSProtoWorldMapSync').map_id, 6805)
        assert.equal(f.state().abyssRun.phase, 'ready')
    } finally {
        f.store.close()
        if (path.dirname(path.resolve(temp)) !== parent || !path.basename(temp).startsWith('abyss-entry-'))
            throw Error('Unexpected cleanup target')
        fs.rmSync(temp, { recursive: true, force: true })
    }
})
