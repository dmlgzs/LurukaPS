import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { abyssFixture } from './abyss-fixture.js'
import { abyssBuffPlan } from '../src/abyss-buffs.js'

function maps(f, packets) {
    const entry = f.p.byName.get('CSProtoWorldMapSync')
    return packets.filter((x) => x.id === entry.id).map((x) => f.p.decode(entry.rsp, x.payload))
}
function applyMapElements(cache, packets) {
    for (const packet of packets) {
        const change = packet.map_info?.map_ele?.hero_ele
        if (!change) continue
        // Match UpdateElementList: an absent/empty repeated all is null in CBT3.
        if (change.all?.length) {
            cache.clear()
            for (const id of change.all) cache.add(id)
            continue
        }
        for (const id of change.del ?? []) cache.delete(id)
        for (const id of change.add ?? []) cache.add(id)
    }
}
function rotation(f) {
    f.store.transact(f.session.id, 0, (s) => {
        s.abyss = {
            modes: {
                1: { levels: { 10007: { passed: true, star_num: 3 } } },
                2: { levels: { 20007: { passed: true, star_num: 3 } } },
            },
        }
    })
    const request = f.request(3, 30001)
    request.challenge_list[0].buff_id = 2030001
    request.challenge_list[1].buff_id = 2030002
    return request
}
function clearRoom(f) {
    while (f.state().abyssRun.phase === 'running') {
        const s = f.state(),
            run = s.abyssRun
        for (const enemy of Object.values(s.combat.entities).filter(
            (x) => run.wave_objects.includes(x.object_id) && x.hp > 0,
        ))
            f.call('BattleInfoReduce', {
                uint64_dic: [run.challenges[run.part_index].control, enemy.uuid],
                battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -enemy.hp } }],
            })
    }
    assert.equal(f.state().abyssRun.phase, 'won')
}

test('hero elements prime before independent records and formation, remain in actual scene entry, and preserve real actor attributes', () => {
    const f = abyssFixture('abyss-hero-map-entry')
    try {
        const before = f.state(),
            packets = f.call('AbyssChallenge', f.request()),
            run = f.state().abyssRun
        const mapPackets = maps(f, packets),
            expected = abyssBuffPlan(f.tables, run).hero
        assert.equal(mapPackets.length, 2)
        assert.equal(mapPackets[0].cmd, 47)
        assert.equal(mapPackets[0].map_info.players.length, 0)
        assert.equal(mapPackets[0].map_info.objs.length, 0)
        assert.deepEqual(mapPackets[0].map_info.map_ele.hero_ele.add, expected)
        assert.equal(mapPackets[1].cmd, 256)
        assert.deepEqual(mapPackets[1].map_info.map_ele.hero_ele.add, expected)
        assert(packets.findIndex((x) => x.id === 9103) < packets.findIndex((x) => x.id === 11460))
        const cache = new Set([999999])
        applyMapElements(cache, mapPackets)
        assert.deepEqual(
            [...cache].sort((a, b) => a - b),
            [...expected, 999999].sort((a, b) => a - b),
        )
        assert.deepEqual(run.map_hero_element_ids, expected)
        assert.deepEqual(f.state().player.heros_info.heros, before.player.heros_info.heros)
        assert.deepEqual(f.state().pets, before.pets)
        assert.deepEqual(f.state().abyssRun.heroAttrs, run.heroAttrs)
    } finally {
        f.store.close()
    }
})

test('different half team buffs replace only the previous configured IDs before any new hero creation and clear before ordinary formation restoration', () => {
    const f = abyssFixture('abyss-hero-map-next')
    try {
        const cache = new Set([999999]),
            request = rotation(f)
        applyMapElements(cache, maps(f, f.call('AbyssChallenge', request)))
        assert(cache.has(17001204))
        f.call('AbyssChallengeRealStart')
        clearRoom(f)
        const next = f.call('AbyssChallengeNext'),
            mapPackets = maps(f, next)
        assert(next.findIndex((x) => x.id === 9103) < next.findIndex((x) => x.id === 11460))
        assert.deepEqual(mapPackets[0].map_info.map_ele.hero_ele.del, [17001203, 17001204])
        applyMapElements(cache, mapPackets)
        assert.deepEqual(
            [...cache].sort((a, b) => a - b),
            [999999, 17001203].sort((a, b) => a - b),
        )
        const quit = f.call('AbyssChallengeQuit'),
            quitMaps = maps(f, quit)
        assert.equal(quitMaps[0].cmd, 47)
        assert.deepEqual(quitMaps[0].map_info.map_ele.hero_ele.del, [17001203])
        assert.equal(quitMaps[0].map_info.map_ele.hero_ele.add.length, 0)
        const restoreIndex = quit.findIndex((x) => x.id === 5008)
        assert(restoreIndex >= 0 && quit.findIndex((x) => x.id === 9103) < restoreIndex)
        applyMapElements(cache, quitMaps)
        assert.deepEqual([...cache], [999999])
        assert.equal(f.state().abyssRun, undefined)
    } finally {
        f.store.close()
    }
})

test('retry and repeated dungeon-enter callbacks retain one effective element per config ID without changing the frozen modules', () => {
    const f = abyssFixture('abyss-hero-map-retry')
    try {
        const cache = new Set()
        applyMapElements(cache, maps(f, f.call('AbyssChallenge', f.request())))
        const before = f.state().abyssRun
        for (const name of ['AbyssChallengeRetry', 'EnterDungeonScene', 'EnterDungeonScene']) {
            const packets = f.call(name, name === 'EnterDungeonScene' ? { scene_id: before.map_id } : {})
            applyMapElements(cache, maps(f, packets))
            assert.deepEqual([...cache], before.map_hero_element_ids)
            assert.deepEqual(f.state().abyssRun.heroAttrs, before.heroAttrs)
            assert.deepEqual(f.state().abyssRun.heroes, before.heroes)
            assert.deepEqual(f.state().abyssRun.pets, before.pets)
        }
    } finally {
        f.store.close()
    }
})

test('map element encoding failures roll back entry, next-half and exit cache ownership together with existing run state', () => {
    const f = abyssFixture('abyss-hero-map-codec')
    try {
        const type = f.p.byName.get('CSProtoWorldMapSync').rsp,
            encode = f.p.encode.bind(f.p)
        const fail = (name, request) => {
            const before = f.state()
            f.p.encode = (t, value) => {
                if (t === type && value.map_info?.map_ele) throw Error('hero map element codec')
                return encode(t, value)
            }
            assert.throws(() => f.call(name, request), /hero map element codec/)
            f.p.encode = encode
            assert.deepEqual(f.state(), before)
        }
        const request = rotation(f)
        fail('AbyssChallenge', request)
        f.call('AbyssChallenge', request)
        f.call('AbyssChallengeRealStart')
        clearRoom(f)
        fail('AbyssChallengeNext')
        f.call('AbyssChallengeNext')
        fail('AbyssChallengeQuit')
        f.call('AbyssChallengeQuit')
    } finally {
        f.store.close()
    }
})

test('nonlethal hero and pet reports do not republish map elements or write SQLite', () => {
    const f = abyssFixture('abyss-hero-map-combat')
    try {
        f.call('AbyssChallenge', f.request())
        f.call('AbyssChallengeRealStart')
        const db = () => f.store.db.prepare('select state,revision from players where account_id=?').get(f.session.id)
        const before = db(),
            requestCount = f.store.db.prepare('select count(*) n from request_log').get().n
        const s = f.state(),
            enemy = Object.values(s.combat.entities).find((x) => s.abyssRun.wave_objects.includes(x.object_id))
        for (let i = 0; i < 20; i++) {
            const source = (i % 2 ? s.abyssRun.pets : s.abyssRun.heroes)[0].guid
            const packets = f.call('BattleInfoReduce', {
                uint64_dic: [source, enemy.uuid],
                battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -1 } }],
            })
            assert.equal(maps(f, packets).length, 0)
        }
        assert.deepEqual(db(), before)
        assert.equal(f.store.db.prepare('select count(*) n from request_log').get().n, requestCount)
        assert.equal(f.state().combat.entities[enemy.uuid].hp, enemy.max_hp - 20)
        assert.deepEqual(f.state().abyssRun.heroAttrs, s.abyssRun.heroAttrs)
    } finally {
        f.store.close()
    }
})

test('a world transfer bypassing the quit protocol deletes only published hero elements before normal world activation', () => {
    const f = abyssFixture('abyss-hero-map-transfer')
    try {
        const cache = new Set([999999])
        applyMapElements(cache, maps(f, f.call('AbyssChallenge', f.request())))
        const ids = f.state().abyssRun.map_hero_element_ids
        const packets = f.call('EnterWorldMap', { map_id: 100, point_id: 10045 }),
            mapPackets = maps(f, packets)
        assert.equal(mapPackets[0].cmd, 47)
        assert.deepEqual(mapPackets[0].map_info.map_ele.hero_ele.del, ids)
        assert.equal(mapPackets.at(-1).cmd, 256)
        applyMapElements(cache, mapPackets)
        assert.deepEqual([...cache], [999999])
        assert.equal(f.state().world.map_id, 100)
        assert.equal(f.state().abyssRun, undefined)
    } finally {
        f.store.close()
    }
})

test('SQLite reconnection and actual enter callback restore the same map list and retired ordinary world receives explicit deletion', () => {
    const parent = path.resolve(os.tmpdir()),
        dir = fs.mkdtempSync(path.join(parent, 'abyss-hero-map-')),
        file = path.join(dir, 'state.sqlite')
    let f = abyssFixture('abyss-hero-map-sql', file)
    try {
        f.call('AbyssChallenge', f.request())
        const run = f.state().abyssRun
        f.store.close()
        f = abyssFixture('abyss-hero-map-sql', file, true)
        const cache = new Set()
        applyMapElements(cache, maps(f, f.login))
        applyMapElements(cache, maps(f, f.call('EnterDungeonScene', { scene_id: run.map_id })))
        assert.deepEqual([...cache], run.map_hero_element_ids)
        assert.deepEqual(f.state().abyssRun.heroAttrs, run.heroAttrs)
        assert.deepEqual(f.state().abyssRun.heroes, run.heroes)
        applyMapElements(cache, maps(f, f.call('AbyssChallengeQuit')))
        assert.equal(cache.size, 0)
    } finally {
        f.store.close()
        if (path.dirname(path.resolve(dir)) !== parent || !path.basename(dir).startsWith('abyss-hero-map-'))
            throw Error('Unexpected cleanup target')
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
