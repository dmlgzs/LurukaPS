import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const project = fs.realpathSync(
    process.env.LURUKAPS_MAP_MEMBER_TEST_ROOT ?? fileURLToPath(new URL('../', import.meta.url)),
)
const base = pathToFileURL(project + path.sep)
const { configuration } = await import(new URL('src/config.js', base))
const { Tables, seedPlayer } = await import(new URL('src/player.js', base))
const { currentMapMember } = await import(new URL('src/current-map-member.js', base))
const { arenaTrainer } = await import(new URL('src/npc-kibo-trainer.js', base))
const { ActivityCatalog } = await import(new URL('src/activities.js', base))
const { ensureCultFormation } = await import(new URL('src/cult-formation.js', base))
const { abyssChallengeRoster } = await import(new URL('src/abyss-roster.js', base))
const { abyssRoute } = await import(new URL('src/abyss-catalog.js', base))
const { ErrorCode } = await import(new URL('src/error-codes.js', base))
const { Protocol } = await import(new URL('src/protocol.js', base))
const { EntrustCatalog, entrustMultiBaseSnapshot } = await import(new URL('src/entrust.js', base))
const tables = new Tables(configuration().tables),
    accountId = 12
const seed = seedPlayer(tables, accountId, 'map-member-pure-contract')
const duel = tables.find('kibo_duel', 502)
assert(duel?.trialRole)
const trainer = arenaTrainer(tables, seed, duel)
const catalog = new ActivityCatalog(tables)

// All mode/container selections below are synthetic pure projection contexts.
// Actors come from current roster factories. No request admission, task state,
// story completion, battle result or client/renderer effect is fabricated.
function normal() {
    const state = structuredClone(seed)
    const heroes = state.player.heros_info.heros.filter((hero) => hero.conf_id !== trainer.conf_id).slice(0, 3)
    assert.equal(heroes.length, 3)
    const manager = state.player.group_mgrs.find((row) => row.type === 1)
    manager.cur_group = 1
    const group = manager.groups.find((row) => row.id === 1)
    group.heros = heroes.map((hero) => ({ hero_id: hero.guid, pet_id: '0' }))
    group.control = heroes[1].guid
    return { state, heroes, manager, group }
}
function trial({ mixed = false } = {}) {
    const fixture = normal(),
        { state, heroes, manager } = fixture
    const actor = arenaTrainer(tables, state, duel)
    state.trialGroup = { heroes: [actor], pets: [] }
    const selected = mixed ? [heroes[0], actor, heroes[2]] : [actor]
    const group = {
        id: 0,
        group_name: Buffer.from('pure-trial-selection').toString('base64'),
        heros: [
            ...selected.map((hero) => ({ hero_id: hero.guid, pet_id: '0' })),
            ...Array.from({ length: 3 - selected.length }, () => ({ hero_id: '0', pet_id: '0' })),
        ],
        control: actor.guid,
    }
    manager.groups = manager.groups.filter((row) => row.id !== 0)
    manager.groups.push(group)
    manager.cur_group = 0
    return { ...fixture, group, actor, selected }
}
const expected = (heroes, control) => ({
    control_hero: control.conf_id,
    hero_list: heroes.map((hero) => ({
        hero_id: hero.conf_id,
        hero_level: hero.hero_lv,
        hero_skin_id: hero.hero_skin || hero.conf_id,
    })),
})
function projectUnchanged(state, options) {
    const before = structuredClone(state)
    try {
        return currentMapMember(state, accountId, options)
    } finally {
        assert.deepEqual(state, before, 'member projection must not mutate any state/owned asset/temporary actor')
    }
}
function rejects(state, code, options) {
    const before = structuredClone(state)
    assert.throws(
        () => currentMapMember(state, accountId, options),
        (error) => error.code === code,
    )
    assert.deepEqual(state, before)
}

test('pure current normal formation preserves slot order, selected control and isolated appearance payload', () => {
    const { state, heroes } = normal()
    const result = projectUnchanged(state)
    assert.equal(result.pid, accountId)
    assert.deepEqual(result.data.group, expected(heroes, heroes[1]))
    const before = structuredClone(state)
    result.data.wardrobe.height = 999
    result.data.clothes.extra = 'output-only'
    assert.deepEqual(state, before)
})

test('synthetic pure mgr1 group0 projects the registered current factory trial hero instead of owned fallback', () => {
    const { state, actor } = trial()
    assert.equal(BigInt(actor.guid) >> 56n, 5n)
    assert(!state.player.heros_info.heros.some((hero) => hero.guid === actor.guid))
    assert.deepEqual(projectUnchanged(state).data.group, expected([actor], actor))
})

test('synthetic mixed mgr1 group0 retains all owned/trial slots and both legal control choices', () => {
    const { state, group, actor, selected } = trial({ mixed: true })
    for (const control of [actor, selected[2]]) {
        group.control = control.guid
        assert.deepEqual(projectUnchanged(state).data.group, expected(selected, control))
    }
})

test('current Cult roster factory selects same-map mgr8 and returns to normal after crossing map scope', () => {
    const { state, heroes } = normal(),
        normalMap = state.world.map_id
    assert(tables.find('world_city', 6550))
    state.world.map_id = 6550
    state.cultTrial = { activity_id: 60001, map_id: 6550 }
    assert.equal(ensureCultFormation(tables, catalog, state, accountId), true)
    const selected = state.cultTrial.heroes
    const manager = state.player.group_mgrs.find((row) => row.type === 8)
    manager.groups.find((row) => row.id === manager.cur_group).control = selected[2].guid
    assert.deepEqual(projectUnchanged(state).data.group, expected(selected, selected[2]))
    state.world.map_id = normalMap
    assert.deepEqual(projectUnchanged(state).data.group, expected(heroes, heroes[1]))
})

test('current Abyss roster factory selects same-map mgr7 copies and returns to normal outside its map', () => {
    const { state, heroes } = normal(),
        normalMap = state.world.map_id
    const level = tables.find('abbys_level', 10001)
    const dungeon = Number(level.dungeonId),
        { route } = abyssRoute(tables, dungeon)
    const request = {
        challenge_list: [
            {
                dungeon_id: dungeon,
                control: heroes[1].guid,
                heros: [
                    { index: 0, hero: { hero_guid: heroes[0].guid, pet_guid: '0' } },
                    { index: 1, hero: { hero_guid: heroes[1].guid, pet_guid: '0' } },
                    { index: 2, hero: { hero_guid: '0', pet_guid: '0' } },
                ],
            },
        ],
    }
    const roster = abyssChallengeRoster(tables, state, level, request),
        challenge = roster.challenges[0]
    assert(roster.heroes.every((hero) => BigInt(hero.guid) >> 56n === 30n))
    state.world.map_id = route.map_id
    state.abyssRun = { map_id: route.map_id, heroes: roster.heroes, pets: roster.pets }
    state.player.group_mgrs = state.player.group_mgrs.filter((row) => row.type !== 7)
    state.player.group_mgrs.push({
        type: 7,
        cur_group: 1,
        src: 0,
        groups: [
            {
                id: 1,
                control: challenge.control,
                heros: challenge.heros.map((slot) => ({ hero_id: slot.hero.hero_guid, pet_id: slot.hero.pet_guid })),
            },
        ],
    })
    assert.deepEqual(projectUnchanged(state).data.group, expected(roster.heroes, roster.heroes[1]))
    state.world.map_id = normalMap
    assert.deepEqual(projectUnchanged(state).data.group, expected(heroes, heroes[1]))
})

test('missing selected registry actors or active groups reject by named errors without filtering into owned fallback', () => {
    const missing = normal()
    missing.group.heros[1].hero_id = '360287974484606977'
    rejects(missing.state, ErrorCode.HeroNotExist)
    const absent = normal()
    absent.manager.cur_group = 99999
    rejects(absent.state, ErrorCode.GameConfig)
    const absentManager = normal()
    absentManager.state.player.group_mgrs = absentManager.state.player.group_mgrs.filter((row) => row.type !== 1)
    rejects(absentManager.state, ErrorCode.GameConfig)
})

test('duplicate active slots and ambiguous registry identities do not silently choose a first match', () => {
    const repeated = normal()
    repeated.group.heros[1].hero_id = repeated.group.heros[0].hero_id
    rejects(repeated.state, ErrorCode.GameConfig)
    const ambiguous = normal()
    ambiguous.state.player.heros_info.heros.push(structuredClone(ambiguous.heroes[0]))
    rejects(ambiguous.state, ErrorCode.GameConfig)
})

test('control must identify a selected active slot rather than zero or an unselected registered hero', () => {
    for (const value of ['0', '999999999']) {
        const fixture = normal()
        fixture.group.control = value
        rejects(fixture.state, ErrorCode.GameConfig)
    }
    const fixture = trial({ mixed: true })
    fixture.group.control = fixture.heroes[1].guid
    rejects(fixture.state, ErrorCode.GameConfig)
})

test('explicit arena override retains owned/current registered trainer contract and rejects stale or changed payloads', () => {
    const { state, heroes } = normal()
    assert.deepEqual(projectUnchanged(state, { hero: heroes[0] }).data.group, expected([heroes[0]], heroes[0]))
    state.world.map_id = duel.mapId
    state.multiCampaign = { duel_id: duel.id }
    state.npcArenaTrialTrainer = { duel_id: duel.id, map_id: duel.mapId, hero: structuredClone(trainer) }
    state.player.group_mgrs = []
    assert.deepEqual(projectUnchanged(state, { hero: trainer }).data.group, expected([trainer], trainer))
    rejects(state, ErrorCode.GameConfig, { hero: { ...trainer, hero_lv: trainer.hero_lv + 1 } })
    state.npcArenaTrialTrainer.map_id++
    rejects(state, ErrorCode.GameConfig, { hero: trainer })
})

test('pure current material and weekly9567 neighbor snapshots preserve the normal active member through the real codec', () => {
    const protocol = new Protocol(configuration().base)
    const entry = protocol.byId.get(9567)
    assert.equal(entry.name, 'CSProtoMultiCampaignBaseInfoSync')
    const catalogue = new EntrustCatalog(tables)
    for (const [kind, id] of [
        ['material', 30101],
        ['weekly', 101],
    ]) {
        const { state, heroes } = normal()
        const route = catalogue.get(id, kind)
        // Selection-only neighbor context. No unlock/task/result or request
        // admission is injected or claimed by constructing this run/map pair.
        state.world.map_id = route.scene.id
        state.entrust = { run: { kind, dungeon_id: route.dungeon.id, map_id: route.scene.id } }
        const before = structuredClone(state)
        const payload = entrustMultiBaseSnapshot(tables, state, accountId)
        const decoded = protocol.decode(entry.rsp, protocol.encode(entry.rsp, payload))
        assert.equal(payload.dungeon_id, route.dungeon.id)
        assert.equal(payload.dungeon_scene_id, route.scene.id)
        assert.equal(decoded.dungeon_id, route.dungeon.id)
        assert.equal(decoded.dungeon_scene_id, route.scene.id)
        assert.equal(decoded.player_list.length, 1)
        assert.equal(String(decoded.player_list[0].pid), String(accountId))
        assert.deepEqual(payload.player_list[0].data.group, expected(heroes, heroes[1]))
        assert.deepEqual(decoded.player_list[0].data.group, expected(heroes, heroes[1]))
        assert.deepEqual(state, before)
    }
})
