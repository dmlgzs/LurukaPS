import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { WorldObjectCatalog } from '../src/world-objects.js'
import { ErrorCode } from '../src/error-codes.js'
import policy from '../configs/activity-drop-currency-policy.json' with { type: 'json' }
import {
    rollActivityRewardDrop,
    activityCurrencyBalance,
    creditActivityCurrency,
} from '../src/activity-drop-currency.js'

const config = configuration()
const tables = new Tables(config.tables)
const world = new WorldObjectCatalog(tables)
const protocol = new Protocol(config.base)
const state = () => ({ player: { attr_infos: { attrs: [{ attr_id: 10011, attr_val: '777' }] } } })
const random = () => 0
function editedCatalog(edit) {
    const drops = world.get('drop').map((row) => ({ ...row }))
    edit(drops)
    const result = { get: (name) => (name === 'drop' ? drops : world.get(name)) }
    result.drops = (id, rng) => WorldObjectCatalog.prototype.drops.call(result, id, rng)
    return result
}

test('all twelve sealed original pools credit only the owner activity currency and return display10 without global grant', () => {
    assert.equal(policy.pools.length, 12)
    assert.equal(world.get('drop').filter((row) => row.type === policy.sourceType).length, 12)
    const saved = state()
    const originalGlobal = structuredClone(saved.player.attr_infos.attrs)
    const beforeRows = structuredClone(world.get('drop'))
    let total = 0
    for (const pool of policy.pools) {
        const result = rollActivityRewardDrop(tables, saved, pool.eventId, pool.dropId, world, random)
        assert.deepEqual(result.ordinary, [])
        assert.equal(result.activity.length, 1)
        assert.equal(result.activity[0].itemtype, 10)
        assert.equal(result.activity[0].itemid, pool.currencyId)
        const source = pool.sourcePool[0]
        assert.equal(result.activity[0].itemnum, source.minValue)
        total += source.minValue
        assert.equal(activityCurrencyBalance(saved, pool.eventId, pool.currencyId), String(total))
    }
    assert.deepEqual(saved.player.attr_infos.attrs, originalGlobal)
    assert.deepEqual(world.get('drop'), beforeRows)
    const decoded = protocol.decode('cs.PlayerAttrInfo', protocol.encode('cs.PlayerAttrInfo', saved.player.attr_infos))
    assert.equal(decoded.act_attrs[0].event_id, policy.pools[0].eventId)
    assert.equal(decoded.act_attrs[0].attr.attr_val, String(total))
    assert.equal(decoded.attrs[0].attr_val, '777')
})

test('unknown2, mismatched pool/namespace/context and multiple currency owners fail closed before changing any balance', () => {
    const pool = policy.pools[0]
    const saved = state()
    const before = structuredClone(saved)
    assert.throws(
        () => rollActivityRewardDrop(tables, saved, 70002, pool.dropId, world, random),
        (error) => error.code === ErrorCode.FunctionClosed,
    )
    for (const edit of [
        (rows) => {
            const row = rows.find((item) => item.dropId === pool.dropId)
            row.minValue = 0
            row.maxValue = 0
        },
        (rows) => {
            rows.find((item) => item.dropId === pool.dropId).type = 10
        },
        (rows) => {
            const row = rows.find((item) => item.dropId === pool.dropId)
            row.minValue++
            row.maxValue++
        },
        (rows) => {
            rows.find((item) => item.dropId === pool.dropId).itemId = 2
        },
        (rows) => {
            rows.push({ ...pool.sourcePool[0], id: 99000001, dropId: 99000001 })
        },
    ]) {
        const changed = editedCatalog(edit)
        const unknown = changed.get('drop').some((row) => row.dropId === 99000001)
        assert.throws(
            () =>
                rollActivityRewardDrop(tables, saved, pool.eventId, unknown ? 99000001 : pool.dropId, changed, random),
            (error) => error.code === ErrorCode.FunctionClosed,
        )
        assert.deepEqual(saved, before)
    }
    const otherParents = {
        get: (name) =>
            name === 'game_events'
                ? [...tables.get(name), { ...tables.find(name, pool.eventId), id: 99000002 }]
                : tables.get(name),
        find: (name, id) => tables.find(name, id),
    }
    assert.throws(
        () => rollActivityRewardDrop(otherParents, saved, pool.eventId, pool.dropId, world, random),
        (error) => error.code === ErrorCode.FunctionClosed,
    )
    assert.deepEqual(saved, before)
})

test('activity balances use exact uint64 and event+attr identity; synthetic second-event ledger never shares global or first-event money', () => {
    const saved = state()
    const first = policy.pools[0].eventId
    const currency = policy.pools[0].currencyId
    const second = first + 1 // Synthetic ledger identity boundary, not a second current event claim.
    saved.player.attr_infos.act_attrs = [{ event_id: first, attr: { attr_id: currency, attr_val: '9007199254740993' } }]
    creditActivityCurrency(saved, first, currency, 200)
    creditActivityCurrency(saved, second, currency, 300)
    assert.equal(activityCurrencyBalance(saved, first, currency), '9007199254741193')
    assert.equal(activityCurrencyBalance(saved, second, currency), '300')
    assert.equal(saved.player.attr_infos.attrs[0].attr_val, '777')
    const decoded = protocol.decode('cs.PlayerAttrInfo', protocol.encode('cs.PlayerAttrInfo', saved.player.attr_infos))
    assert.equal(decoded.act_attrs.find((row) => row.event_id === first).attr.attr_val, '9007199254741193')
    const broken = structuredClone(saved)
    broken.player.attr_infos.act_attrs.push(structuredClone(broken.player.attr_infos.act_attrs[0]))
    assert.throws(
        () => activityCurrencyBalance(broken, first, currency),
        (error) => error.code === ErrorCode.GameConfig,
    )
    const overflow = state()
    overflow.player.attr_infos.act_attrs = [
        { event_id: first, attr: { attr_id: currency, attr_val: '18446744073709551615' } },
    ]
    const before = structuredClone(overflow)
    assert.throws(
        () => creditActivityCurrency(overflow, first, currency, 1),
        (error) => error.code === ErrorCode.GameConfig,
    )
    assert.deepEqual(overflow, before)
})
