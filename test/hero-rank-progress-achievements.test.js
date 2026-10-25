import test from 'node:test'
import assert from 'node:assert/strict'
import { heroRankProgressFixture } from './hero-rank-progress-fixture.js'
import { achievementCatalogue, achievementPoints } from '../src/achievements.js'
import { heroRankProgressRule, heroRankProgressValue } from '../src/hero-rank-progress.js'
import { ErrorCode } from '../src/error-codes.js'
import { grantRewards, parseRewards } from '../src/rewards.js'

test('entire current12055 achievement family uses actual rank/count selectors without configured hero ID exceptions', () => {
    const f = heroRankProgressFixture('rank-achievement-family')
    try {
        const model = achievementCatalogue(f.tables),
            rows = model.rows.filter((row) => row.finishCondition.startsWith('12055#'))
        assert.equal(rows.length, 3)
        assert(rows.every((row) => model.rules.get(row.id).supported))
        assert.equal(
            rows.reduce((sum, row) => sum + row.achPoint, 0),
            17,
        )
        assert.equal(heroRankProgressValue(f.tables, f.state(), [12055, 2, 1]), 0)
        for (const tokens of [
            [12055, 0, 1],
            [12055, 13, 1],
            [12055, 4, 0],
            [12055, 4, 1, 0],
        ])
            assert.equal(heroRankProgressRule(f.tables, tokens), false)
        const state = structuredClone(f.state()),
            hero = state.player.heros_info.heros[0]
        hero.hero_rank = 12
        hero.trail = true
        state.trialGroup = { heroes: [{ ...hero, guid: '99999999', trail: false }] }
        assert.equal(heroRankProgressValue(f.tables, state, [12055, 12, 1]), 0)
        hero.trail = false
        assert.equal(heroRankProgressValue(f.tables, state, [12055, 12, 1]), 1)
        state.player.heros_info.heros.push({ ...hero })
        assert.throws(
            () => heroRankProgressValue(f.tables, state, [12055, 12, 1]),
            (error) => error.code === ErrorCode.GameConfig,
        )
    } finally {
        f.store.close()
    }
})

test('ten real characters advance through6016/6017 and award all three rankXII achievements exactly once', () => {
    const f = heroRankProgressFixture('rank-achievement-real')
    try {
        const heroes = f.state().player.heros_info.heros.slice(0, 10)
        for (const [index, hero] of heroes.entries()) {
            f.advance(hero.guid, 11)
            assert.equal(heroRankProgressValue(f.tables, f.state(), [12055, 12, 1]), index)
            const packets = f.advance(hero.guid, 12)
            assert.equal(heroRankProgressValue(f.tables, f.state(), [12055, 12, 1]), index + 1)
            assert(packets.some((packet) => packet.id === 9900))
        }
        for (const [id, threshold] of [
            [4010013, 1],
            [4010014, 5],
            [4010015, 10],
        ]) {
            assert.equal(f.state().achievements.entries[id].value, threshold)
            const packets = f.call('AchievementReward', { u32: id })
            // These three current rows grant achievement points, with no item
            // reward. EmptyRewards must still acknowledge/persist the claim.
            assert.deepEqual(f.reply(packets, 9902).rewards, [])
            assert(f.state().achievements.entries[id].claimed)
            assert.deepEqual(f.reply(f.call('AchievementReward', { u32: id }), 9902).rewards, [])
        }
        assert(achievementPoints(f.tables, f.state()) >= 17)
    } finally {
        f.store.close()
    }
})

test('permanent identity counts normalize decimal aliases and reject unsafe or out-of-range IDs without excluding legacy IDs', () => {
    const f = heroRankProgressFixture('rank-achievement-identity')
    try {
        const base = structuredClone(f.state()),
            tokens = [12055, 2, 1]
        for (const id of [1, '1', '01', '18446744073709551615']) {
            const state = structuredClone(base)
            state.player.heros_info.heros[0].guid = id
            assert.equal(heroRankProgressValue(f.tables, state, tokens), 0)
        }
        for (const id of [0, -1, Number.MAX_SAFE_INTEGER + 1, '18446744073709551616', '1e3', null]) {
            const state = structuredClone(base)
            state.player.heros_info.heros[0].guid = id
            assert.throws(
                () => heroRankProgressValue(f.tables, state, tokens),
                (e) => e.code === ErrorCode.GameConfig,
            )
        }
        const duplicate = structuredClone(base)
        duplicate.player.heros_info.heros[0].guid = '1'
        duplicate.player.heros_info.heros[1].guid = '01'
        assert.throws(
            () => heroRankProgressValue(f.tables, duplicate, tokens),
            (e) => e.code === ErrorCode.GameConfig,
        )
        const malformed = structuredClone(base)
        malformed.player.heros_info.heros[0] = null
        assert.throws(
            () => heroRankProgressValue(f.tables, malformed, tokens),
            (e) => e.code === ErrorCode.GameConfig,
        )
        for (const tokens of [null, {}, [12055], [12055, 0, 1]])
            assert.equal(heroRankProgressRule(f.tables, tokens), false)
    } finally {
        f.store.close()
    }
})

test('failed actual rank-up sync rolls back rank, currency and newly observed achievement together', () => {
    const f = heroRankProgressFixture('rank-achievement-codec'),
        encode = f.protocol.encode
    try {
        const guid = f.state().player.heros_info.heros[0].guid
        f.advance(guid, 11)
        // Capture the request only after the fixture has equipped/funded the
        // final rank. The failing dispatch is still the real6017 transaction.
        const row = f.tables.get('talent_rank').find((row) => row.heroId === f.hero(guid).conf_id && row.rank === 11)
        f.edit((state) => {
            const hero = state.player.heros_info.heros.find((hero) => hero.guid === guid)
            hero.rune_ids = row.rankBreakthroughItem.split('|').map(Number)
            state.player.basic_info.gold = 1000000
            grantRewards(f.tables, state, parseRewards(row.rankBreakthroughCoin))
        })
        for (const type of ['SCAchievementSync', 'SCHeroAttrInfoSync']) {
            const before = structuredClone(f.state())
            f.protocol.encode = function (name, ...args) {
                if (name.replace(/^cs\./, '') === type) throw Error('rank progress codec failure')
                return encode.call(this, name, ...args)
            }
            assert.throws(() => f.call('HeroRuneLevelUp', { hero_id: guid }), /rank progress codec failure/)
            assert.deepEqual(f.state(), before)
            f.protocol.encode = encode
        }
    } finally {
        f.protocol.encode = encode
        f.store.close()
    }
})
