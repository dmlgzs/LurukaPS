import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { heroData } from '../src/player.js'
import { achievementCatalogue } from '../src/achievements.js'
import { ErrorCode } from '../src/error-codes.js'
import { heroFavorProgressRule, heroFavorProgressValue } from '../src/hero-favor-progress.js'
import { favorProgressFixture, tables, giftFor } from './hero-favor-progress-fixture.js'

const value = (state) => heroFavorProgressValue(tables, state, [13007, 10, 10])
test('the complete13007 family reads qualified personal levels without current formation or global favor balances', () => {
    const model = achievementCatalogue(tables)
    const rows = model.rows.filter((r) => r.finishCondition.startsWith('13007#'))
    assert.deepEqual(
        rows.map((r) => r.id),
        [4010010, 4010011, 4010012],
    )
    assert(rows.every((r) => model.rules.get(r.id).supported))
    assert.equal([...model.rules.values()].filter((r) => r.supported).length, 88)
    const normal = heroData(101010, 1)
    const state = {
        player: {
            basic_info: { id: 1, lv: 99 },
            heros_info: { heros: [normal] },
            group_mgrs: [],
            attr_infos: { attrs: [{ attr_id: 4, attr_val: '9999999' }] },
        },
    }
    delete normal.favorability_lv
    assert.equal(value(state), 0)
    normal.favorability_lv = 10
    assert.equal(value(state), 1)
    normal.type = 1 // HeroItemInfo.type is not the UUID FightObjType.
    assert.equal(value(state), 1)
    state.player.heros_info.heros.push({
        ...heroData(101007, 1),
        guid: ((31n << 56n) | 99n).toString(),
        favorability_lv: 10,
    })
    assert.equal(value(state), 1)
    state.player.heros_info.heros.push({ ...heroData(101008, 2), favorability_lv: 10 })
    assert.equal(value(state), 1)
    state.abyssRun = { heroes: [normal] }
    assert.equal(value(state), 0)
    delete state.abyssRun
    const unqualified = tables.get('hero').find((row) => row.favor === 0)
    state.player.heros_info.heros = [{ ...heroData(unqualified.id, 1), favorability_lv: 10 }]
    assert.equal(unqualified.favor, 0)
    assert.equal(value(state), 0)
    for (const invalid of [-1, 11, Number.NaN, '10']) {
        state.player.heros_info.heros = [{ ...normal, favorability_lv: invalid }]
        assert.throws(
            () => value(state),
            (e) => e.code === ErrorCode.GameConfig,
        )
    }
    for (const tokens of [
        [13007, 0, 1],
        [13007, 11, 1],
        [13007, 10, 0],
        [13007, 10, 1, 1],
    ])
        assert.equal(heroFavorProgressRule(tables, tokens), false)
})

test('ten real qualified owned heroes reach10 through actual quota-observing gifts and complete all three goals', () => {
    const f = favorProgressFixture('hero-favor-ten-real')
    try {
        const targets = f
            .state()
            .player.heros_info.heros.filter((actor) => tables.find('hero', actor.conf_id).favor === 1)
            .slice(0, 10)
        assert.equal(targets.length, 10)
        assert(targets.every((actor) => actor.favorability_lv === 1))
        const needed = new Map()
        for (const actor of targets) {
            const selected = giftFor(actor.conf_id)
            const exp = tables
                .get('hero_favorability_exp')
                .filter((r) => r.favorabilityLevel >= 1 && r.favorabilityLevel < 10)
                .reduce((n, r) => n + r.favorabilityExp, 0)
            needed.set(selected.row.id, (needed.get(selected.row.id) ?? 0) + Math.ceil(exp / selected.value))
        }
        for (const [item, num] of needed) f.fund(item, num)
        let count = 0,
            requests = 0
        for (const actor of targets) {
            requests += f.raise(actor.conf_id)
            count++
            assert.equal(value(f.state()), count)
            assert.equal(f.actor(actor.conf_id).favorability_lv, 10)
            for (const [id, threshold] of [
                [4010010, 1],
                [4010011, 5],
                [4010012, 10],
            ])
                assert.equal((f.state().achievements.entries[id]?.finishTime ?? 0) > 0, count >= threshold)
        }
        assert(requests > 10, 'No personal levels or completion receipts were preseeded')
        for (const id of [4010010, 4010011, 4010012]) {
            f.call('AchievementReward', { u32: id })
            assert.equal(f.state().achievements.entries[id].claimed, true)
        }
    } finally {
        f.close()
    }
})

test('a real final gift and9902 claim are atomic and earned count/claim persist after file-store reopen', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hero-favor-progress-')),
        filename = path.join(directory, 'state.sqlite')
    let f
    try {
        f = favorProgressFixture('hero-favor-transaction', filename)
        const target = f.actor(101010),
            selected = giftFor(target.conf_id)
        // A canonical previously earned level9 boundary; the final transition
        // below is an actual6610 gift, separate from the all-real ten-hero test.
        f.edit((s) => {
            const a = s.player.heros_info.heros.find((r) => r.conf_id === target.conf_id)
            a.favorability_lv = 9
            a.favorability_exp =
                tables.get('hero_favorability_exp').find((r) => r.favorabilityLevel === 9).favorabilityExp - 1
        })
        f.fund(selected.row.id, 2)
        f.call('ActivityGet')
        const before = f.state(),
            encode = f.protocol.encode,
            giftReply = f.protocol.byName.get('CSProtoSendHeroGift').rsp
        f.protocol.encode = function (name, ...args) {
            if (name === giftReply) throw Error('favor-final-gift')
            return encode.call(this, name, ...args)
        }
        assert.throws(() => f.gift(target.conf_id, selected.row.id), /favor-final-gift/)
        assert.deepEqual(f.state(), before)
        f.protocol.encode = encode
        f.gift(target.conf_id, selected.row.id)
        assert.equal(value(f.state()), 1)
        assert(f.state().achievements.entries[4010010].finishTime > 0)
        const ready = f.state(),
            reply = f.protocol.byName.get('CSProtoAchievementReward').rsp
        f.protocol.encode = function (name, ...args) {
            if (name === reply) throw Error('favor-achievement-ack')
            return encode.call(this, name, ...args)
        }
        assert.throws(() => f.call('AchievementReward', { u32: 4010010 }), /favor-achievement-ack/)
        assert.deepEqual(f.state(), ready)
        f.protocol.encode = encode
        f.call('AchievementReward', { u32: 4010010 })
        f.close()
        f = undefined
        f = favorProgressFixture('hero-favor-transaction', filename)
        assert.equal(value(f.state()), 1)
        assert.equal(f.state().achievements.entries[4010010].claimed, true)
        const packet = f.call('AchievementReward', { u32: 4010010 }).find((p) => p.id === 9902)
        assert.deepEqual(f.protocol.decode(reply, packet.payload).rewards, [])
    } finally {
        f?.close()
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()))
        assert(path.basename(directory).startsWith('hero-favor-progress-'))
        fs.rmSync(directory, { recursive: true, force: true })
    }
})
