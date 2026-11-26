import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables, seedPlayer } from '../src/player.js'
import { Store } from '../src/store.js'
import { Protocol } from '../src/protocol.js'
import { trialOrnaments, trialRuneIds } from '../src/trial-equipment.js'
import { heroModules } from '../src/battle.js'
import { ornamentAttributes, ornamentSkills } from '../src/hero-equipment.js'
import { ornamentEntryEffects } from '../src/ornament-entry-effects.js'
import { createCustomOrnaments } from '../src/ornaments.js'
import { ErrorCode } from '../src/error-codes.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
const heroFor = (row) => ({
    guid: ((5n << 56n) | (BigInt(row.id) << 32n) | 1n).toString(),
    conf_id: row.heroId,
    hero_lv: row.level,
    hero_rank: row.rank,
    hero_star: row.starLevel,
    hero_grade: row.gradeLevel,
    system_skill_levels: row.skilllevel.split('|').map(Number),
    rune_ids: trialRuneIds(tables, row),
    trail: true,
    type: row.heroType,
    wguid: 0,
    pet_id: '0',
    favorability_lv: 1,
})
const code = (expected) => (error) => error.code === expected
function provider(overrides = {}) {
    return {
        get(name) {
            assert.notEqual(name, 'accessory_interim', 'never read a legacy interim equipment table')
            return overrides[name] ?? tables.get(name)
        },
        find(name, id) {
            assert.notEqual(name, 'accessory_interim', 'never fallback to legacy interim equipment IDs')
            return this.get(name).find((row) => row.id === id)
        },
    }
}
const projection = (source, state, hero) => {
    const entry = protocol.byName.get('CSProtoHeroAttrInfoSync')
    return protocol.decode(entry.rsp, protocol.encode(entry.rsp, { heros: [heroModules(source, state, hero)] }))
        .heros[0]
}
const equipment = (info) =>
    info.modules.find((module) => module.module_type === 2).sub_modules.find((sub) => sub.sub_module_id === 0)

test('current four linked loadouts parse id/level/grade/quality exactly; missing64701 hero remains a separate current reference gap', () => {
    for (const id of [624601, 624602, 6000033, 64701]) {
        const row = tables.find('hero_interim', id),
            items = trialOrnaments(provider(), row)
        assert.equal(items.length, 5)
        assert.deepEqual(items[0], {
            id: id === 6000033 ? 1371711 : 1467311,
            lv: id === 6000033 ? 1 : 5,
            grade: 1,
            quality: 1,
            infos: [],
        })
        assert(items.every((item) => item.grade === 1 && item.quality === 1 && item.infos.length === 0))
        assert.equal(!!tables.find('hero', row.heroId), id !== 64701)
    }
    assert.equal(tables.find('hero_interim', 64701).heroId, 199011)
})

test('current short tuple tails default to zero and plain IDs never become accessory_interim keys', () => {
    const source = provider()
    for (const [text, expected] of [
        ['1467311', { lv: 0, grade: 0, quality: 0 }],
        ['1467311#5', { lv: 5, grade: 0, quality: 0 }],
        ['1467311#5#1', { lv: 5, grade: 1, quality: 0 }],
    ]) {
        assert.deepEqual(trialOrnaments(source, { accessorySet: text }), [{ id: 1467311, ...expected, infos: [] }])
    }
    assert.deepEqual(
        trialOrnaments(source, { accessorySet: '1467311#5#1#1|1467411' }).map((item) => item.quality),
        [1, 0],
    )
    assert(!tables.find('accessory', 201))
    assert.throws(() => trialOrnaments(source, { accessorySet: '201' }), code(ErrorCode.OrnamentConfFail))
})

test('three actual tuple sets reach real attribute/skill wire modules and survive save reload without owned equipment grants', () => {
    const store = new Store(':memory:')
    try {
        const login = store.login('current-trial-equipment', (id, name) => seedPlayer(tables, id, name))
        store.transact(login.id, 0, (state) => {
            createCustomOrnaments(tables, state, 50001, 1, () => 0)
        })
        const before = store.load(login.id).state
        const expected = new Map([
            [624601, { hp: 2306, def: 99, atk: 100 }],
            [624602, { hp: 2306, def: 99, atk: 100 }],
            [6000033, { hp: 1608, def: 54, atk: 105 }],
        ])
        const serialized = []
        for (const [id, want] of expected) {
            const row = tables.find('hero_interim', id),
                hero = heroFor(row),
                items = trialOrnaments(tables, row),
                effects = ornamentEntryEffects(tables, items)
            assert(effects.entries.length > 0, 'configured grade1 entries are actually consumed')
            assert.equal(
                effects.skills.length,
                0,
                'these current grade1 entries are stat entries; do not invent battle skills from entry IDs',
            )
            const info = projection(tables, before, hero),
                sub = equipment(info),
                attrs = new Map(sub.attrs.attrs.map((row) => [row.attr_id, Number(row.attr_val)]))
            assert.equal(attrs.get(2005), want.hp)
            assert.equal(attrs.get(2003), want.def)
            assert.equal(attrs.get(2001), want.atk)
            assert.deepEqual(
                sub.skills.skills.map((row) => row.skill_id).sort((a, b) => a - b),
                [19998208, 19998209],
            )
            assert.deepEqual(new Map(ornamentAttributes(tables, before, hero)), attrs)
            assert.deepEqual(
                ornamentSkills(tables, before, hero)
                    .map((row) => row.skill_id)
                    .sort((a, b) => a - b),
                [19998208, 19998209],
            )
            const noQuality = provider({
                hero_interim: tables.get('hero_interim').map((item) =>
                    item.id === id
                        ? {
                              ...item,
                              accessorySet: item.accessorySet
                                  .split('|')
                                  .map((token) => {
                                      const p = token.split('#')
                                      p[3] = '0'
                                      return p.join('#')
                                  })
                                  .join('|'),
                          }
                        : item,
                ),
            })
            assert(
                attrs.get(2005) > ornamentAttributes(noQuality, before, hero).get(2005),
                'quality1 current main-attribute multiplier is retained',
            )
            serialized.push({ id, hero, info })
            assert.deepEqual(
                projection(tables, before, hero),
                info,
                'repeated projection neither rerolls nor mutates cached gear',
            )
        }
        store.transact(login.id, 0, (state) => {
            state.trialEquipmentVerification = serialized.map(({ id, hero }) => ({ id, hero }))
        })
        const saved = store.load(login.id).state,
            assets = (state) => ({
                ornaments: state.ornaments,
                heros: state.player.heros_info,
                souls: state.player.soulessence_infos,
                bag: state.player.sbag_infos,
                nextOrnamentGuid: state.nextOrnamentGuid,
            })
        assert.deepEqual(assets(saved), assets(before))
        for (const { id, hero } of saved.trialEquipmentVerification) {
            const want = serialized.find((item) => item.id === id)
            assert.deepEqual(projection(tables, saved, hero), want.info)
        }
        assert.deepEqual(
            assets(store.load(login.id).state),
            assets(before),
            'save reload/projection adds no owned GUID, bag or acquisition',
        )
    } finally {
        store.close()
    }
})

test('returning to an unequipped owned actor explicitly clears module2 attributes and skills', () => {
    const row = tables.find('hero_interim', 624601),
        hero = heroFor(row),
        state = seedPlayer(tables, 1, 'trial-cache-clear')
    const before = structuredClone(state),
        active = equipment(projection(tables, state, hero))
    assert(active.attrs.attrs.length > 0 && active.skills.skills.length > 0)
    const owned = { ...hero, guid: '12345', trail: false, oguid: [] }
    const cleared = equipment(projection(tables, state, owned))
    assert.deepEqual(cleared.attrs.attrs, [])
    assert.deepEqual(cleared.skills.skills, [])
    assert.deepEqual(state, before)
})

test('malformed tuples and unknown current level/grade/quality reject instead of truncating or flattening values', () => {
    for (const accessorySet of [
        '0#1#1#1',
        '1467311#-1#1#1',
        '1467311##1#1',
        '1467311#1#1#1#1',
        '1467311#1.5#1#1',
        '1467311#4294967296#1#1',
        '1467311|1467311',
    ])
        assert.throws(() => trialOrnaments(tables, { accessorySet }), code(ErrorCode.GameConfig))
    assert.throws(() => trialOrnaments(tables, { accessorySet: '4294967295#1#1#1' }), code(ErrorCode.OrnamentConfFail))
    assert.throws(() => trialOrnaments(tables, { accessorySet: '1467311#999#1#1' }), code(ErrorCode.OrnamentConfFail))
    assert.throws(() => trialOrnaments(tables, { accessorySet: '1467311#5#999#1' }), code(ErrorCode.GameConfig))
    assert.throws(() => trialOrnaments(tables, { accessorySet: '1467311#5#1#999' }), code(ErrorCode.OrnamentConfFail))
    const damaged = tables.find('hero_interim', 9000013)
    assert(damaged.accessorySet.split('|').some((token) => token.split('#').length > 4))
    assert.throws(
        () => trialOrnaments(tables, damaged),
        code(ErrorCode.GameConfig),
        'actual unlinked malformed debug row is not silently repaired',
    )
})

test('missing current attribute and entry definitions reject the temporary loadout before it can be accepted', () => {
    const row = tables.find('hero_interim', 624601),
        first = tables.find('accessory', 1467311)
    const mains = provider({
        accessory_main: tables
            .get('accessory_main')
            .filter((item) => !(item.groupId === first.mainAttr && item.level === 5)),
    })
    assert.throws(() => trialOrnaments(mains, row), code(ErrorCode.OrnamentConfFail))
    const quality = provider({ accessory_quality: tables.get('accessory_quality').filter((item) => item.id !== 1) })
    assert.throws(() => trialOrnaments(quality, row), code(ErrorCode.OrnamentConfFail))
    const entry = tables.get('accessory_skillEntry').find((item) => item.groupId === first.subAttr && item.star <= 1)
    assert(entry)
    const missingEntry = provider({
        skill_entry: tables
            .get('skill_entry')
            .filter((item) => !(item.skillEntryId === entry.skillId && item.skillLv === entry.skillLv)),
    })
    assert.throws(() => trialOrnaments(missingEntry, row), code(ErrorCode.GameConfig))
})
