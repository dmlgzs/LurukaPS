import { heroModules } from '../src/battle.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { Protocol } from '../src/protocol.js'
import { ornamentAttributes, ornamentSkills, runeBonuses } from '../src/hero-equipment.js'
import { trialOrnaments, trialRuneIds } from '../src/trial-equipment.js'
import { ornamentValueTables } from '../src/ornament-values.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables)
const trialHero = (row) => ({ guid: ((5n << 56n) | (BigInt(row.id) << 32n) | 1n).toString(), trail: true })
test('all nine existing interim sets resolve current grade-zero equipment without legacy random sub-attributes or owned bag state', () => {
    const rows = tables.get('hero_interim').filter((r) => r.accessorySet)
    assert.equal(rows.length, 9)
    const numeric = ornamentValueTables(tables)
    for (const row of rows) {
        const items = trialOrnaments(tables, row)
        assert.equal(items.length, 5)
        assert(items.every((x) => x.quality === 0 && x.grade === 0 && x.infos.length === 0))
        const state = { ornaments: [{ guid: 'unrelated', id: 1, wear_hero: 'owned' }] }
        const before = structuredClone(state),
            hero = trialHero(row)
        const attrs = ornamentAttributes(tables, state, hero)
        const mains = new Map()
        for (const item of items) {
            const c = numeric.find('accessory', item.id)
            const matching = numeric
                .get('accessory_main')
                .filter((x) => x.groupId === c.mainAttr && x.level === item.lv)
            assert(matching.length > 0)
            for (const main of matching) {
                const id = Number(String(main.battleInfo).split('|')[0])
                mains.set(id, (mains.get(id) ?? 0) + main.value)
            }
        }
        // Level-40 interim gear has no grade-zero entries. Higher tiers also
        // have current entry attributes, which must use the shared engine.
        if (row.id === 30003) assert.deepEqual(attrs, mains)
        else for (const [id, value] of mains) assert((attrs.get(id) ?? 0) >= value)
        const ownedHero = { guid: 'owned-control', oguid: items.map((_, index) => 'fixture-' + index) }
        const ownedState = {
            ornaments: items.map((item, index) => ({
                ...item,
                guid: ownedHero.oguid[index],
                wear_hero: ownedHero.guid,
            })),
        }
        assert.deepEqual(attrs, ornamentAttributes(tables, ownedState, ownedHero))
        const counts = new Map()
        for (const item of items) {
            const id = tables.find('accessory', item.id).setId
            if (id) counts.set(id, (counts.get(id) ?? 0) + 1)
        }
        const expected = new Set()
        for (const [id, count] of counts)
            for (const token of tables.find('accessory_set', id).skill.split('|')) {
                const [needed, skill] = token.split('#').map(Number)
                if (count >= needed) expected.add(skill)
            }
        const actual = ornamentSkills(tables, state, hero)
        assert(expected.size > 0)
        for (const id of expected) assert(actual.some((x) => x.skill_id === id))
        assert.deepEqual(state, before)
    }
})
test('5987 publishes virtual accessory attributes before scene loading completes and preserves owned equipment on repeated entry and exit', () => {
    // Contract fixture: existing authorized controller plus the exact real
    // equipped hero row. Routing itself is tested separately against real scenes.
    const local = new Tables(cfg.tables),
        actual = local.get('hero_interim')
    const equipment = actual.find((r) => r.id === 30003)
    local.cache.set(
        'hero_interim',
        actual.map((r) => (r.id === 107001 ? { ...equipment, id: r.id } : r)),
    )
    const protocol = new Protocol(cfg.base),
        store = new Store(':memory:'),
        game = new Game(protocol, store, local),
        session = {}
    let seq = 1
    const call = (name, request) => {
        const p = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: p.id, seq: seq++, payload: protocol.encode(p.req, request) })
            .map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    }
    const state = () => store.load(session.id).state
    try {
        call('EnterGame', { open_id: 'trial-ornament-fixture' })
        const owned = structuredClone({
            ornaments: state().ornaments,
            heroes: state().player.heros_info.heros,
            souls: state().player.soulessence_infos,
        })
        const request = { open: true, force: true, trial_heros: [{ id: 107001, pos: 0 }] }
        const packets = call('TrialGroupChange', request)
        const attrIndex = packets.findIndex((p) => p.id === 10006),
            actorIndex = packets.findIndex((p) => p.id === 5988)
        assert(attrIndex >= 0 && actorIndex > attrIndex)
        const wire = packets[attrIndex].data.heros.find((h) => h.hero_guid === state().trialGroup.heroes[0].guid)
        assert(wire.modules.find((m) => m.module_type === 2).sub_modules[0].attrs.attrs.length > 0)
        call('TrialGroupChange', request)
        call('TrialGroupChange', { open: false, force: true })
        assert.equal(state().trialGroup, undefined)
        assert.deepEqual(
            {
                ornaments: state().ornaments,
                heroes: state().player.heros_info.heros,
                souls: state().player.soulessence_infos,
            },
            owned,
        )
    } finally {
        store.close()
    }
})
test('invalid interim references, unknown talent modes and strict policy fail explicitly', () => {
    assert.throws(() => trialOrnaments(tables, { accessorySet: '999999' }), /configuration unavailable/)
    assert.throws(() => trialOrnaments(tables, { accessorySet: '201|201' }), /Invalid trial ornament/)
    assert.throws(
        () => trialRuneIds(tables, tables.find('hero_interim', 30003), 101010, 'closed'),
        /compatibility disabled/,
    )
    const local = new Tables(cfg.tables),
        actual = local.get('hero_interim')
    local.cache.set(
        'hero_interim',
        actual.map((r) => (r.id === 107001 ? { ...r, talentrune: 2 } : r)),
    )
    const protocol = new Protocol(cfg.base),
        store = new Store(':memory:'),
        game = new Game(protocol, store, local),
        session = {}
    let seq = 1
    const call = (name, request) => {
        const p = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: p.id, seq: seq++, payload: protocol.encode(p.req, request) })
    }
    try {
        call('EnterGame', { open_id: 'trial-talent-unresolved' })
        const before = structuredClone(store.load(session.id).state)
        assert.throws(
            () => call('TrialGroupChange', { open: true, force: true, trial_heros: [{ id: 107001, pos: 0 }] }),
            /Trial talent mode not implemented/,
        )
        assert.deepEqual(store.load(session.id).state, before)
    } finally {
        store.close()
    }
})

test('local trial policy uses all real current-rank slots without duplicating lower-rank automatic bonuses', () => {
    const rows = tables.get('hero_interim').filter((r) => r.talentrune)
    assert.equal(rows.length, 81)
    for (const row of rows) {
        const ids = trialRuneIds(tables, row),
            rank = tables.get('talent_rank').find((r) => r.heroId === row.heroId && r.rank === row.rank)
        assert.deepEqual(ids, rank.rankBreakthroughItem.split('|').map(Number))
        const hero = { conf_id: row.heroId, hero_rank: row.rank },
            noCurrent = runeBonuses(tables, hero)
        const active = runeBonuses(tables, { ...hero, rune_ids: ids }),
            expected = new Map(noCurrent.attrs)
        for (const id of ids)
            for (const token of String(tables.find('talent_rune', id).runeAttribute || '')
                .split('|')
                .filter(Boolean)) {
                const [attr, value] = token.split('#').map(Number)
                expected.set(attr, (expected.get(attr) ?? 0) + value)
            }
        assert.deepEqual(active.attrs, expected)
    }
    assert.deepEqual(trialRuneIds(tables, tables.find('hero_interim', 2109001)), [])
})

test('all nine real equipped trial rows build and encode complete hero modules with local current-rank talent policy', () => {
    const protocol = new Protocol(cfg.base),
        rows = tables.get('hero_interim').filter((r) => r.accessorySet)
    const heros = rows.map((row) =>
        heroModules(
            tables,
            { ornaments: [] },
            {
                ...trialHero(row),
                conf_id: row.heroId,
                hero_lv: row.level,
                hero_rank: row.rank,
                hero_star: row.starLevel,
                hero_grade: row.gradeLevel,
                system_skill_levels: row.skilllevel.split('|').map(Number),
                rune_ids: trialRuneIds(tables, row),
            },
        ),
    )
    const type = protocol.byId.get(10006).rsp,
        decoded = protocol.decode(type, protocol.encode(type, { heros }))
    assert.equal(decoded.heros.length, 9)
    for (const hero of decoded.heros) {
        assert.equal(hero.type, 5)
        const ornament = hero.modules.find((m) => m.module_type === 2).sub_modules[0]
        assert(ornament.attrs.attrs.length > 0)
        assert(ornament.skills.skills.length > 0)
    }
})
