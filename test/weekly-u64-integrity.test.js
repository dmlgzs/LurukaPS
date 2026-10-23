import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { weeklyQuotaView, prepareWeeklyQuota, weeklyDungeonSnapshot } from '../src/weekly-dungeons.js'
import { ErrorCode } from '../src/error-codes.js'

const tables = new Tables(configuration().tables)
const now = 1800000000
const stateFor = (amount) => ({ player: { attr_infos: { attrs: [{ attr_id: 104, attr_val: amount }] } } })
const rejects = (action) => assert.throws(action, (error) => error.code === ErrorCode.GameConfig)

test('weekly quota rejects lossy numeric and non-scalar saved balances before mutating the ledger', () => {
    for (const amount of [Number.MAX_SAFE_INTEGER + 2, 1e18, 1.5, -1, ['3'], [], {}, null, true, 1n]) {
        const state = stateFor(amount)
        const before = structuredClone(state)
        rejects(() => weeklyQuotaView(tables, state, now))
        rejects(() => prepareWeeklyQuota(tables, state, now))
        assert.deepEqual(state, before)
    }
})

test('weekly quota preserves exact legacy safe numbers and full canonical uint64 strings', () => {
    for (const amount of [0, 7, Number.MAX_SAFE_INTEGER, '0', '7', '9007199254740993', '18446744073709551615']) {
        const state = stateFor(amount)
        const player = structuredClone(state.player)
        assert.equal(weeklyQuotaView(tables, state, now).amount, BigInt(amount))
        assert.equal(prepareWeeklyQuota(tables, state, now), true)
        assert.deepEqual(state.player, player)
    }
    for (const amount of ['18446744073709551616', '01', '+3', '3 ', ''])
        rejects(() => weeklyQuotaView(tables, stateFor(amount), now))
})

test('weekly persisted clear timestamps and durations use the same exact uint64 representation', () => {
    const row = tables.get('dungeon_weekly')[0]
    const box = tables.get('stamina_chest_drop').find((item) => item.worldFilter === `4|${row.dungeonId}`)
    const record = {
        weekly_id: row.id,
        dungeon_id: row.dungeonId,
        map_id: box.worldmapcityid,
        star: 7,
        success_count: 1,
        success_time: String(now),
        clearance_time: '25',
    }
    const snapshot = (value) => weeklyDungeonSnapshot(tables, { weeklyDungeonRecords: { [row.id]: value } })
    assert.equal(snapshot(record)[0].clearance_time, '25')
    for (const field of ['success_time', 'clearance_time']) {
        for (const value of [Number.MAX_SAFE_INTEGER + 2, 1e18, ['25'], {}, null, true])
            rejects(() => snapshot({ ...record, [field]: value }))
        assert.doesNotThrow(() => snapshot({ ...record, [field]: 25 }))
        assert.doesNotThrow(() => snapshot({ ...record, [field]: '18446744073709551615' }))
    }
})
