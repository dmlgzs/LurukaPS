import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cardFixture, cardProtocol } from './capture-card-stock-fixture.js'
import { captureCardStockValue } from '../src/capture-card-stock.js'

const tokens = [15022, 410, 1000],
    target = 2020026
const stock = (f) => captureCardStockValue(f.game.tables, f.state(), tokens)
const achievements = (packets) =>
    packets
        .filter((p) => p.id === cardProtocol.byName.get('CSProtoAchievementSync').id)
        .flatMap(
            (p) => cardProtocol.decode(cardProtocol.byName.get('CSProtoAchievementSync').rsp, p.payload).achievements,
        )
const make = (f, amount) => {
    let packets = []
    while (amount > 0) {
        const batch = Math.min(50, amount)
        packets = f.make(batch)
        amount -= batch
    }
    return packets
}
test('twenty real11010/11014 batches own1000 cards and finish before a later catch reservation consumes stock', () => {
    const f = cardFixture()
    try {
        assert.equal(stock(f), 0)
        const packets = make(f, 1000)
        assert.equal(f.state().simpleProduced['3:1000001'], 1000)
        assert.equal(stock(f), 1000)
        const final = achievements(packets).find((r) => r.id === target)
        assert(final)
        assert.deepEqual(final.count, [1000])
        assert(BigInt(final.finish_time) > 0n)
        const finished = f.state().achievements.entries[target].finishTime
        f.call('CatchPetCard', { is_create: true, item_id: 1000001, client_param: '1' })
        assert.equal(stock(f), 999)
        assert.equal(f.state().achievements.entries[target].finishTime, finished)
        f.call('AchievementReward', { u32: target })
        assert.equal(f.state().achievements.entries[target].claimed, true)
        const before = f.state()
        f.call('AchievementReward', { u32: target })
        assert.deepEqual(f.state().player.sbag_infos, before.player.sbag_infos)
        assert.equal(f.state().achievements.entries[target].finishTime, finished)
    } finally {
        f.close()
    }
})
test('999 actual crafted cards, capture escrow and refund neither create a1000-stock receipt nor count lifetime output', () => {
    const f = cardFixture({ openId: 'held-cards-999' })
    try {
        make(f, 999)
        assert.equal(stock(f), 999)
        const created = f.call('CatchPetCard', { is_create: true, item_id: 1000001, client_param: '2' })
        const entry = cardProtocol.byName.get('CSProtoCatchPetCard')
        const reserved = cardProtocol.decode(entry.rsp, created.find((p) => p.id === entry.id).payload)
        assert.equal(stock(f), 998)
        f.call('CatchPetCard', { is_create: false, item_id: 1000001, catch_key: reserved.catch_key })
        assert.equal(stock(f), 999)
        assert.equal(f.state().achievements.entries[target].finishTime, 0)
        // No tick yet: CatchPetCard does not credit a pending producer before spending.
        f.call('SimpleProductStart', { product_id: 501001, count: 1, select_material: [] })
        f.advance(1)
        f.call('CatchPetCard', { is_create: true, item_id: 1000001, client_param: '3' })
        assert.equal(stock(f), 998)
        assert.equal(f.state().achievements.entries[target].finishTime, 0)
        f.tick()
        assert.equal(f.state().simpleProduced['3:1000001'], 1000)
        assert.equal(stock(f), 999)
        assert.equal(f.state().achievements.entries[target].finishTime, 0)
    } finally {
        f.close()
    }
})
test('11014 achievement-sync encode failure rolls back actual last batch and SQLite reopen preserves the retried stock receipt', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b133-card-stock-')),
        file = path.join(dir, 'state.sqlite')
    let f = cardFixture({ file, openId: 'held-cards-reopen' })
    try {
        make(f, 950)
        f.call('SimpleProductStart', { product_id: 501001, count: 50, select_material: [] })
        f.advance(50)
        const before = f.store.load(f.session.id),
            original = f.game.packet.bind(f.game)
        f.game.packet = (name, ...args) => {
            if (name === 'CSProtoAchievementSync') throw new Error('independent tick encoder failure')
            return original(name, ...args)
        }
        assert.throws(() => f.tick(), /independent tick encoder failure/)
        assert.deepEqual(f.store.load(f.session.id), before)
        f.game.packet = original
        f.tick()
        assert.equal(stock(f), 1000)
        f.call('AchievementReward', { u32: target })
        const receipt = structuredClone(f.state().achievements.entries[target]),
            now = f.now()
        f.close()
        f = cardFixture({ file, openId: 'held-cards-reopen', now, setup: false })
        assert.equal(stock(f), 1000)
        assert.deepEqual(f.state().achievements.entries[target], receipt)
    } finally {
        f.close()
        const resolved = path.resolve(dir),
            parent = path.resolve(os.tmpdir())
        assert.equal(path.dirname(resolved), parent)
        assert(path.basename(resolved).startsWith('b133-card-stock-'))
        fs.rmSync(resolved, { recursive: true, force: true })
    }
})
