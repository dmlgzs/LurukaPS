import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { heroGiftFixture } from './hero-gift-progress-fixture.js'
import { heroGiftProgressFacts } from '../src/hero-gift-progress.js'
import { ErrorCode } from '../src/error-codes.js'

test('6610 batches and furniture create only new accepted gift units; retained retry is atomic and payload-bound', () => {
    const f = heroGiftFixture('gift-source-batches')
    try {
        f.fund(f.normalItem, 20)
        f.fund(f.furniture.id, 2)
        assert.equal(f.state().heroGiftProgress, undefined)
        const frame = f.frame('SendHeroGift', { heroId: 107002, item_id: f.normalItem, item_type: 110, num: 2 })
        f.send(frame)
        assert.deepEqual(heroGiftProgressFacts(f.state()), {
            total: 2,
            normal: 2,
            furniture: 0,
            requests: 1,
            revision: 1,
        })
        // Allow the existing post-request home revision to be observed before
        // comparing the retained retry's complete saved state.
        f.call('ActivityGet')
        const beforeRepeat = f.state()
        f.send(frame)
        assert.deepEqual(f.state(), beforeRepeat)
        const altered = {
            ...frame,
            payload: f.protocol.encode(f.protocol.byName.get('CSProtoSendHeroGift').req, {
                heroId: 107002,
                item_id: f.normalItem,
                item_type: 110,
                num: 3,
            }),
        }
        assert.throws(
            () => f.send(altered),
            (e) => e.code === ErrorCode.HeroGiftArgs,
        )
        assert.deepEqual(f.state(), beforeRepeat)
        f.gift(1, f.furniture.id)
        assert.deepEqual(heroGiftProgressFacts(f.state()), {
            total: 3,
            normal: 2,
            furniture: 1,
            requests: 2,
            revision: 2,
        })
        const given = f.state()
        assert.throws(() => f.gift(1, f.furniture.id), /already been given/)
        assert.throws(() => f.gift(1, f.furniture.id, 102001), /another hero/)
        const main = given.player.heros_info.heros.find((h) => f.tables.find('hero', h.conf_id)?.favor === 0)
        assert.throws(
            () => f.gift(1, f.normalItem, main.conf_id),
            (e) => e.code === ErrorCode.HeroFavorExpLocked,
        )
        assert.deepEqual(f.state(), given)
        f.gift(2)
        assert.deepEqual(heroGiftProgressFacts(f.state()), {
            total: 5,
            normal: 4,
            furniture: 1,
            requests: 3,
            revision: 3,
        })
    } finally {
        f.store.close()
    }
})

test('6610 source, inventory and favor roll back on player sync or ACK failure; old daily/furniture do not fabricate history', () => {
    const f = heroGiftFixture('gift-source-rollback')
    try {
        f.fund(f.normalItem, 20)
        f.edit((s) => {
            const actor = s.player.heros_info.heros.find((h) => h.conf_id === 107002)
            actor.daily_gift_num = 2
            actor.furnitures = [f.furniture.id]
            s.player.basic_info.hero_gift_info = { gift_num: 2, last_time: 1800000000 }
        })
        assert.equal(heroGiftProgressFacts(f.state()).total, 0)
        for (const name of ['CSProtoSyncPlayerData', 6610]) {
            const frame = f.frame('SendHeroGift', { heroId: 107002, item_id: f.normalItem, item_type: 110, num: 1 }),
                before = f.state(),
                original = f.game.packet
            f.game.packet = function (n, value, options) {
                if (n === name) throw Error('injected gift codec')
                return original.call(this, n, value, options)
            }
            assert.throws(() => f.send(frame), /injected gift codec/)
            assert.deepEqual(f.state(), before)
            f.game.packet = original
            f.send(frame)
        }
        assert.equal(heroGiftProgressFacts(f.state()).total, 2)
        f.advance(86400)
        f.gift(1)
        assert.equal(heroGiftProgressFacts(f.state()).total, 3)
        assert.equal(f.state().player.basic_info.hero_gift_info.gift_num, 1)
    } finally {
        f.store.close()
    }
})

test('6610 lifetime facts survive real SQLite close/reopen while old untyped history remains excluded', () => {
    const scratch = path.resolve('../scratch')
    fs.mkdirSync(scratch, { recursive: true })
    const filename = path.join(scratch, 'gift-source-' + Date.now() + '.sqlite')
    let f = heroGiftFixture('gift-source-sqlite', filename)
    try {
        f.fund(f.normalItem, 10)
        f.gift(5)
        assert.equal(heroGiftProgressFacts(f.state()).total, 5)
        f.store.close()
        f = heroGiftFixture('gift-source-sqlite', filename)
        assert.equal(heroGiftProgressFacts(f.state()).total, 5)
        f.gift(1)
        assert.equal(heroGiftProgressFacts(f.state()).total, 6)
    } finally {
        f.store.close()
    }
})
