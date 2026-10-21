import test from 'node:test'
import assert from 'node:assert/strict'
import { ornamentFixture } from './helpers/ornament-fixture.js'
import { createCustomOrnaments } from '../src/ornaments.js'
import { ornamentInheritPlan } from '../src/ornament-inherit.js'
import { ornamentAttributes } from '../src/hero-equipment.js'
import { ErrorCode } from '../src/error-codes.js'

function fixture(name) {
    const f = ornamentFixture(name)
    f.store.transact(f.session.id, 0, (s) => {
        s.ornaments = []
        createCustomOrnaments(f.tables, s, 50052, 3, () => 0)
        s.ornaments[0].quality = 1
        s.ornaments[1].quality = 4
        s.player.basic_info.gold = 200000
    })
    const [current, candidate] = f.state().ornaments
    return { ...f, request: { target_quality_guid: candidate.guid, source_quality_guid: current.guid } }
}

test('all current ornament templates and increasing quality pairs plan without changing state', () => {
    const f = ornamentFixture('inherit-all-templates')
    try {
        let count = 0
        const qualities = f.tables.get('accessory_quality').map((r) => r.id)
        for (const config of f.tables.get('accessory')) {
            for (const low of qualities)
                for (const high of qualities.filter((q) => q > low)) {
                    const state = {
                        ornaments: [
                            { guid: 1, id: config.id, quality: low },
                            { guid: 2, id: config.id, quality: high, wear_hero: '0', lock: true },
                        ],
                        player: { heros_info: { heros: [] } },
                    }
                    const saved = structuredClone(state)
                    const plan = ornamentInheritPlan(f.tables, state, {
                        source_quality_guid: 1,
                        target_quality_guid: 2,
                    })
                    assert.equal(plan.current.guid, 1)
                    assert.equal(plan.candidate.guid, 2)
                    assert.equal(plan.gold, 10000)
                    assert.deepEqual(state, saved)
                    count++
                }
        }
        assert.equal(count, 1430)
    } finally {
        f.store.close()
    }
})

test('6035 swaps only quality, retains locked/upgraded instances and synchronizes worn stats before ACK and relogin', () => {
    const f = fixture('inherit-quality-swap')
    try {
        const [current, candidate] = f.state().ornaments,
            hero = f.state().player.heros_info.heros[0]
        f.call('MoveOrnament', { hero_id: hero.guid, ornament_guid: current.guid })
        f.store.transact(f.session.id, 0, (s) => {
            Object.assign(s.ornaments[0], { lv: 2, grade: 1, lock: true })
            Object.assign(s.ornaments[1], { lv: 1, grade: 2, lock: true })
        })
        const before = structuredClone(f.state())
        const oldAttrs = ornamentAttributes(f.tables, before, before.player.heros_info.heros[0])
        const packets = f.call('OrnamentInherit', f.request),
            after = f.state()
        assert.deepEqual(after.ornaments[0], { ...before.ornaments[0], quality: 4 })
        assert.deepEqual(after.ornaments[1], { ...before.ornaments[1], quality: 1 })
        assert.deepEqual(after.ornaments[2], before.ornaments[2])
        assert.deepEqual(after.player.heros_info.heros[0].oguid, before.player.heros_info.heros[0].oguid)
        assert.deepEqual(after.player.sbag_infos, before.player.sbag_infos)
        assert.equal(after.player.basic_info.gold, before.player.basic_info.gold - 10000)
        assert.equal(after.ornamentRevision, before.ornamentRevision + 1)
        const attrs = ornamentAttributes(f.tables, after, after.player.heros_info.heros[0])
        assert([...attrs].some(([id, value]) => value > (oldAttrs.get(id) ?? 0)))
        const ack = packets.findIndex((p) => p.id === 6035)
        assert(ack >= 0)
        assert.deepEqual(f.protocol.decode(f.protocol.byId.get(6035).rsp, packets[ack].payload), {})
        const sync = packets.slice(0, ack).find((p) => p.id === 6029)
        assert(sync)
        const update = f.protocol.decode(f.protocol.byId.get(6029).rsp, sync.payload)
        assert.deepEqual(update.guid, [])
        assert.equal(update.ornaments.find((i) => i.guid === current.guid).quality, 4)
        assert.equal(update.ornaments.find((i) => i.guid === candidate.guid).quality, 1)
        assert(packets.slice(0, ack).some((p) => p.id === f.protocol.byName.get('CSProtoHeroAttrInfoSync').id))
        const stable = structuredClone(after)
        assert.throws(
            () => f.call('OrnamentInherit', f.request),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
        assert.deepEqual(f.state(), stable)
        f.reload()
        assert.deepEqual(f.state().ornaments, after.ornaments)
    } finally {
        f.store.close()
    }
})

test('bad selections, ownership, quality and worn candidates fail without spending or changing either instance', () => {
    const f = fixture('inherit-invalid')
    try {
        const base = structuredClone(f.state()),
            cases = [
                { request: {}, code: ErrorCode.OrnamentNotExist },
                { request: { ...f.request, target_quality_guid: 0xffffffff }, code: ErrorCode.OrnamentNotExist },
                { request: { ...f.request, source_quality_guid: 0xffffffff }, code: ErrorCode.OrnamentNotExist },
                {
                    request: { ...f.request, target_quality_guid: f.request.source_quality_guid },
                    code: ErrorCode.InvalidArgument,
                },
                { change: (s) => (s.ornaments[1].id = 1460211), code: ErrorCode.InvalidArgument },
                { change: (s) => (s.ornaments[1].quality = 1), code: ErrorCode.InvalidArgument },
                { change: (s) => (s.ornaments[0].quality = 5), code: ErrorCode.InvalidArgument },
                { change: (s) => (s.ornaments[0].quality = 0), code: ErrorCode.InvalidArgument },
                { change: (s) => (s.ornaments[1].quality = -1), code: ErrorCode.GameConfig },
                { change: (s) => (s.ornaments[1].quality = '4'), code: ErrorCode.GameConfig },
                { change: (s) => (s.ornaments[1].quality = 999), code: ErrorCode.OrnamentConfFail },
                {
                    change: (s) => (s.ornaments[1].wear_hero = s.player.heros_info.heros[0].guid),
                    code: ErrorCode.EquipOrnament,
                },
                {
                    change: (s) => (s.player.heros_info.heros[0].oguid = [s.ornaments[1].guid]),
                    code: ErrorCode.EquipOrnament,
                },
                { change: (s) => (s.player.basic_info.gold = 9999), code: ErrorCode.ItemNotEnough },
            ]
        for (const c of cases) {
            f.store.transact(f.session.id, 0, (s) => {
                Object.assign(s, structuredClone(base))
                c.change?.(s)
            })
            const before = structuredClone(f.state())
            assert.throws(
                () => f.call('OrnamentInherit', c.request ?? f.request),
                (e) => e.code === c.code,
            )
            assert.deepEqual(f.state(), before)
        }
    } finally {
        f.store.close()
    }
})

test('missing or malformed inheritance cost and quality metadata roll back the entire request', () => {
    const f = fixture('inherit-config')
    const row = f.tables.get('game').find((r) => r.title === 'ACCESSORY_INHERIT_CURRENCY_COST'),
        saved = { ...row }
    const quality = f.tables.find('accessory_quality', 4),
        savedQuality = quality.value
    try {
        for (const cost of ['', 'NaN', '-1', '0.5', '9007199254740992']) {
            row.value = cost
            const before = structuredClone(f.state())
            assert.throws(
                () => f.call('OrnamentInherit', f.request),
                (e) => e.code === ErrorCode.GameConfig,
            )
            assert.deepEqual(f.state(), before)
        }
        Object.assign(row, saved)
        quality.value = -1
        const before = structuredClone(f.state())
        assert.throws(
            () => f.call('OrnamentInherit', f.request),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
        quality.value = savedQuality
        row.title = 'unavailable'
        assert.throws(
            () => f.call('OrnamentInherit', f.request),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        Object.assign(row, saved)
        quality.value = savedQuality
        f.store.close()
    }
})

test('inheritance reads the configured cost and rolls back a failure while publishing worn attributes', () => {
    const f = fixture('inherit-cost-and-publish')
    const row = f.tables.get('game').find((r) => r.title === 'ACCESSORY_INHERIT_CURRENCY_COST'),
        original = row.value
    try {
        row.value = '12345'
        const beforeGold = f.state().player.basic_info.gold
        f.call('OrnamentInherit', f.request)
        assert.equal(f.state().player.basic_info.gold, beforeGold - 12345)
        f.store.transact(f.session.id, 0, (s) => {
            s.ornaments[0].quality = 1
            s.ornaments[1].quality = 4
            // A corrupt worn level fails downstream attribute resolution,
            // after cost and both quality assignments inside the transaction.
            s.ornaments[0].lv = 0xffffffff
            s.ornaments[0].wear_hero = s.player.heros_info.heros[0].guid
            s.player.heros_info.heros[0].oguid = [s.ornaments[0].guid, 0, 0, 0, 0]
        })
        const before = structuredClone(f.state())
        assert.throws(
            () => f.call('OrnamentInherit', f.request),
            (e) => e.code === ErrorCode.OrnamentConfFail,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        row.value = original
        f.store.close()
    }
})
