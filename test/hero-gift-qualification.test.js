import test from 'node:test'
import assert from 'node:assert/strict'
import { heroData } from '../src/player.js'
import { ErrorCode } from '../src/error-codes.js'
import { heroGiftRecipient, permanentHeroFavorRecords } from '../src/hero-favor-ownership.js'
import { favorProgressFixture, tables, giftFor } from './hero-favor-progress-fixture.js'

test('gift selects normal ownership over a same-config trial and its selector excludes foreign-owner shadows', () => {
    const f = favorProgressFixture('hero-gift-normal-target')
    try {
        const id = 101010,
            selected = giftFor(id)
        f.fund(selected.row.id, 2)
        f.edit((s) => {
            const real = s.player.heros_info.heros.find((r) => r.conf_id === id)
            const trial = {
                ...structuredClone(real),
                guid: ((5n << 56n) | 21n).toString(),
                trail: true,
                favorability_lv: 10,
            }
            s.player.heros_info.heros.unshift(trial)
            s.trialGroup = { heroes: [trial], pets: [] }
        })
        const before = f.actor(id).favorability_exp ?? 0
        f.gift(id, selected.row.id)
        const normal = f
            .state()
            .player.heros_info.heros.find(
                (r) =>
                    r.conf_id === id &&
                    BigInt(r.guid) >> 56n === 1n &&
                    (BigInt(r.guid) & 0xffffffffn) === BigInt(f.session.id),
            )
        assert.equal(normal.favorability_exp, before + selected.value)
        assert.equal(f.state().player.heros_info.heros[0].favorability_lv, 10)
        // A deliberately foreign duplicate in the private owned roster also
        // violates the existing rank observer. Test this new selector alone
        // instead of bypassing that unrelated integrity check in Game.
        const foreignState = f.state()
        foreignState.player.heros_info.heros.unshift({
            ...normal,
            guid: ((1n << 56n) | (BigInt(id) << 32n) | BigInt(f.session.id + 1)).toString(),
        })
        assert.equal(heroGiftRecipient(tables, foreignState, id).guid, normal.guid)
    } finally {
        f.close()
    }
})

test('individual qualification,temporary-only targets and invalid identities reject before inventory or quota commits', () => {
    const f = favorProgressFixture('hero-gift-qualification')
    try {
        const item = giftFor(101010).row.id
        f.fund(item, 10)
        const locked = tables
            .get('hero')
            .find((r) => r.favor === 0 && f.state().player.heros_info.heros.some((h) => h.conf_id === r.id))
        const before = f.state()
        assert.throws(
            () => f.gift(locked.id, item),
            (e) => e.code === ErrorCode.HeroFavorExpLocked,
        )
        assert.deepEqual(f.state(), before)
        assert.throws(
            () => f.gift(0, item),
            (e) => e.code === ErrorCode.HeroGiftArgs,
        )
        assert.deepEqual(f.state(), before)
        f.edit((s) => {
            const actor = s.player.heros_info.heros.find((r) => r.conf_id === 101010)
            actor.trail = true
        })
        const trialOnly = f.state()
        assert.throws(
            () => f.gift(101010, item),
            (e) => e.code === ErrorCode.HeroNotExist,
        )
        assert.deepEqual(f.state(), trialOnly)
    } finally {
        f.close()
    }
})

test('local legacy compatibility is UInt32-only and cannot use aliases or duplicate configurations to select targets', () => {
    const owner = 7
    const data = (heroes) => ({ player: { basic_info: { id: owner }, heros_info: { heros: heroes } } })
    const legacy = { ...heroData(101010, owner), guid: '77' }
    assert.equal(heroGiftRecipient(tables, data([legacy]), 101010), legacy)
    const tooWide = { ...legacy, guid: (1n << 40n).toString() }
    assert.throws(
        () => heroGiftRecipient(tables, data([tooWide]), 101010),
        (e) => e.code === ErrorCode.HeroNotExist,
    )
    assert.throws(
        () => permanentHeroFavorRecords(tables, data([legacy, { ...heroData(101007, owner), guid: '077' }])),
        (e) => e.code === ErrorCode.GameConfig,
    )
    assert.throws(
        () => permanentHeroFavorRecords(tables, data([legacy, { ...legacy, guid: '78' }])),
        (e) => e.code === ErrorCode.GameConfig,
    )
    for (const guid of ['0', Number.MAX_SAFE_INTEGER + 1, '18446744073709551616'])
        assert.throws(
            () => permanentHeroFavorRecords(tables, data([{ ...legacy, guid }])),
            (e) => e.code === ErrorCode.GameConfig,
        )
})

test('gift response encoding failure rolls back selected hero,items and the refreshed daily quota', () => {
    const f = favorProgressFixture('hero-gift-codec'),
        encode = f.protocol.encode
    try {
        const item = giftFor(101010).row.id
        f.fund(item, 2)
        const before = f.state(),
            reply = f.protocol.byName.get('CSProtoSendHeroGift').rsp
        f.protocol.encode = function (name, ...args) {
            if (name === reply) throw Error('gift-qualification-ack')
            return encode.call(this, name, ...args)
        }
        assert.throws(() => f.gift(101010, item), /gift-qualification-ack/)
        assert.deepEqual(f.state(), before)
        f.protocol.encode = encode
        f.gift(101010, item)
        assert.equal(f.state().player.basic_info.hero_gift_info.gift_num, 1)
    } finally {
        f.protocol.encode = encode
        f.close()
    }
})
