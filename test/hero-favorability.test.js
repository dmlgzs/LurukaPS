import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { ErrorCode } from '../src/error-codes.js'
import { heroFavorabilityPlan, grantHeroFavorability } from '../src/hero-favorability.js'
import { achievementFixture } from './achievement-fixture.js'

const tables = new Tables(configuration().tables)
const heroes = tables.get('hero').filter((row) => row.favor === 1)
function state(heroId = 101003, level = 1, exp = 0) {
    return {
        world: { map_id: 100 },
        player: {
            heros_info: {
                heros: [
                    {
                        guid: '18446744073709550000',
                        conf_id: heroId,
                        trail: false,
                        favorability_lv: level,
                        favorability_exp: exp,
                        store_favor_rewards: [],
                    },
                ],
            },
            attr_infos: { attrs: [{ attr_id: 4, attr_val: '2850' }] },
        },
    }
}
function data(overrides = {}) {
    return {
        get(name) {
            return Object.hasOwn(overrides, name) ? overrides[name] : tables.get(name)
        },
    }
}
function actor(s) {
    return s.player.heros_info.heros[0]
}
const id = '18446744073709550000'

test('personal favor helper uses all 21 current qualified heroes and every real level threshold', () => {
    assert.equal(heroes.length, 21)
    const curve = tables.get('hero_favorability_exp')
    for (const hero of heroes)
        for (const row of curve.filter((r) => r.favorabilityLevel < 10)) {
            const s = state(hero.id, row.favorabilityLevel, row.favorabilityExp - 1)
            const plan = grantHeroFavorability(tables, s, id, 1)
            assert.equal(plan.level, row.favorabilityLevel + 1)
            assert.equal(plan.exp, 0)
            assert.equal(plan.applied, 1)
            const info = tables
                .get('hero_favorability_info')
                .find((i) => i.heroId === hero.id && i.favorabilityLevel === plan.level)
            assert.deepEqual(actor(s).store_favor_rewards, info.reward ? [info.id] : [])
            assert.deepEqual(s.player.attr_infos.attrs, [{ attr_id: 4, attr_val: '2850' }])
        }
})
test('personal favor plans are pure and applying changes only the explicitly selected owned hero', () => {
    const s = state(),
        other = { guid: '2', conf_id: 101007, trail: false, favorability_lv: 1, favorability_exp: 0 }
    s.player.heros_info.heros.push(other)
    const before = structuredClone(s)
    const plan = heroFavorabilityPlan(tables, s, id, 150)
    assert.deepEqual(s, before)
    assert.equal(plan.exp, 150)
    grantHeroFavorability(tables, s, id, 150)
    assert.equal(actor(s).favorability_exp, 150)
    assert.deepEqual(other, before.player.heros_info.heros[1])
    assert.deepEqual(s.player.attr_infos, before.player.attr_infos)
    assert.equal(s.player.heros_info.heros.length, 2)
})
test('personal favor multi-level gains keep grade remainder and queue actual level rewards once', () => {
    const s = state(101003, 1, 1950)
    const plan = grantHeroFavorability(tables, s, id, 7600)
    assert.equal(plan.level, 4)
    assert.equal(plan.exp, 50)
    assert.deepEqual(plan.unlockedRewardIds, [10100302, 10100304])
    assert.deepEqual(actor(s).store_favor_rewards, [10100302, 10100304])
    const old = structuredClone(s)
    const noop = grantHeroFavorability(tables, s, id, 0)
    assert.equal(noop.applied, 0)
    assert.deepEqual(s, old)
})
test('personal favor at maximum uses the existing zero remainder convention and reports capped amount', () => {
    const s = state(101003, 9, 15950)
    let plan = grantHeroFavorability(tables, s, id, 200)
    assert.equal(plan.applied, 50)
    assert.equal(plan.capped, 150)
    assert.equal(actor(s).favorability_lv, 10)
    assert.equal(actor(s).favorability_exp, 0)
    assert.deepEqual(actor(s).store_favor_rewards, [10100310])
    const before = structuredClone(s)
    plan = grantHeroFavorability(tables, s, id, 0xffffffff)
    assert.equal(plan.applied, 0)
    assert.equal(plan.capped, 0xffffffff)
    assert.deepEqual(s, before)
})
test('personal favor rejects missing or malformed curve and reward structures without default constants', () => {
    const base = tables.get('hero_favorability_exp'),
        info = tables.get('hero_favorability_info')
    const curves = [
        [],
        base.filter((r) => r.favorabilityLevel !== 0),
        base.filter((r) => r.favorabilityLevel !== 4),
        [...base, base[0]],
        base.map((r) => (r.favorabilityLevel === 2 ? { ...r, favorabilityExp: 0 } : r)),
        base.map((r) => (r.favorabilityLevel === 10 ? { ...r, favorabilityExp: 1 } : r)),
        base.map((r) => (r.favorabilityLevel === 1 ? { ...r, favorabilityExp: 2.5 } : r)),
    ]
    for (const curve of curves) {
        const s = state(),
            before = structuredClone(s)
        assert.throws(() => grantHeroFavorability(data({ hero_favorability_exp: curve }), s, id, 150))
        assert.deepEqual(s, before)
    }
    for (const rows of [info.filter((r) => r.id !== 10100304), [...info, info.find((r) => r.id === 10100301)]]) {
        const s = state(),
            before = structuredClone(s)
        assert.throws(() => grantHeroFavorability(data({ hero_favorability_info: rows }), s, id, 150))
        assert.deepEqual(s, before)
    }
})
test('personal favor rejects unowned, duplicate, trial and favor0 identities rather than selecting another actor', () => {
    for (const heroId of [199001, 199002, 16001]) {
        const s = state(heroId),
            before = structuredClone(s)
        assert.throws(
            () => grantHeroFavorability(tables, s, id, 150),
            (e) => e.code === ErrorCode.HeroFavorExpLocked,
        )
        assert.deepEqual(s, before)
    }
    for (const mode of ['trialFlag', 'trialGroup', 'cultTrial', 'duplicate']) {
        const s = state()
        if (mode === 'trialFlag') actor(s).trail = true
        if (mode === 'trialGroup') s.trialGroup = { heroes: [{ guid: id }] }
        if (mode === 'cultTrial') s.cultTrial = { heroes: [{ guid: id }] }
        if (mode === 'duplicate') s.player.heros_info.heros.push({ ...actor(s) })
        const before = structuredClone(s)
        assert.throws(() => grantHeroFavorability(tables, s, id, 150))
        assert.deepEqual(s, before)
    }
    const s = state()
    for (const [recipient, amount] of [
        ['9999', 150],
        ['01', 150],
        ['18446744073709551616', 150],
        [18446744073709550000, 150],
        [id, -1],
        [id, 1.2],
        [id, 0x100000000],
    ]) {
        const before = structuredClone(s)
        assert.throws(() => grantHeroFavorability(tables, s, recipient, amount))
        assert.deepEqual(s, before)
    }
})
test('personal favor refuses damaged saved progress and foreign, future or duplicate level reward receipts', () => {
    for (const patch of [
        { favorability_lv: NaN },
        { favorability_lv: 11 },
        { favorability_exp: 2000 },
        { favorability_exp: -1 },
        { store_favor_rewards: [10100702] },
        { store_favor_rewards: [10100302] },
        { store_favor_rewards: [10100302, 10100302] },
        { trail: 'false' },
    ]) {
        const s = state()
        Object.assign(actor(s), patch)
        const before = structuredClone(s)
        assert.throws(() => grantHeroFavorability(tables, s, id, 150))
        assert.deepEqual(s, before)
    }
})
test('caller-controlled Game transaction publishes the personal HeroItemInfo and owns codec rollback', () => {
    const f = achievementFixture('personal-favor-transaction')
    const recipient = f.state().player.heros_info.heros.find((h) => h.conf_id === 101003).guid
    const e = f.protocol.byName.get('CSProtoGMCommand'),
        originalHandler = f.game.handlers.get(e.id),
        encode = f.protocol.encode.bind(f.protocol)
    try {
        f.game.handlers.set(e.id, (c) => {
            grantHeroFavorability(c.tables, c.state, recipient, 150)
            // The caller owns wire sync as well as the encompassing transaction.
            c.pushBefore('CSProtoSyncPlayerData', { heros_info: c.state.player.heros_info })
            return {}
        })
        const before = f.state()
        f.protocol.encode = (name, value) => {
            if (name === f.protocol.byId.get(5008).rsp) throw Error('personal favor codec')
            return encode(name, value)
        }
        assert.throws(() => f.call('GMCommand', { command: Buffer.from('test-only-favor') }), /personal favor codec/)
        assert.deepEqual(f.state(), before)
        f.protocol.encode = encode
        const packets = f.call('GMCommand', { command: Buffer.from('test-only-favor') })
        const sync = packets.find((p) => p.id === 5008)
        assert(sync)
        assert.equal(
            f.protocol.decode('cs.PlayerData', sync.payload).heros_info.heros.find((h) => h.guid === recipient)
                .favorability_exp,
            150,
        )
        assert.equal(f.state().player.heros_info.heros.find((h) => h.guid === recipient).favorability_exp, 150)
        assert.deepEqual(f.state().player.attr_infos, before.player.attr_infos)
    } finally {
        f.protocol.encode = encode
        f.game.handlers.set(e.id, originalHandler)
        f.store.close()
    }
})

test('optional protobuf zero fields are accepted while malformed table containers and null receipts are rejected', () => {
    const s = state()
    delete actor(s).favorability_exp
    assert.equal(grantHeroFavorability(tables, s, id, 150).exp, 150)
    const zero = state()
    delete actor(zero).favorability_lv
    delete actor(zero).favorability_exp
    assert.equal(grantHeroFavorability(tables, zero, id, 1000).level, 1)
    assert.equal(actor(zero).favorability_exp, 0)
    for (const overrides of [{ hero: null }, { hero_favorability_info: {} }, { hero_favorability_exp: [null] }]) {
        const value = state(),
            before = structuredClone(value)
        assert.throws(
            () => grantHeroFavorability(data(overrides), value, id, 150),
            (e) => e.code === ErrorCode.GameConfig || e.code === ErrorCode.HeroFavorConfNone,
        )
        assert.deepEqual(value, before)
    }
    for (const patch of [{ store_favor_rewards: null }, { favorability_exp: null }, { favorability_lv: null }]) {
        const value = state()
        Object.assign(actor(value), patch)
        const before = structuredClone(value)
        assert.throws(
            () => grantHeroFavorability(tables, value, id, 150),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(value, before)
    }
})
