import test from 'node:test'
import assert from 'node:assert/strict'
import {
    markAdminAcquisitionDraft,
    homeCurrencyAcquisitionIntent,
    refundAcquisitionContext,
    recordCreditedHomeCurrency,
    readHomeCurrencyAcquisition,
} from '../src/home-currency-acquisition.js'
import { ErrorCode } from '../src/error-codes.js'
import { homeCurrencyFixture, encodeCommand, homeCurrencyBalance } from './home-currency-fixture.js'

test('source intent is transient per draft, admin dominates recursive refund, and recipient context is preserved', () => {
    const state = {},
        recipient = {},
        randomInt = () => 0
    const context = { personalFavor: recipient, randomInt, eggConstraints: { id: 1 } }
    const refund = refundAcquisitionContext(context)
    assert.equal(refund.personalFavor, recipient)
    assert.equal(refund.randomInt, randomInt)
    assert.equal(refund.eggConstraints, context.eggConstraints)
    assert.equal(context.homeCurrencyAcquisitionIntent, undefined)
    assert.equal(homeCurrencyAcquisitionIntent(state), 'normal')
    assert.equal(homeCurrencyAcquisitionIntent(state, refund), 'refund')
    markAdminAcquisitionDraft(state)
    assert.equal(homeCurrencyAcquisitionIntent(state, refund), 'admin')
    assert.equal(JSON.stringify(state), '{}')
    assert.equal(homeCurrencyAcquisitionIntent(structuredClone(state)), 'normal')
})

test('pure prospective ledger only records normal global10:103, never stock, season, refunds, admin or unknown intents', () => {
    const state = {
        player: { attr_infos: { attrs: [{ attr_id: 103, attr_val: '90000000' }] } },
        itemAcquisitionCounts: { '10:103': 90000000 },
    }
    assert.equal(readHomeCurrencyAcquisition(state), 0n)
    assert.equal(recordCreditedHomeCurrency(state, 10, 10011, 7), false)
    assert.equal(recordCreditedHomeCurrency(state, 3, 103, 7), false)
    assert.equal(recordCreditedHomeCurrency(state, 10, 103, 7, refundAcquisitionContext()), false)
    assert.equal(
        recordCreditedHomeCurrency(state, 10, 103, 7, { homeCurrencyAcquisitionIntent: 'unrecognized' }),
        false,
    )
    assert.equal(recordCreditedHomeCurrency(state, 10, 103, 7), true)
    assert.equal(readHomeCurrencyAcquisition(state), 7n)
    markAdminAcquisitionDraft(state)
    assert.equal(recordCreditedHomeCurrency(state, 10, 103, 7), false)
    assert.equal(readHomeCurrencyAcquisition(state), 7n)
})

test('pure ledger has exact decimal precision, explicit saturation, unknown-version preservation and named v1 errors', () => {
    const state = {
        homeCurrencyAcquisition: { version: 1, resourceType: 10, resourceId: 103, total: '9007199254740993' },
    }
    recordCreditedHomeCurrency(state, 10, 103, 1)
    assert.equal(state.homeCurrencyAcquisition.total, '9007199254740994')
    state.homeCurrencyAcquisition.total = '18446744073709551614'
    recordCreditedHomeCurrency(state, 10, 103, 1)
    assert.equal(state.homeCurrencyAcquisition.total, '18446744073709551615')
    assert.equal(recordCreditedHomeCurrency(state, 10, 103, 1), false)
    const future = { homeCurrencyAcquisition: { version: 7, total: '90000000' } }
    const old = structuredClone(future)
    assert.equal(recordCreditedHomeCurrency(future, 10, 103, 1), false)
    assert.equal(readHomeCurrencyAcquisition(future), 0n)
    assert.deepEqual(future, old)
    for (const total of ['01', '-1', '18446744073709551616', 9007199254740994]) {
        const broken = { homeCurrencyAcquisition: { version: 1, resourceType: 10, resourceId: 103, total } }
        assert.throws(
            () => readHomeCurrencyAcquisition(broken),
            (error) => error.code === ErrorCode.GameConfig,
        )
    }
})

test('pure ledger replacement never mutates a previous deferred root or counter record', () => {
    const base = { homeCurrencyAcquisition: { version: 1, resourceType: 10, resourceId: 103, total: '100' } }
    const draft = { ...base },
        before = base.homeCurrencyAcquisition
    recordCreditedHomeCurrency(draft, 10, 103, 2)
    recordCreditedHomeCurrency(draft, 10, 103, 3)
    assert.equal(base.homeCurrencyAcquisition, before)
    assert.equal(before.total, '100')
    assert.equal(draft.homeCurrencyAcquisition.total, '105')
})

test('actual19901,19902 and slash-chat share admin draft intent without leaking it to a later normal request', () => {
    const f = homeCurrencyFixture('home-currency-admin-intent')
    const traces = []
    const original = f.store.transact
    f.store.transact = function (id, message, fn, options) {
        return original.call(
            this,
            id,
            message,
            (state) => {
                const result = fn(state)
                traces.push({ message, intent: homeCurrencyAcquisitionIntent(state) })
                return result
            },
            options,
        )
    }
    try {
        const before = homeCurrencyBalance(f.state())
        f.gm('give 10 103 7')
        f.call('GMCommands', { cmds: [encodeCommand('give 10 103 2'), encodeCommand('give 10 103 3')] })
        f.call('AddChat', {
            target: { chat_type: 2, tid: '1' },
            type: 0,
            msg: Buffer.from('/give 10 103 5').toString('base64'),
        })
        assert.equal(homeCurrencyBalance(f.state()) - before, 17n)
        for (const name of ['GMCommand', 'GMCommands', 'AddChat']) {
            const id = f.protocol.byName.get('CSProto' + name).id
            assert(traces.some((row) => row.message === id && row.intent === 'admin'))
        }
        f.call('CSHistoryReport')
        assert.equal(traces.at(-1).intent, 'normal')
        // No normal award ran here; an admin wallet increase is never a source.
        assert.equal(f.state().homeCurrencyAcquisition, undefined)
    } finally {
        f.store.transact = original
        f.store.close()
    }
})
