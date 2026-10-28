import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { abyssFixture } from './abyss-fixture.js'
import { worldSync } from '../src/handlers/world.js'

function decoded(f, packets, name) {
    const p = f.p.byName.get(name)
    return packets.flatMap((packet, index) =>
        packet.id === p.id ? [{ index, value: f.p.decode(p.rsp, packet.payload) }] : [],
    )
}
function departureOrder(f, packets, destination, copies = []) {
    const maps = decoded(f, packets, 'CSProtoWorldMapSync'),
        cut = maps.find((p) => [49, 256].includes(p.value.cmd) && p.value.map_id === destination),
        prime = maps.find((p) => p.value.cmd === 47),
        groups = decoded(f, packets, 'CSProtoSyncPlayerData').filter((p) =>
            p.value.group_mgrs?.some((m) => m.type === 7),
        ),
        mode = decoded(f, packets, 'CSProtoOnlineModeChange').find((p) => p.value.mode === 1)
    assert(
        cut && prime && groups.length && mode,
        'departure publishes clear, true scene entry, final manager and ordinary mode',
    )
    assert(prime.index < cut.index)
    assert(
        groups.every((p) => p.index > cut.index),
        'no formation7 refresh before destination selected its proxy',
    )
    assert(mode.index > cut.index)
    for (const p of groups)
        for (const m of p.value.group_mgrs.filter((m) => m.type === 7))
            for (const g of m.groups ?? [])
                for (const slot of g.heros ?? [])
                    assert(
                        !copies.includes(slot.hero_id) && !copies.includes(slot.pet_id),
                        'retired actors are not reintroduced by an early captured group snapshot',
                    )
    return cut.value
}
function helperSync(f, cmd, edit) {
    const packets = []
    f.store.transact(f.session.id, 0, (state) => {
        edit?.(state)
        const push = (name, value) => packets.push(f.game.packet(name, value))
        worldSync(
            {
                id: f.session.id,
                state,
                tables: f.tables,
                now: f.time.now,
                previousMapId: state.world.map_id,
                push,
                pushBefore: push,
            },
            {},
            cmd,
        )
    })
    return packets
}

test('11463 publishes the real proxy barrier before emptygroup7, preserves original party/HP/control/rewards and ignores late retired actor packets', () => {
    const f = abyssFixture('abyss-exit-order')
    try {
        const owned = structuredClone(f.state()),
            party = structuredClone(owned.player.group_mgrs.find((m) => m.type === 1))
        f.call('AbyssChallenge', f.request())
        f.call('AbyssChallengeRealStart')
        const run = f.state().abyssRun,
            copies = [...run.heroes, ...run.pets].map((p) => p.guid),
            hero = run.heroes[0].guid
        f.call('BattleInfoReduce', { uint64_dic: [hero], battle_info: [{ hurt_info: { tar_id: '1', hp_change: -1 } }] })
        const packets = f.call('AbyssChallengeQuit'),
            s = f.state(),
            map = departureOrder(f, packets, owned.world.map_id, copies)
        assert.deepEqual(
            s.player.group_mgrs.find((m) => m.type === 1),
            party,
        )
        assert.deepEqual(s.player.heros_info.heros, owned.player.heros_info.heros)
        assert.deepEqual(s.pets, owned.pets)
        assert.deepEqual(s.player.sbag_infos, owned.player.sbag_infos)
        assert.deepEqual(s.player.heros_info.battle_infos, owned.player.heros_info.battle_infos)
        assert.deepEqual(s.world.pos, owned.world.pos)
        assert.equal(map.map_info.players[0].group.control, party.groups.find((g) => g.id === party.cur_group).control)
        assert.equal(s.abyssRun, undefined)
        assert.equal(s.combat, undefined)
        assert(copies.every((id) => s.retiredTrialActors.includes(id)))
        assert.equal(s.abyss.modes[1].levels[10001].passed, false)
        const record = structuredClone(s.abyss),
            late = f.call('SkillStop', { unit_id: hero, skill_id: 1 })
        assert.equal(late.length, 0) // Retired SkillStop is a one-way late notification, not an ACK request.
        assert.deepEqual(f.state().abyss, record)
        assert.equal(f.call('AbyssChallengeQuit').length, 1)
    } finally {
        f.store.close()
    }
})

test('11459 and real world-transfer callers preserve the barrier, early group repairs cannot restore ghosts, and same-map19/47 retain their original semantics', () => {
    const f = abyssFixture('abyss-exit-other-callers')
    try {
        const destination = f.state().world.map_id
        f.call('AbyssChallenge', f.request())
        departureOrder(f, f.call('AbyssChallengeReset', { mode: 1, abyss_level: 10001 }), destination)
        assert.equal(f.state().abyssRun, undefined)
        f.call('AbyssChallenge', f.request())
        const copies = [...f.state().abyssRun.heroes, ...f.state().abyssRun.pets].map((p) => p.guid)
        f.store.transact(f.session.id, 0, (s) => {
            s.homeFormationBackup = structuredClone(s.player.group_mgrs.find((m) => m.type === 1))
        })
        departureOrder(f, f.call('EnterWorldMap', { map_id: 100, point_id: 10045 }), 100, copies)
        assert.equal(f.state().abyssRun, undefined)
        assert.equal(f.state().homeFormationBackup, undefined)
        f.call('AbyssChallenge', f.request())
        for (const cmd of [19, 47]) {
            const run = structuredClone(f.state().abyssRun),
                packets = helperSync(f, cmd),
                maps = decoded(f, packets, 'CSProtoWorldMapSync')
            assert.equal(maps.length, 1)
            assert.equal(maps[0].value.cmd, cmd)
            assert.deepEqual(f.state().abyssRun, run)
            assert(!decoded(f, packets, 'CSProtoOnlineModeChange').some((p) => p.value.mode === 1))
        }
        // Explicit helper compatibility vector: an already authoritative map
        // departure must not be emitted as a cmd47 delta. This is not a claim
        // that the client sends cmd47 as a world-transfer request.
        const target = structuredClone(f.state().abyssRun.return_world)
        const packets = helperSync(f, 47, (s) => Object.assign(s.world, target))
        departureOrder(f, packets, target.map_id)
        assert.equal(f.state().abyssRun, undefined)
    } finally {
        f.store.close()
    }
})

test('late exit manager and real-map encoding or SQL failures roll back pending/state/disk; SQLite reconnect keeps the clean returned formation', () => {
    const parent = path.resolve(os.tmpdir()),
        dir = fs.mkdtempSync(path.join(parent, 'abyss-exit-order-')),
        file = path.join(dir, 'state.db')
    let f = abyssFixture('abyss-exit-atomic', file)
    try {
        const destination = f.state().world.map_id
        f.call('AbyssChallenge', f.request())
        f.call('AbyssChallengeRealStart')
        f.call('BattleInfoReduce', {
            uint64_dic: [f.state().abyssRun.heroes[0].guid],
            battle_info: [{ hurt_info: { tar_id: '1', hp_change: -1 } }],
        })
        const before = structuredClone(f.state()),
            pending = f.store.pending.get(f.session.id),
            disk = f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
            encode = f.p.encode.bind(f.p),
            mapType = f.p.byName.get('CSProtoWorldMapSync').rsp,
            playerType = f.p.byName.get('CSProtoSyncPlayerData').rsp
        assert(pending, 'nonfatal real battle damage leaves an original pending draft to protect')
        for (const point of ['map', 'formation']) {
            f.p.encode = (name, value) => {
                if (
                    (point === 'map' && name === mapType && [49, 256].includes(value.cmd)) ||
                    (point === 'formation' && name === playerType && value.group_mgrs?.some((m) => m.type === 7))
                )
                    throw Error('abyss-exit-order-codec')
                return encode(name, value)
            }
            assert.throws(() => f.call('AbyssChallengeQuit'), /abyss-exit-order-codec/)
            assert.deepEqual(f.state(), before)
            assert.strictEqual(f.store.pending.get(f.session.id), pending)
            assert.deepEqual(
                f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
                disk,
            )
            f.p.encode = encode
        }
        f.store.db.exec(
            "CREATE TEMP TRIGGER abyss_exit_abort BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'abyss-exit-order-sql'); END",
        )
        assert.throws(() => f.call('AbyssChallengeQuit'), /abyss-exit-order-sql/)
        assert.deepEqual(f.state(), before)
        assert.strictEqual(f.store.pending.get(f.session.id), pending)
        assert.deepEqual(
            f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
            disk,
        )
        f.store.db.exec('DROP TRIGGER abyss_exit_abort')
        departureOrder(f, f.call('AbyssChallengeQuit'), destination)
        const party = structuredClone(f.state().player.group_mgrs.find((m) => m.type === 1))
        f.store.close()
        f = abyssFixture('abyss-exit-atomic', file, true)
        assert.equal(f.state().world.map_id, destination)
        assert.equal(f.state().abyssRun, undefined)
        assert.deepEqual(
            f.state().player.group_mgrs.find((m) => m.type === 1),
            party,
        )
        assert(!f.state().player.heros_info.battle_infos.some((p) => BigInt(p.hero_id) >> 56n === 30n))
        assert.equal(f.call('AbyssChallengeQuit').length, 1)
    } finally {
        f.store.close()
        const target = path.resolve(dir)
        assert.equal(path.dirname(target), parent)
        assert(path.basename(target).startsWith('abyss-exit-order-'))
        fs.rmSync(target, { recursive: true, force: true })
    }
})
