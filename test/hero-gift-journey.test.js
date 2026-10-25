import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { heroGiftFixture } from './hero-gift-progress-fixture.js'
import { heroGiftProgressFacts, heroGiftProgressRule } from '../src/hero-gift-progress.js'
import { journeyModel, journeyValue, notifyJourney } from '../src/journey.js'
import { ErrorCode } from '../src/error-codes.js'

const unlockPriorChapter = (f) =>
    f.edit((s) => {
        // Isolate the existing chapter gate only, never seed gift facts or either
        // new target. The actual gift producer must still complete both targets.
        s.journey.tasks[20000] = { complete: true, claimed: true }
        s.journey.claimRevision++
    })
const reply = (f, packets) =>
    f.protocol.decode(f.protocol.byName.get('CSProtoJourneyTaskFinish').rsp, packets.find((p) => p.id === 9869).payload)

test('complete12227/12228 family: actual quantities and furniture progress, chapter gate and both real9869 claims', () => {
    const f = heroGiftFixture('gift-journey-family')
    try {
        const model = journeyModel(f.tables),
            rows = [12227, 12228].flatMap((k) => model.byKind.get(k))
        assert.equal(rows.length, 2)
        assert(rows.every((r) => r.supported && journeyValue(f.tables, f.state(), r) === 0))
        assert.equal(model.targets.filter((r) => r.supported).length, 155)
        assert.equal(model.referencedTargets.filter((r) => r.supported).length, 139)
        for (const tokens of [
            [12227, 2],
            [12228, 0],
            [12228, 5, 1],
            [12229, 5],
        ])
            assert.equal(heroGiftProgressRule(tokens), false)
        f.fund(f.normalItem, 8)
        f.fund(f.furniture.id, 1)
        f.gift(2)
        assert.equal(f.state().journey.targets[4050201].value, 1)
        assert.equal(f.state().journey.targets[4050202].value, 2)
        assert.throws(
            () => f.call('JourneyTaskFinish', { u32s: [50201] }),
            (e) => e.code === ErrorCode.JourneyTypeLock,
        )
        unlockPriorChapter(f)
        assert.equal(reply(f, f.call('JourneyTaskFinish', { u32s: [50201] })).rewards.length, 2)
        f.gift(1, f.furniture.id)
        assert.equal(f.state().journey.targets[4050202].value, 3)
        f.gift(2)
        assert.equal(heroGiftProgressFacts(f.state()).total, 5)
        assert.equal(heroGiftProgressFacts(f.state()).requests, 3)
        assert.equal(f.state().journey.targets[4050202].complete, true)
        assert.equal(reply(f, f.call('JourneyTaskFinish', { u32s: [50202] })).rewards.length, 2)
        assert.deepEqual(reply(f, f.call('JourneyTaskFinish', { u32s: [50201, 50202] })).rewards, [])
    } finally {
        f.store.close()
    }
})

test('6610→11880 and9869 codec failures roll back the real gift, earned target or claimed reward respectively', () => {
    const f = heroGiftFixture('gift-journey-atomic')
    try {
        f.fund(f.normalItem, 10)
        unlockPriorChapter(f)
        f.gift(4)
        f.call('ActivityGet')
        const original = f.game.packet,
            frame = f.frame('SendHeroGift', { heroId: 107002, item_id: f.normalItem, item_type: 110, num: 1 }),
            before = f.state()
        f.game.packet = function (name, value, options) {
            if (name === 'SCProtoJourneySync') throw Error('injected journey source sync')
            return original.call(this, name, value, options)
        }
        assert.throws(() => f.send(frame), /injected journey source sync/)
        assert.deepEqual(f.state(), before)
        f.game.packet = original
        f.send(frame)
        assert.equal(f.state().journey.targets[4050202].complete, true)
        f.call('ActivityGet')
        const earned = f.state()
        f.game.packet = function (name, value, options) {
            if (name === 9869) throw Error('injected journey claim ACK')
            return original.call(this, name, value, options)
        }
        assert.throws(() => f.call('JourneyTaskFinish', { u32s: [50201, 50202] }), /injected journey claim ACK/)
        assert.deepEqual(f.state(), earned)
        f.game.packet = original
        f.call('JourneyTaskFinish', { u32s: [50201, 50202] })
        assert([4050201, 4050202].every((id) => f.state().journey.targets[id].claimed))
    } finally {
        f.store.close()
    }
})

test('old daily gifts, favor, furniture and inventory never backfill lifetime targets; stable unrelated callbacks do not scan', () => {
    const f = heroGiftFixture('gift-journey-history')
    try {
        f.fund(f.normalItem, 100)
        f.edit((s) => {
            const h = s.player.heros_info.heros.find((h) => h.conf_id === 107002)
            h.daily_gift_num = 5
            h.furnitures = [f.furniture.id]
            h.favorability_lv = 10
            s.player.basic_info.hero_gift_info = { gift_num: 5, last_time: 1800000000 }
        })
        f.reload()
        assert.equal(heroGiftProgressFacts(f.state()).total, 0)
        assert([4050201, 4050202].every((id) => f.state().journey.targets[id].value === 0))
        f.call('ActivityGet')
        const state = f.state(),
            original = f.tables.get
        let giftScans = 0,
            pushes = 0
        f.tables.get = function (name) {
            if (['common_item', 'hero_favorability_gift', 'home_dorm_furniture'].includes(name)) giftScans++
            return original.call(this, name)
        }
        try {
            for (let i = 0; i < 250; i++)
                notifyJourney({ tables: f.tables, state, pushBefore: () => pushes++ }, 'CSProtoActivityGet')
            assert.equal(giftScans, 0)
            assert.equal(pushes, 0)
        } finally {
            f.tables.get = original
        }
        for (let i = 0; i < 5; i++)
            assert.equal(
                f.call('ActivityGet').some((p) => p.id === 11880),
                false,
            )
        assert.throws(
            () =>
                heroGiftProgressFacts({
                    heroGiftProgress: { version: 1, total: 5, requests: 1, revision: 1, normal: 0, furniture: 0 },
                }),
            (e) => e.code === ErrorCode.GameConfig,
        )
    } finally {
        f.store.close()
    }
})

test('actual five gifted units and both9869 receipts persist after SQLite reopen without merging another account', () => {
    const scratch = path.resolve('../scratch')
    fs.mkdirSync(scratch, { recursive: true })
    const filename = path.join(scratch, 'gift-journey-' + Date.now() + '.sqlite')
    let f = heroGiftFixture('gift-journey-sqlite', filename)
    try {
        f.fund(f.normalItem, 10)
        unlockPriorChapter(f)
        f.gift(5)
        f.call('JourneyTaskFinish', { u32s: [50201, 50202] })
        f.store.close()
        f = heroGiftFixture('gift-journey-sqlite', filename)
        assert.equal(heroGiftProgressFacts(f.state()).total, 5)
        assert([4050201, 4050202].every((id) => f.state().journey.targets[id].claimed))
        assert.deepEqual(reply(f, f.call('JourneyTaskFinish', { u32s: [50201, 50202] })).rewards, [])
        const other = heroGiftFixture('gift-journey-another', filename)
        try {
            assert.equal(heroGiftProgressFacts(other.state()).total, 0)
        } finally {
            other.store.close()
        }
    } finally {
        f.store.close()
    }
})
