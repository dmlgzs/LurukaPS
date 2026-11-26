import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Tables, seedPlayer, heroData } from '../src/player.js'
import { normalStarterAvatarOwnedConfigIds, selectNormalStarterAvatar } from '../src/normal-starter-avatar.js'
import { repairMainHeroType } from '../src/main-hero.js'
import { initializeCharacterFormation } from '../src/character-creation.js'
import { heroModules } from '../src/battle.js'
import { Protocol } from '../src/protocol.js'
import { ErrorCode } from '../src/error-codes.js'

const runtime = process.env.NORMAL_AVATAR_RUNTIME_ROOT ?? fileURLToPath(new URL('../', import.meta.url))
const tableRoot = process.env.LURUKAPS_TABLES ?? path.resolve(runtime, '../Tables/Tables')
const tables = new Tables(tableRoot)
const fresh = () => seedPlayer(tables, 718, 'normal-avatar-pure', { mode: 'normal' })
const applySex = (state, sex) => {
    const selected = selectNormalStarterAvatar(tables, state, sex)
    state.player.basic_info.sex = sex
    state.player.basic_info.wardrobe.sex = sex
    state.characterCustomized = true
    initializeCharacterFormation(tables, state)
    repairMainHeroType(tables, state)
    return selected
}
const configError = (fn, code = ErrorCode.GameConfig) => assert.throws(fn, (error) => error.code === code)

test('each initial sex selects one normal persona, retains FO1/owner GUID and publishes current config', () => {
    for (const [sex, config] of [
        [1, 199002],
        [2, 199001],
    ]) {
        const state = fresh()
        const loading = state.player.heros_info.heros[0].guid
        const selected = applySex(state, sex)
        assert.equal(selected.heroGuid, loading)
        assert.equal(state.player.heros_info.heros.length, 1)
        const actor = state.player.heros_info.heros[0]
        assert.equal(actor.guid, loading)
        assert.equal(actor.conf_id, config)
        assert.equal(actor.type, 1)
        assert.equal(BigInt(actor.guid) >> 56n, 1n)
        assert.equal(BigInt(actor.guid) & 0xffffffffn, 718n)
        assert.equal(state.normalStarterAvatar.phase, 'selected')
        assert.equal(state.normalStarterAvatar.configId, config)
        assert.equal(state.player.group_mgrs[0].groups[0].control, loading)
        assert.equal(heroModules(tables, state, actor).hero_conf_id, config)
    }
})

test('stable persona preserves progression, typed asset bindings, groups, battle vitals and receipt bytes', () => {
    const state = fresh()
    const actor = state.player.heros_info.heros[0]
    const id = actor.guid
    Object.assign(actor, {
        hero_lv: 23,
        hero_exp: 7,
        hero_rank: 2,
        hero_grade: 1,
        favorability_lv: 4,
        hero_skin: 199001,
        wguid: 31001,
        oguid: [41001],
        pet_id: '144115188075856590',
    })
    state.player.soulessence_infos.soulessences = [{ guid: 31001, id: tables.get('soulessence')[0].id, wear_hero: id }]
    state.ornaments = [{ guid: 41001, id: tables.get('accessory')[0].id, wear_hero: id }]
    state.pets = [{ guid: actor.pet_id, config_id: 100001, hero_id: id }]
    state.player.group_mgrs[0].groups[0].heros[0].pet_id = actor.pet_id
    state.player.heros_info.battle_infos = [{ hero_id: id, hp: 17, sp: 3, alive_state: 0 }]
    state.paidHistory = { receipt: { baseHash: 'opaque-paid-hash', actorGuid: id, originalConfig: 199001 } }
    const saved = structuredClone(state)
    const receiptBytes = JSON.stringify(state.paidHistory)
    applySex(state, 1)
    const selected = state.player.heros_info.heros[0]
    assert.deepEqual(selected, {
        ...saved.player.heros_info.heros[0],
        conf_id: 199002,
        hero_skin: 199002,
        trail: false,
    })
    for (const key of ['pets', 'ornaments', 'paidHistory']) assert.deepEqual(state[key], saved[key])
    assert.deepEqual(state.player.group_mgrs, saved.player.group_mgrs)
    assert.deepEqual(state.player.soulessence_infos, saved.player.soulessence_infos)
    assert.deepEqual(state.player.heros_info.battle_infos, saved.player.heros_info.battle_infos)
    assert.equal(JSON.stringify(state.paidHistory), receiptBytes)
})

test('normal existing appearance editor may switch the same persona both ways without granting another owned hero', () => {
    const state = fresh()
    state.player.heros_info.heros[0].hero_skin = 199001
    applySex(state, 1)
    const id = state.player.heros_info.heros[0].guid
    const revision = state.normalStarterAvatar.selectionRevision
    assert.equal(applySex(state, 1).changed, false)
    assert.equal(state.normalStarterAvatar.selectionRevision, revision)
    applySex(state, 2)
    assert.equal(state.player.heros_info.heros.length, 1)
    assert.equal(state.player.heros_info.heros[0].guid, id)
    assert.equal(state.player.heros_info.heros[0].hero_skin, 199001)
    assert.equal(state.normalStarterAvatar.selectionRevision, revision + 1)
})

test('normal persona equivalence is read-only and extra21 permanent type0 heroes survive both sex choices', () => {
    const state = fresh()
    const avatarIds = [199001, 199002]
    const ordinary = tables
        .get('hero')
        .filter((row) => row.isUsable === 1 && !avatarIds.includes(row.id))
        .map((row, index) => ({
            ...heroData(row.id, 718),
            hero_lv: index + 2,
            hero_exp: index + 7,
            favorability_lv: 2,
        }))
    assert.equal(ordinary.length, 21)
    state.player.heros_info.heros.push(...ordinary)
    state.explicitGmHistory = { command: 'allheroes', count: 21, opaqueReceiptHash: 'unchanged-paid-history' }
    const original = structuredClone(state)
    const actorId = state.normalStarterAvatar.guid
    const ids = normalStarterAvatarOwnedConfigIds(tables, state)
    assert.deepEqual(ids, avatarIds)
    ids.pop()
    assert.deepEqual(
        normalStarterAvatarOwnedConfigIds(tables, state),
        avatarIds,
        'returned configs cannot mutate persona metadata',
    )
    assert.deepEqual(state, original, 'equivalent ownership reader does not mutate saved facts')
    applySex(state, 1)
    assert.equal(state.player.heros_info.heros.length, 22)
    assert.equal(state.player.heros_info.heros.filter((hero) => hero.type === 1).length, 1)
    assert.equal(state.normalStarterAvatar.guid, actorId)
    assert.equal(state.player.heros_info.heros.find((hero) => hero.guid === actorId).conf_id, 199002)
    assert.deepEqual(
        state.player.heros_info.heros.filter((hero) => hero.guid !== actorId),
        ordinary,
    )
    assert.deepEqual(state.explicitGmHistory, original.explicitGmHistory)
    assert.deepEqual(normalStarterAvatarOwnedConfigIds(tables, state), avatarIds)
    applySex(state, 2)
    assert.equal(state.player.heros_info.heros.length, 22)
    assert.deepEqual(
        state.player.heros_info.heros.filter((hero) => hero.guid !== actorId),
        ordinary,
    )
    assert.deepEqual(state.explicitGmHistory, original.explicitGmHistory)
    assert.deepEqual(normalStarterAvatarOwnedConfigIds(tables, state), avatarIds)
})

test('persona equivalent configs reject another avatar, duplicate selected config and malformed marker without concealing assets', () => {
    for (const [mutate, code] of [
        [
            (state) => {
                state.player.heros_info.heros.push(heroData(199002, 718))
            },
            ErrorCode.FunctionClosed,
        ],
        [
            (state) => {
                state.player.heros_info.heros.push(heroData(199001, 719))
            },
            ErrorCode.GameConfig,
        ],
        [
            (state) => {
                state.normalStarterAvatar.guid = heroData(199001, 719).guid
            },
            ErrorCode.GameConfig,
        ],
        [
            (state) => {
                state.player.heros_info.heros.push(heroData(101003, 718, 1))
            },
            ErrorCode.GameConfig,
        ],
    ]) {
        const state = fresh()
        mutate(state)
        const before = structuredClone(state)
        const player = state.player
        configError(() => normalStarterAvatarOwnedConfigIds(tables, state), code)
        configError(() => selectNormalStarterAvatar(tables, state, 1), code)
        assert.deepEqual(state, before)
        assert.strictEqual(state.player, player)
    }
    for (const mode of ['legacy', 'sandbox']) {
        const state = fresh()
        if (mode === 'legacy') delete state.starterProfile
        else state.starterProfile.mode = 'sandbox'
        state.player.heros_info.heros.push(heroData(199002, 718))
        const before = structuredClone(state)
        assert.deepEqual(normalStarterAvatarOwnedConfigIds(tables, state), [])
        assert.deepEqual(state, before)
    }
})

test('legacy and sandbox ownership remains byte-for-byte untouched', () => {
    for (const mode of ['legacy', 'sandbox']) {
        const state = fresh()
        if (mode === 'legacy') delete state.starterProfile
        else state.starterProfile.mode = 'sandbox'
        state.player.heros_info.heros.push(heroData(199002, 718))
        const original = structuredClone(state)
        assert.equal(selectNormalStarterAvatar(tables, state, 1), null)
        assert.deepEqual(state, original)
    }
})

test('corrupted factory identity and separate GM avatar collision reject before state/reference mutation', () => {
    const mutations = [
        (s) => {
            s.normalStarterAvatar.guid = heroData(199001, 719).guid
        },
        (s) => {
            s.normalStarterAvatar.configId = 199002
        },
        (s) => {
            s.player.heros_info.heros[0].trail = true
        },
        (s) => {
            s.player.heros_info.heros.push(structuredClone(s.player.heros_info.heros[0]))
        },
        (s) => {
            s.player.heros_info.heros[0].wguid = 31001
        },
        (s) => {
            s.player.group_mgrs[0].groups[0].heros[0].hero_id = '0'
        },
    ]
    for (const mutate of mutations) {
        const state = fresh()
        mutate(state)
        const before = structuredClone(state)
        const player = state.player
        configError(() => selectNormalStarterAvatar(tables, state, 1))
        assert.deepEqual(state, before)
        assert.strictEqual(state.player, player)
    }
    const state = fresh()
    state.player.heros_info.heros.push(heroData(199002, 718))
    const before = structuredClone(state)
    configError(() => selectNormalStarterAvatar(tables, state, 1), ErrorCode.FunctionClosed)
    assert.deepEqual(state, before, 'explicit GM-owned opposite avatar is not deleted or merged')
})

test('pending actor execution and unproven custom skin transfer reject without changing paid facts', () => {
    for (const setup of [
        (s, id) => {
            s.combat = { skills: { [id]: { unit_id: id } } }
        },
        (s, id) => {
            s.combat = { bullets: { 19: { unit_id: id } } }
        },
        (s, id) => {
            s.combat = { elements: { 20: { tar_id: id } } }
        },
        (s, id) => {
            s.medicine = { tracked: { [id]: { receipt: 'paid-pending' } } }
        },
        (s) => {
            s.player.heros_info.heros[0].hero_skin = 101003
        },
    ]) {
        const state = fresh()
        setup(state, state.normalStarterAvatar.guid)
        const before = structuredClone(state)
        configError(() => selectNormalStarterAvatar(tables, state, 1), ErrorCode.FunctionClosed)
        assert.deepEqual(state, before)
    }
})

test('current incremental HeroStore consumer model keeps one GUID/default and uses nontrial payload config', () => {
    const protocol = new Protocol(runtime)
    const state = fresh()
    const cache = new Map()
    let defaultGuid
    const consume = () => {
        const wire = protocol.decode(
            'cs.PlayerHerosInfo',
            protocol.encode('cs.PlayerHerosInfo', state.player.heros_info),
        )
        for (const hero of wire.heros) {
            const id = BigInt(hero.guid)
            const previous = cache.get(hero.guid) ?? {}
            // Current 06029d39/06029d6c/06029d61 non-trial branch; no
            // synthetic deletion and no GUID-middle normal config lookup.
            cache.set(hero.guid, { ...previous, ...hero, serverConfigId: hero.conf_id, configId: hero.conf_id })
            if (hero.type === 1 && id >> 56n === 1n && (id & 0xffffffffn) === 718n) defaultGuid = hero.guid
        }
    }
    consume()
    const guid = defaultGuid
    applySex(state, 1)
    consume()
    assert.equal(cache.size, 1)
    assert.equal(defaultGuid, guid)
    assert.equal(cache.get(guid).configId, 199002)
    assert.equal(
        Number((BigInt(guid) >> 32n) & 0xffffffn),
        199001,
        'normal config does not come from this initial persona field',
    )
    const attributes = heroModules(tables, state, state.player.heros_info.heros[0])
    const attrWire = protocol.decode(
        'cs.SCHeroAttrInfoSync',
        protocol.encode('cs.SCHeroAttrInfoSync', { heros: [attributes] }),
    )
    assert.equal(attrWire.heros[0].hero_guid, guid)
    assert.equal(attrWire.heros[0].hero_conf_id, 199002)
})
