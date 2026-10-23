import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { abyssFixture } from './abyss-fixture.js'
import { heroData } from '../src/player.js'
import { petData } from '../src/pets.js'
import { abyssPetGuid, abyssHeroGuid } from '../src/abyss-roster.js'
import { ErrorCode } from '../src/error-codes.js'
// Exact identities/configs and both slot orders from the two 2026-10-23 14:19
// failures; create independent actors in a temporary test account, not a copy of
// the user's database or inventory.
const actors = [
    ['72912296824799233', 199001, 1, '146263792710320134', 500261],
    ['72521459095830529', 108002, 0, '500752', 500752],
    ['72521454800863233', 108001, 0, '146262980961501189', 500072],
]
function fixture(name = 'abyss-legacy', file = ':memory:', resume = false) {
    const f = abyssFixture(name, file, resume)
    if (!resume)
        f.store.transact(f.session.id, 0, (s) => {
            s.player.heros_info.heros = actors.map(([guid, id, type, pet]) => ({
                ...heroData(id, f.session.id, type),
                guid,
                pet_id: pet,
            }))
            s.pets = actors.map(([hero, , , guid, id]) => ({ ...petData(f.tables, id, guid, 1), hero_id: hero }))
        })
    const request = (order = [0, 1, 2]) => ({
        mode: 1,
        abyss_level: 10001,
        challenge_list: [
            {
                heros: order.map((i, index) => ({ index, hero: { pet_guid: actors[i][3], hero_guid: actors[i][0] } })),
                protect_enemy_list: [],
                dungeon_id: 34760,
                control: actors[0][0],
                buff_id: 0,
                win: false,
                battle_time: 0,
                dead_hero_num: 0,
            },
        ],
    })
    return { ...f, request }
}
const reject = (f, r, code = ErrorCode.AbyssInvalidTroop) => {
    const before = structuredClone(f.state())
    assert.throws(
        () => f.call('AbyssChallenge', r),
        (e) => e.code === code,
    )
    assert.deepEqual(f.state(), before)
}

test('both logged11451 slot orders admit exact owned legacy pet500752, preserve real GUIDs and create FO31/source_guid snapshots', () => {
    for (const order of [
        [0, 1, 2],
        [0, 2, 1],
    ]) {
        const f = fixture('abyss-logged-' + order.join(''))
        try {
            const before = structuredClone(f.state()),
                packets = f.call('AbyssChallenge', f.request(order)),
                s = f.state()
            assert.equal(s.world.map_id, 6805)
            assert.equal(s.abyssRun.dungeon_id, 34760)
            const copy = s.abyssRun.pets.find((p) => p.source_guid === '500752')
            assert.equal(copy.guid, abyssPetGuid('500752'))
            assert.equal(Number(BigInt(copy.guid) >> 56n), 31)
            assert.deepEqual(s.pets, before.pets)
            assert.deepEqual(s.player.heros_info.heros, before.player.heros_info.heros)
            assert(packets.some((p) => p.id === 11460))
            assert(packets.some((p) => p.id === 11464))
            const wire = f.decode(packets, 'CSProtoAbyssHeroInfoSync')
            const wirePet = wire.pets.find((p) => p.guid === copy.guid)
            assert.equal(wirePet.config_id, 500752, 'full copy model uses explicit config_id, not GUID bit inference')
            assert.equal(Object.hasOwn(wirePet, 'source_guid'), false, 'source_guid is server-only, not a wire mapping')
            assert.equal(f.p.type('PetbaseInfo').fields.source_guid, undefined)
            assert(wire.heros.some((hero) => hero.pet_id === wirePet.guid))
        } finally {
            f.store.close()
        }
    }
})
test('unknown legacy, typed alias of a legacy source, foreign and invalid actor types cannot borrow low56 ownership', () => {
    const f = fixture()
    try {
        for (const id of [
            '500753',
            ((2n << 56n) | 500752n).toString(),
            ((9n << 56n) | 500752n).toString(),
            ((1n << 56n) | 500752n).toString(),
        ]) {
            const r = f.request()
            r.challenge_list[0].heros[1].hero.pet_guid = id
            reject(f, r)
        }
        f.store.transact(f.session.id, 0, (s) => (s.pets = s.pets.filter((p) => p.guid !== '500752')))
        reject(f, f.request())
        const copy = f.request()
        copy.challenge_list[0].heros[1].hero.pet_guid = abyssPetGuid('500752')
        reject(f, copy)
    } finally {
        f.store.close()
    }
})
test('trial flags and trial-type records never become permanent merely because their GUID is legacy', () => {
    for (const [flag, value] of [
        ['trail', true],
        ['trial', true],
        ['is_trial', true],
        ['abyss', true],
        ['type', 2],
    ]) {
        const f = fixture('abyss-trial-' + flag)
        try {
            f.store.transact(f.session.id, 0, (s) => (s.pets.find((p) => p.guid === '500752')[flag] = value))
            reject(f, f.request())
        } finally {
            f.store.close()
        }
    }
})
test('an exact permanent/trial registry overlap is rejected instead of treating the trial slot as owned', () => {
    const f = fixture()
    try {
        f.store.transact(
            f.session.id,
            0,
            (s) => (s.trialGroup = { pets: [structuredClone(s.pets.find((p) => p.guid === '500752'))] }),
        )
        reject(f, f.request())
    } finally {
        f.store.close()
    }
})
test('typed and legacy low56 collisions and duplicate permanent records reject both exact and copy forms atomically', () => {
    for (const duplicate of [false, true]) {
        const f = fixture('abyss-collision-' + duplicate)
        try {
            f.store.transact(f.session.id, 0, (s) => {
                const source = s.pets.find((p) => p.guid === '500752')
                s.pets.push({
                    ...structuredClone(source),
                    guid: duplicate ? '500752' : ((2n << 56n) | 500752n).toString(),
                })
            })
            const exact = f.request()
            reject(f, exact)
            const copy = f.request()
            copy.challenge_list[0].heros[1].hero.pet_guid = abyssPetGuid('500752')
            reject(f, copy)
        } finally {
            f.store.close()
        }
    }
})
test('FO30/31 round trips uniquely resolve permanent source GUIDs, and original/copy aliases still count as duplicate actors', () => {
    const f = fixture()
    try {
        const r = f.request()
        for (const slot of r.challenge_list[0].heros) {
            slot.hero.hero_guid = abyssHeroGuid(slot.hero.hero_guid)
            slot.hero.pet_guid = abyssPetGuid(slot.hero.pet_guid)
        }
        r.challenge_list[0].control = abyssHeroGuid(actors[0][0])
        f.call('AbyssChallenge', r)
        assert(f.state().abyssRun.pets.some((p) => p.source_guid === '500752'))
        f.call('AbyssChallengeQuit')
        const pets = f.request()
        pets.challenge_list[0].heros[2].hero.pet_guid = abyssPetGuid('500752')
        reject(f, pets, ErrorCode.AbyssPetRepeated)
        const heroes = f.request()
        heroes.challenge_list[0].heros[2].hero.hero_guid = abyssHeroGuid(actors[1][0])
        reject(f, heroes, ErrorCode.AbyssHeroRepeated)
    } finally {
        f.store.close()
    }
})
test('legacy roster entry encoding failure rolls back all copies, formation, scene and permanent inventory', () => {
    const f = fixture()
    try {
        const before = structuredClone(f.state()),
            encode = f.p.encode.bind(f.p)
        f.p.encode = (type, value) => {
            if (type === 'cs.SCAbyssDungeonInfoSync') throw Error('legacy abyss codec')
            return encode(type, value)
        }
        try {
            assert.throws(() => f.call('AbyssChallenge', f.request()), /legacy abyss codec/)
        } finally {
            f.p.encode = encode
        }
        assert.deepEqual(f.state(), before)
        f.call('AbyssChallenge', f.request())
        assert.equal(f.state().abyssRun.pets.find((p) => p.source_guid === '500752').guid, abyssPetGuid('500752'))
    } finally {
        f.store.close()
    }
})
test('real temporary SQLite restart preserves legacy permanent identities and the isolated copy source mapping', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luruka-abyss-legacy-')),
        file = path.join(dir, 'test.sqlite')
    let f
    try {
        f = fixture('abyss-legacy-reopen', file)
        f.call('AbyssChallenge', f.request())
        const pets = structuredClone(f.state().pets),
            copies = structuredClone(f.state().abyssRun.pets)
        f.store.close()
        f = null
        f = fixture('abyss-legacy-reopen', file, true)
        f.call('EnterDungeonScene', { scene_id: 6805 })
        assert.deepEqual(f.state().pets, pets)
        assert.deepEqual(f.state().abyssRun.pets, copies)
        assert(f.state().pets.some((p) => p.guid === '500752'))
        assert.equal(f.state().abyssRun.pets.find((p) => p.source_guid === '500752').guid, abyssPetGuid('500752'))
    } finally {
        f?.store.close()
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('legacy half-clear checkpoint resumes through copy31 aliases into the next real room without changing permanent source IDs', () => {
    const f = fixture('abyss-legacy-checkpoint')
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.abyss = { modes: { 1: { levels: { 10007: { passed: true, star_num: 3 } } } } }
        })
        const request = {
            mode: 2,
            abyss_level: 20001,
            challenge_list: [34830, 34840].map((dungeon_id, i) => ({
                dungeon_id,
                control: actors[i + 1][0],
                heros: [
                    { index: 0, hero: { hero_guid: actors[i + 1][0], pet_guid: i === 0 ? '500752' : '0' } },
                    { index: 1, hero: { hero_guid: '0', pet_guid: '0' } },
                    { index: 2, hero: { hero_guid: '0', pet_guid: '0' } },
                ],
            })),
        }
        const permanent = structuredClone(f.state().pets)
        f.call('AbyssChallenge', request)
        f.call('AbyssChallengeRealStart')
        f.time.now += 40
        for (let step = 0; step < 128 && f.state().abyssRun.phase === 'running'; step++) {
            const s = f.state(), run = s.abyssRun
            const enemy = Object.values(s.combat.entities).find((x) => run.wave_objects.includes(x.object_id) && x.hp > 0)
            assert(enemy, 'active configured wave has a live enemy')
            f.call('BattleInfoReduce', {
                uint64_dic: [run.challenges[0].control, enemy.uuid],
                battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -enemy.hp } }],
            })
        }
        assert.equal(f.state().abyssRun.phase, 'won')
        f.call('AbyssChallengeQuit')
        const saved = structuredClone(f.state().abyss.modes[2].levels[20001].resume)
        assert(saved.pets.some((pet) => pet.source_guid === '500752'))
        const copied = structuredClone(request)
        for (const part of copied.challenge_list) {
            part.control = abyssHeroGuid(part.control)
            for (const slot of part.heros) {
                if (slot.hero.hero_guid !== '0') slot.hero.hero_guid = abyssHeroGuid(slot.hero.hero_guid)
                if (slot.hero.pet_guid !== '0') slot.hero.pet_guid = abyssPetGuid(slot.hero.pet_guid)
            }
        }
        f.call('AbyssChallenge', copied)
        const run = f.state().abyssRun
        assert.equal(run.part_index, 1)
        assert.equal(run.map_id, run.rooms[1].map_id)
        assert.deepEqual(run.pets, saved.pets)
        assert.deepEqual(f.state().pets, permanent)
    } finally { f.store.close() }
})
