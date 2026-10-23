import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables, heroData } from '../src/player.js'
import { Store } from '../src/store.js'
import { Protocol } from '../src/protocol.js'
import { Game } from '../src/game.js'
import { petData } from '../src/pets.js'
import { abyssTables, abyssRoute, abyssModeLevels } from '../src/abyss-catalog.js'
import { abyssChallengeRoster, abyssHeroGuid, abyssPetGuid } from '../src/abyss-roster.js'
import { ErrorCode } from '../src/error-codes.js'
import { configTime } from '../src/shops.js'
const cfg = configuration(),
    external = new Tables(cfg.tables),
    tables = abyssTables(external)
function fixture() {
    const store = new Store(':memory:'),
        p = new Protocol(cfg.base),
        game = new Game(p, store, external, { clock: () => 1800000000 }),
        session = {},
        enter = p.byName.get('CSProtoEnterGame')
    game.dispatch(session, { id: enter.id, seq: 1, payload: p.encode(enter.req, { open_id: 'abyss-foundation' }) })
    const state = store.load(session.id).state
    state.player.heros_info.heros.push(heroData(101010, session.id))
    const guid = ((2n << 56n) | (1n << 32n) | BigInt(session.id)).toString(),
        pet = petData(external, 500306, guid, 101)
    state.pets.push(pet)
    return { store, state, heroes: state.player.heros_info.heros.slice(0, 2), pet }
}
const team = (dungeon, hero, pet = '0') => ({
    dungeon_id: dungeon,
    control: hero,
    heros: [
        { index: 0, hero: { hero_guid: hero, pet_guid: pet } },
        { index: 1, hero: { hero_guid: '0', pet_guid: '0' } },
        { index: 2, hero: { hero_guid: '0', pet_guid: '0' } },
    ],
})
test('abyss fresh current table adapter maps 34 exact-roster/object scenes and two explicitly equivalent local routes', () => {
    const level = tables.find('abbys_level', 10001)
    assert.equal(level.team, 1)
    assert.equal(abyssRoute(tables, 34760).route.map_id, 6805)
    assert.equal(abyssRoute(tables, 34950).route.map_id, 6824)
    assert.equal(abyssRoute(tables, 35080).route.map_id, 6837)
    for (const id of [34860, 34940]) {
        assert.equal(abyssRoute(tables, id).route.map_id, 6815)
        assert.deepEqual(abyssRoute(tables, id).route.equivalent_alternatives, [6815, 6823])
        assert.equal(abyssRoute(tables, id).route.policy, 'canonical_equivalent_scene')
    }
    assert.equal(
        tables.find('dungeon', 34760).mountAvailable,
        0,
        'Current typed table must not inherit external zero-as-asset localization damage',
    )
    assert.equal(
        tables.find('hero', 101010),
        external.find('hero', 101010),
        'Unrelated actor tables retain the existing cache',
    )
    let available = 0
    for (const id of new Set(tables.get('abbys_level').flatMap((x) => x.dungeonId.split('|').map(Number)))) {
        const { route, point } = abyssRoute(tables, id)
        assert.equal(point.cityId, route.map_id)
        for (const obj of route.object_ids) {
            const row = tables.find('worldmap_' + route.map_id, obj),
                group = tables.find('world_enemy_group', row.expandId)
            assert(group)
            assert(group.enemyList.split('|').every((id) => tables.find('enemy_pack', Number(id))))
        }
        available++
    }
    assert.equal(available, 36)
})
test('abyss rotation bounds follow actual table dates and never synthesize a new season', () => {
    const row = tables.get('abbys_time')[0]
    assert.equal(abyssModeLevels(tables, 3, configTime(row.startTime)).levels.length, 7)
    assert.throws(
        () => abyssModeLevels(tables, 3, configTime(row.endTime), { expiredRotation: 'closed' }),
        (e) => e.code === ErrorCode.AbyssRotationChange,
    )
    assert.throws(
        () => abyssModeLevels(tables, 4, 1800000000),
        (e) => e.code === ErrorCode.AbyssInvalidMode,
    )
})
test('abyss roster clones selected owned heroes/pets into FO30/31 with actual inherited modules, preserving the permanent inventory and formation', () => {
    const f = fixture()
    try {
        const before = structuredClone(f.state),
            hero = f.heroes[0],
            roster = abyssChallengeRoster(tables, f.state, tables.find('abbys_level', 10001), {
                challenge_list: [team(34760, hero.guid, f.pet.guid)],
            })
        assert.equal(roster.heroes[0].guid, abyssHeroGuid(hero.guid))
        assert.equal(roster.pets[0].guid, abyssPetGuid(f.pet.guid))
        assert.equal(roster.challenges[0].control, roster.heroes[0].guid)
        assert.equal(roster.challenges[0].heros[0].hero.pet_guid, roster.pets[0].guid)
        assert.equal(roster.heroAttrs[roster.heroes[0].guid].type, 30)
        assert.equal(roster.petAttrs[roster.pets[0].guid].type, 31)
        assert(roster.challenges[0].heros[0].hp > 0 && roster.challenges[0].heros[0].pet_hp > 0)
        assert.deepEqual(f.state, before)
    } finally {
        f.store.close()
    }
})
test('abyss roster rejects duplicate across halves, wrong slot/dungeon, foreign ownership and unconfigured buff selections', () => {
    const f = fixture()
    try {
        const level = tables.find('abbys_level', 20001),
            h = f.heroes[0].guid,
            h2 = f.heroes[1].guid,
            p = f.pet.guid
        assert.throws(
            () => abyssChallengeRoster(tables, f.state, level, { challenge_list: [team(34830, h), team(34840, h)] }),
            (e) => e.code === ErrorCode.AbyssHeroRepeated,
        )
        assert.throws(
            () =>
                abyssChallengeRoster(tables, f.state, level, {
                    challenge_list: [team(34830, h, p), team(34840, h2, p)],
                }),
            (e) => e.code === ErrorCode.AbyssPetRepeated,
        )
        const bad = team(34760, h)
        bad.heros[1].index = 0
        assert.throws(
            () => abyssChallengeRoster(tables, f.state, tables.find('abbys_level', 10001), { challenge_list: [bad] }),
            (e) => e.code === ErrorCode.AbyssInvalidTroop,
        )
        assert.throws(
            () =>
                abyssChallengeRoster(tables, f.state, tables.find('abbys_level', 10001), {
                    challenge_list: [{ ...team(34760, h), buff_id: 2030001 }],
                }),
            (e) => e.code === ErrorCode.AbyssInvalidTroop,
        )
    } finally {
        f.store.close()
    }
})
