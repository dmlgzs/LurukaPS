import test from 'node:test'
import assert from 'node:assert/strict'
import currentReturns from '../configs/ornament-smelt-values/values.json' with { type: 'json' }
import { ornamentFixture } from './helpers/ornament-fixture.js'
import { createCustomOrnaments } from '../src/ornaments.js'
import { ornamentSmeltPlan } from '../src/ornament-smelt.js'
import { parseRewards } from '../src/rewards.js'
import { ErrorCode } from '../src/error-codes.js'

const count = (s, id) => s.player.sbag_infos.items.filter((i) => i.itemid === id).reduce((n, i) => n + i.itemnum, 0)
const totals = (rows) =>
    [
        ...rows.reduce(
            (m, r) => m.set(r.itemtype + ':' + r.itemid, (m.get(r.itemtype + ':' + r.itemid) ?? 0) + r.itemnum),
            new Map(),
        ),
    ].sort(([a], [b]) => a.localeCompare(b))
function fixture(name, quantity = 3) {
    const f = ornamentFixture(name)
    f.store.transact(f.session.id, 0, (s) => {
        s.ornaments = []
        createCustomOrnaments(f.tables, s, 50052, quantity, () => 0)
    })
    return f
}

test('all 143 templates and 808 valid star states follow the current preview without mutating inventory', () => {
    const f = ornamentFixture('smelt-all-templates'),
        overrides = new Map(currentReturns.map((r) => [r.id, r.smeltReturn]))
    try {
        let planned = 0
        for (const config of f.tables.get('accessory')) {
            const upgrades = f.tables.get('accessory_upgrade').filter((r) => r.rarity === config.rarity)
            for (let grade = 0; grade <= Math.max(...upgrades.map((r) => r.grade)); grade++) {
                const item = { guid: 1, id: config.id, lv: 1, grade, quality: 5 }
                const state = { ornaments: [item], player: { heros_info: { heros: [] } } },
                    saved = structuredClone(state)
                const plan = ornamentSmeltPlan(f.tables, state, [1])
                const copies = 1 + upgrades.filter((r) => r.grade <= grade).reduce((n, r) => n + r.count, 0)
                const level = f.tables.get('accessory_level').find((r) => r.accessoryId === config.id && r.level === 1)
                const expected = [
                    ...parseRewards(level.return_item),
                    ...parseRewards(overrides.get(config.id) ?? config.smeltReturn).map((r) => ({
                        ...r,
                        itemnum: r.itemnum * copies,
                    })),
                ]
                assert.deepEqual(totals(plan.rewards), totals(expected))
                assert.deepEqual(state, saved)
                assert.deepEqual([...plan.selected], [1])
                planned++
            }
        }
        assert.equal(planned, 808)
        assert.equal(currentReturns.length, 51)
        const state = {
            ornaments: [
                { guid: 1, id: 1010211 },
                { guid: 2, id: 1110111 },
            ],
            player: { heros_info: { heros: [] } },
        }
        assert.deepEqual(totals(ornamentSmeltPlan(f.tables, state, [1, 2]).rewards), [
            ['3:302001', 15],
            ['3:317001', 10],
        ])
    } finally {
        f.store.close()
    }
})

test('10205 accepts the actual omitted-building request, returns strengthened and starred rewards, deletes before ACK and survives relogin', () => {
    const f = fixture('smelt-real-request')
    try {
        let lowGuid
        f.store.transact(f.session.id, 0, (s) => {
            Object.assign(s.ornaments[0], { grade: 2, lv: 1, quality: 1 })
            const [low] = createCustomOrnaments(f.tables, s, 20001, 1, () => 0)
            low.grade = 0
            lowGuid = low.guid
        })
        const before = structuredClone(f.state()),
            target = before.ornaments[0],
            guids = [target.guid, lowGuid]
        const packets = f.call('SmeltOrnament', { ornament_guid: guids })
        const ack = packets.findIndex((p) => p.id === 10205)
        const result = f.protocol.decode(f.protocol.byId.get(10205).rsp, packets[ack].payload)
        assert.equal(result.src, 95)
        assert.deepEqual(totals(result.rewards), [
            ['10:2', 40500],
            ['10:700', 100],
            ['3:1600031', 2],
            ['3:302025', 24],
            ['3:317001', 10],
        ])
        assert.equal(f.state().player.basic_info.gold, before.player.basic_info.gold + 40500)
        assert.equal(count(f.state(), 317001), count(before, 317001) + 10)
        assert.equal(count(f.state(), 1600031), count(before, 1600031) + 2)
        assert.equal(count(f.state(), 302025), count(before, 302025) + 24)
        assert.deepEqual(
            f.state().ornaments,
            before.ornaments.filter((i) => !guids.includes(i.guid)),
        )
        const updates = packets
            .slice(0, ack)
            .filter((p) => p.id === 6029)
            .map((p) => f.protocol.decode(f.protocol.byId.get(6029).rsp, p.payload))
        assert(guids.every((id) => updates.some((u) => u.guid.includes(id))))
        const syncId = f.protocol.byName.get('CSProtoSyncPlayerData').id
        assert(
            packets
                .slice(0, ack)
                .some(
                    (p) =>
                        p.id === syncId &&
                        f.protocol
                            .decode(f.protocol.byId.get(syncId).rsp, p.payload)
                            .sbag_infos?.items.some((i) => i.itemid === 317001),
                ),
        )
        const stable = structuredClone(f.state())
        assert.throws(
            () => f.call('SmeltOrnament', { ornament_guid: guids }),
            (e) => e.code === ErrorCode.OrnamentNotExist,
        )
        assert.deepEqual(f.state(), stable)
        f.reload()
        assert.deepEqual(f.state().ornaments, stable.ornaments)
        assert.equal(count(f.state(), 317001), count(stable, 317001))
        assert.equal(f.state().player.basic_info.gold, stable.player.basic_info.gold)
    } finally {
        f.store.close()
    }
})

test('batch validation protects ownership, locks, both wear references and structural state atomically', () => {
    const f = fixture('smelt-invalid')
    try {
        const base = structuredClone(f.state()),
            ids = base.ornaments.slice(0, 2).map((i) => i.guid)
        const cases = [
            { ids: [], code: ErrorCode.InvalidArgument },
            { ids: [ids[0], ids[0]], code: ErrorCode.InvalidArgument },
            { ids: [ids[0], 0xffffffff], code: ErrorCode.OrnamentNotExist },
            { change: (s) => (s.ornaments[1].lock = true), code: ErrorCode.LockOrnament },
            {
                change: (s) => (s.ornaments[1].wear_hero = s.player.heros_info.heros[0].guid),
                code: ErrorCode.EquipOrnament,
            },
            { change: (s) => (s.player.heros_info.heros[0].oguid = [ids[1]]), code: ErrorCode.EquipOrnament },
            { change: (s) => (s.ornaments[1].id = 0xffffffff), code: ErrorCode.OrnamentConfFail },
            { change: (s) => (s.ornaments[1].grade = 7), code: ErrorCode.GameConfig },
            { change: (s) => (s.ornaments[1].grade = -1), code: ErrorCode.GameConfig },
            { change: (s) => (s.ornaments[1].lv = '0'), code: ErrorCode.GameConfig },
            { change: (s) => (s.ornaments[1].lv = 0xffffffff), code: ErrorCode.OrnamentConfFail },
        ]
        for (const c of cases) {
            f.store.transact(f.session.id, 0, (s) => {
                Object.assign(s, structuredClone(base))
                c.change?.(s)
            })
            const before = structuredClone(f.state())
            assert.throws(
                () => f.call('SmeltOrnament', { ornament_guid: c.ids ?? ids }),
                (e) => e.code === c.code,
            )
            assert.deepEqual(f.state(), before)
        }
    } finally {
        f.store.close()
    }
})

test('current bag limit allows 500 real instances and rejects 501 without removing or granting anything', () => {
    const f = fixture('smelt-500', 501)
    try {
        const before = structuredClone(f.state()),
            ids = before.ornaments.map((i) => i.guid)
        assert.throws(
            () => f.call('SmeltOrnament', { ornament_guid: ids }),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
        assert.deepEqual(f.state(), before)
        f.call('SmeltOrnament', { ornament_guid: ids.slice(0, 500) })
        assert.equal(f.state().ornaments.length, 1)
        assert.equal(f.state().ornaments[0].guid, ids[500])
        assert.equal(f.state().player.basic_info.gold, before.player.basic_info.gold + 5000000)
    } finally {
        f.store.close()
    }
})

test('a late unknown reward rolls back deleted instances, early grants, currency and GUID allocation', () => {
    const f = fixture('smelt-late-failure')
    const row = f.tables.get('accessory_level').find((r) => r.accessoryId === 1460111 && r.level === 2),
        original = row.return_item
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.ornaments[1].lv = 2
        })
        row.return_item += '|3#4294967295#1'
        const before = structuredClone(f.state()),
            ids = before.ornaments.slice(0, 2).map((i) => i.guid)
        assert.throws(
            () => f.call('SmeltOrnament', { ornament_guid: ids }),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        row.return_item = original
        f.store.close()
    }
})

test('a currency overflow during reward delivery restores the original bag and equipment', () => {
    const f = fixture('smelt-gold-overflow')
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.player.basic_info.gold = 0x7fffffff
        })
        const before = structuredClone(f.state())
        assert.throws(
            () => f.call('SmeltOrnament', { ornament_guid: [before.ornaments[0].guid] }),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})

test('missing reward fields and conflicting target-level rows are configuration failures rather than silent reward loss', () => {
    const f = fixture('smelt-reward-config')
    const config = f.tables.find('accessory', 1460111),
        saved = config.smeltReturn
    const row = f.tables.get('accessory_level').find((r) => r.accessoryId === config.id && r.level === 0),
        original = row.return_item
    const state = f.state(),
        guid = state.ornaments[0].guid
    try {
        config.smeltReturn = undefined
        assert.throws(
            () => ornamentSmeltPlan(f.tables, state, [guid]),
            (e) => e.code === ErrorCode.GameConfig,
        )
        config.smeltReturn = saved
        row.return_item = undefined
        assert.throws(
            () => ornamentSmeltPlan(f.tables, state, [guid]),
            (e) => e.code === ErrorCode.GameConfig,
        )
        row.return_item = original
        const conflicting = Object.create(f.tables)
        conflicting.get = (name) =>
            name === 'accessory_level' ? [...f.tables.get(name), { ...row, return_item: '10#2#1' }] : f.tables.get(name)
        assert.throws(
            () => ornamentSmeltPlan(conflicting, state, [guid]),
            (e) => e.code === ErrorCode.GameConfig,
        )
    } finally {
        config.smeltReturn = saved
        row.return_item = original
        f.store.close()
    }
})
