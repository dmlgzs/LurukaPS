import test from 'node:test'
import assert from 'node:assert/strict'
import { achievementFixture } from './achievement-fixture.js'
import { journeyModel, journeyLedger } from '../src/journey.js'
import { ErrorCode } from '../src/error-codes.js'

function ready(f) {
    // Authoritative future/imported completion receipts isolate this reward
    // boundary; unsupported event producers are not implemented by this test.
    f.store.transact(f.session.id, 0, (s) => {
        const model = journeyModel(f.tables),
            ledger = journeyLedger(s)
        for (const row of model.targets)
            if (model.owner.has(row.id))
                ledger.targets[row.id] = { value: row.targetParam, complete: true, claimed: true }
    })
}
test('journey special selection creates the exact configured soul essence and consumes only its entitlement', () => {
    const f = achievementFixture('journey-special')
    try {
        ready(f)
        const choice = f.tables.find('common_item', 1520901).giftBagReward.split('|')[0].split('#').map(Number)
        const before = f.state().player.soulessence_infos.soulessences.length
        const packets = f.call('JourneyReceiveSpecialReward', { u32s: [choice[1], choice[0]] })
        const reply = f.reply(packets, 11883),
            item = reply.rewards[0]
        assert.equal(reply.rewards.length, 1)
        assert.equal(item.itemtype, 9)
        assert.equal(item.itemid, choice[1])
        assert.ok(item.guid)
        assert.equal(f.state().player.soulessence_infos.soulessences.length, before + 1)
        assert.equal(f.state().journey.pointMask, 32)
        assert.ok(
            f
                .state()
                .player.soulessence_infos.soulessences.some(
                    (s) => String(s.guid) === String(item.guid) && s.id === choice[1],
                ),
        )
        const sync = f.protocol.decode('SCJourneySync', packets.find((p) => p.id === 11880).payload)
        assert.equal(sync.special_item.itemid, choice[1])
        assert.equal(sync.reward_index, 32)
        assert.deepEqual(
            f.reply(f.call('JourneyReceiveSpecialReward', { u32s: [choice[1], choice[0]] }), 11883).rewards,
            [],
        )
        assert.equal(
            f.state().player.sbag_infos.items.some((i) => i.itemid === 1520901),
            false,
        )
    } finally {
        f.store.close()
    }
})
test('journey special rejects unearned, wrong-order, foreign and changed selections', () => {
    const f = achievementFixture('journey-special-negative')
    try {
        const choices = f.tables
            .find('common_item', 1520901)
            .giftBagReward.split('|')
            .map((s) => s.split('#').map(Number))
        const [type, id] = choices[0]
        assert.throws(
            () => f.call('JourneyReceiveSpecialReward', { u32s: [id, type] }),
            (e) => e.code === ErrorCode.JourneyContReward,
        )
        ready(f)
        const before = f.state()
        for (const u32s of [[], [id], [id, type, 1], [type, id], [99999, 9], [id, 3]]) {
            assert.throws(() => f.call('JourneyReceiveSpecialReward', { u32s }))
            assert.deepEqual(f.state(), before)
        }
        f.call('JourneyReceiveSpecialReward', { u32s: [id, type] })
        assert.throws(
            () => f.call('JourneyReceiveSpecialReward', { u32s: [choices[1][1], choices[1][0]] }),
            (e) => e.code === ErrorCode.JourneyNoReward,
        )
    } finally {
        f.store.close()
    }
})
test('journey special rolls back instance creation and bitmask when Rewards encoding fails', () => {
    const f = achievementFixture('journey-special-codec')
    try {
        ready(f)
        const [type, id] = f.tables.find('common_item', 1520901).giftBagReward.split('|')[0].split('#').map(Number)
        const before = f.state(),
            encode = f.protocol.encode.bind(f.protocol)
        f.protocol.encode = (name, value) => {
            if (name === 'cs.Rewards' && value?.rewards?.length) throw Error('special codec')
            return encode(name, value)
        }
        assert.throws(() => f.call('JourneyReceiveSpecialReward', { u32s: [id, type] }), /special codec/)
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})
