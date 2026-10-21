import test from 'node:test'
import assert from 'node:assert/strict'
import { ornamentFixture } from './helpers/ornament-fixture.js'
import { createCustomOrnaments } from '../src/ornaments.js'
import { ornamentStarPlan } from '../src/ornament-star.js'
import { ornamentEntryEffects, ornamentGradeEntries } from '../src/ornament-entry-effects.js'
import { ornamentAttributes, ornamentSkills } from '../src/hero-equipment.js'
import { grantRewards, parseRewards } from '../src/rewards.js'
import { nextOrnamentLevel } from '../src/ornament-upgrade.js'
import { ErrorCode } from '../src/error-codes.js'

function fixture(name) {
    const f = ornamentFixture(name)
    f.store.transact(f.session.id, 0, (s) => {
        s.ornaments = []
        createCustomOrnaments(f.tables, s, 50052, 17, () => 0) // Current zero-star rarity-4 recipe, 1460111.
        s.player.basic_info.gold = 2000000
    })
    return f
}
const stock = (s, id) => s.player.sbag_infos.items.filter((i) => i.itemid === id).reduce((n, i) => n + i.itemnum, 0)
const counts = (items) =>
    [
        ...items.reduce(
            (m, i) => m.set(i.itemtype + ':' + i.itemid, (m.get(i.itemtype + ':' + i.itemid) ?? 0) + i.itemnum),
            new Map(),
        ),
    ].sort(([a], [b]) => a.localeCompare(b))

test('all 143 current templates can plan each configured star and resolve their unlocked skill entries', () => {
    const f = ornamentFixture('ornament-star-catalog')
    try {
        let planned = 0
        for (const config of f.tables.get('accessory')) {
            const rows = f.tables.get('accessory_upgrade').filter((r) => r.rarity === config.rarity)
            assert(rows.length)
            for (const row of rows) {
                const target = { guid: 1, id: config.id, grade: row.grade - 1, lv: 0 }
                const donors = Array.from({ length: row.count }, (_, i) => ({
                    guid: i + 2,
                    id: config.id,
                    grade: 0,
                    lv: 0,
                    wear_hero: '0',
                    lock: false,
                }))
                const state = { ornaments: [target, ...donors], player: { heros_info: { heros: [] } } }
                const before = structuredClone(state)
                const plan = ornamentStarPlan(f.tables, state, {
                    target_guid: 1,
                    material_guids: donors.map((i) => i.guid),
                })
                assert.equal(plan.grade, row.grade)
                assert.equal(plan.consumed.size, row.count)
                assert.deepEqual(plan.costs, parseRewards(row.cost))
                assert.deepEqual(state, before)
                planned++
            }
        }
        assert.equal(f.tables.get('accessory').length, 143)
        assert.equal(planned, 665)
        const legacy = {
            ornaments: [
                { guid: 1, id: 1460111 },
                { guid: 2, id: 1460111 },
            ],
            player: { heros_info: { heros: [] } },
        }
        const savedLegacy = structuredClone(legacy)
        assert.equal(ornamentStarPlan(f.tables, legacy, { target_guid: 1, material_guids: [2] }).grade, 1)
        assert.deepEqual(legacy, savedLegacy)
    } finally {
        f.store.close()
    }
})

test('6034 consumes the selected instance, refunds its configured cumulative strengthening return and updates worn stats before ACK', () => {
    const f = fixture('ornament-star-refund')
    try {
        const [target, donor] = f.state().ornaments,
            hero = f.state().player.heros_info.heros[0]
        f.call('MoveOrnament', { hero_id: hero.guid, ornament_guid: target.guid })
        f.call('SetLockOrnament', { guid: target.guid, lock: true })
        for (let n = 0; n < 2; n++) {
            const item = f.state().ornaments.find((i) => i.guid === donor.guid)
            const costs = nextOrnamentLevel(f.tables, item).costs
            f.store.transact(f.session.id, 0, (s) => grantRewards(f.tables, s, costs))
            f.call('UpgradeOrnament', { u32: donor.guid })
        }
        const expected = parseRewards(
            f.tables.get('accessory_level').find((r) => r.accessoryId === donor.id && r.level === 2).return_item,
        )
        const before = structuredClone(f.state()),
            saved = before.ornaments.find((i) => i.guid === target.guid)
        const oldAttrs = ornamentAttributes(f.tables, before, before.player.heros_info.heros[0])
        const packets = f.call('OrnamentGradeUp', { target_guid: target.guid, material_guids: [donor.guid] })
        const response = f.protocol.decode(f.protocol.byId.get(6034).rsp, packets.find((p) => p.id === 6034).payload)
        assert.deepEqual(counts(response.rewards), counts(expected))
        assert.equal(response.src, 154)
        const after = f.state(),
            current = after.ornaments.find((i) => i.guid === target.guid)
        assert.deepEqual(current, { ...saved, grade: 1 })
        assert(!after.ornaments.some((i) => i.guid === donor.guid))
        const refundGold = expected
            .filter((i) => i.itemtype === 10 && i.itemid === 2)
            .reduce((n, i) => n + i.itemnum, 0)
        assert.equal(after.player.basic_info.gold, before.player.basic_info.gold - 14000 + refundGold)
        for (const item of expected.filter((i) => i.itemtype === 3))
            assert.equal(stock(after, item.itemid), stock(before, item.itemid) + item.itemnum)
        const effect = ornamentEntryEffects(f.tables, [current]),
            attrs = ornamentAttributes(f.tables, after, after.player.heros_info.heros[0])
        assert(effect.attrs.size)
        const oldEffect = ornamentEntryEffects(f.tables, [saved])
        for (const [id, value] of effect.attrs)
            assert.equal((attrs.get(id) ?? 0) - (oldAttrs.get(id) ?? 0), value - (oldEffect.attrs.get(id) ?? 0))
        assert.equal(effect.attrs.get(229), 30 * 10000)
        const ack = packets.findIndex((p) => p.id === 6034)
        const updates = packets
            .slice(0, ack)
            .filter((p) => p.id === 6029)
            .map((p) => f.protocol.decode(f.protocol.byId.get(6029).rsp, p.payload))
        assert(
            updates.some(
                (u) => u.guid.includes(donor.guid) && u.ornaments.some((i) => i.guid === target.guid && i.grade === 1),
            ),
        )
        assert(packets.slice(0, ack).some((p) => p.id === f.protocol.byName.get('CSProtoHeroAttrInfoSync').id))
        const stable = structuredClone(after)
        assert.throws(() => f.call('OrnamentGradeUp', { target_guid: target.guid, material_guids: [donor.guid] }))
        assert.deepEqual(f.state(), stable)
        f.reload()
        assert.equal(f.state().ornaments.find((i) => i.guid === target.guid).grade, 1)
        assert(!f.state().ornaments.some((i) => i.guid === donor.guid))
    } finally {
        f.store.close()
    }
})

test('actual sequential star requests use each next-star cost and stop without consuming anything beyond six stars', () => {
    const f = fixture('ornament-star-full')
    try {
        const target = f.state().ornaments[0],
            startGold = f.state().player.basic_info.gold
        let cost = 0
        for (let grade = 1; grade <= 6; grade++) {
            const row = f.tables.get('accessory_upgrade').find((r) => r.rarity === 4 && r.grade === grade)
            const ids = f
                .state()
                .ornaments.filter((i) => i.guid !== target.guid && i.grade === 0)
                .slice(0, row.count)
                .map((i) => i.guid)
            f.call('OrnamentGradeUp', { target_guid: target.guid, material_guids: ids })
            cost += parseRewards(row.cost).find((i) => i.itemtype === 10 && i.itemid === 2).itemnum
            assert.equal(f.state().ornaments.find((i) => i.guid === target.guid).grade, grade)
        }
        assert.equal(f.state().player.basic_info.gold, startGold - cost)
        const before = structuredClone(f.state())
        assert.throws(
            () => f.call('OrnamentGradeUp', { target_guid: target.guid, material_guids: [] }),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})

test('invalid donors and insufficient resources reject atomically with the native ownership and lock errors', () => {
    const f = fixture('ornament-star-validation')
    try {
        const base = structuredClone(f.state()),
            [target, donor] = base.ornaments
        const cases = [
            { mutate: (s) => (s.ornaments[1].lock = true), code: ErrorCode.LockOrnament },
            {
                mutate: (s) => (s.ornaments[1].wear_hero = s.player.heros_info.heros[0].guid),
                code: ErrorCode.EquipOrnament,
            },
            {
                mutate: (s) => (s.player.heros_info.heros[1].oguid = [donor.guid, 0, 0, 0, 0]),
                code: ErrorCode.EquipOrnament,
            },
            { mutate: (s) => (s.ornaments[1].id = 1460211), code: ErrorCode.InvalidArgument },
            { mutate: (s) => (s.ornaments[1].grade = 1), code: ErrorCode.OrnamentUpgradeFail },
            { mutate: (s) => (s.player.basic_info.gold = 0), code: ErrorCode.ItemNotEnough },
            { mutate: (s) => (s.ornaments[0].grade = 7), code: ErrorCode.GameConfig },
            { mutate: () => {}, ids: [], code: ErrorCode.InvalidArgument },
            { mutate: () => {}, ids: [target.guid], code: ErrorCode.InvalidArgument },
            {
                mutate: (s) => (s.ornaments[0].grade = 1),
                ids: [donor.guid, donor.guid],
                code: ErrorCode.InvalidArgument,
            },
        ]
        for (const c of cases) {
            f.store.transact(f.session.id, 0, (s) => {
                Object.assign(s, structuredClone(base))
                c.mutate(s)
            })
            const before = structuredClone(f.state())
            assert.throws(
                () => f.call('OrnamentGradeUp', { target_guid: target.guid, material_guids: c.ids ?? [donor.guid] }),
                (e) => e.code === c.code,
            )
            assert.deepEqual(f.state(), before)
        }
    } finally {
        f.store.close()
    }
})

test('a later malformed refund restores consumed instances, the star, cost, early grants and the inventory GUID allocator', () => {
    const f = fixture('ornament-star-late-failure')
    const target = f.state().ornaments[0],
        bad = f.tables.get('accessory_level').find((r) => r.accessoryId === target.id && r.level === 2),
        original = bad.return_item
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.ornaments[0].grade = 1
            s.ornaments[1].lv = 1
            s.ornaments[2].lv = 2
        })
        bad.return_item = '3#4294967295#1'
        const before = structuredClone(f.state()),
            ids = before.ornaments.slice(1, 3).map((i) => i.guid)
        assert.throws(
            () => f.call('OrnamentGradeUp', { target_guid: target.guid, material_guids: ids }),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        bad.return_item = original
        f.store.close()
    }
})

test('same-name entries merge across five slots, cap at the actual table maximum and expose real battle passives only', () => {
    const f = ornamentFixture('ornament-entry-merge')
    try {
        const best = new Map(),
            hero = f.state().player.heros_info.heros[0]
        for (const config of f.tables.get('accessory')) {
            const grade = Math.max(
                ...f.tables
                    .get('accessory_upgrade')
                    .filter((r) => r.rarity === config.rarity)
                    .map((r) => r.grade),
            )
            const count = ornamentGradeEntries(f.tables, { id: config.id, grade })
                .filter((e) => e.skillId === 1001)
                .reduce((n, e) => n + e.skillLv, 0)
            if (count > (best.get(config.type)?.count ?? 0)) best.set(config.type, { config, grade, count })
        }
        f.store.transact(f.session.id, 0, (s) => {
            s.ornaments = []
            for (const { config, grade } of best.values()) {
                const custom = f.tables.get('accessory_customed').find((r) => r.accessoryId === config.id)
                const [item] = createCustomOrnaments(f.tables, s, custom.id, 1, () => 0)
                item.grade = grade
            }
        })
        assert.equal(best.size, 5)
        for (const item of [...f.state().ornaments])
            f.call('MoveOrnament', { hero_id: hero.guid, ornament_guid: item.guid })
        const effects = ornamentEntryEffects(f.tables, f.state().ornaments),
            entry = effects.entries.find((e) => e.entryId === 1001)
        assert(entry.total > 15)
        assert.equal(entry.level, 15)
        assert.equal(entry.row.mainAttr, '2001#460')
        assert(effects.skills.some((s) => s.skill_id === 19991001 && s.skill_lv === 1))
        assert(!effects.skills.some((s) => s.skill_id === 1001))
        const equipped = f.state().player.heros_info.heros[0]
        assert(ornamentSkills(f.tables, f.state(), equipped).some((s) => s.skill_id === 19991001))
        const now = String(Date.now()),
            verify = { battle_index: '900001', related_index: '0', op_time: now, source_type: 0, source_id: '0' }
        const changes = f.store.db.prepare('SELECT total_changes() AS n').get().n
        assert.deepEqual(
            f.call('SkillStart', { unit_id: '0', skill: { skill_id: 19991001 }, op_time: now, verify_info: verify }),
            [],
        )
        f.call('SkillStart', {
            unit_id: '0',
            skill: { skill_id: 19991001 },
            op_time: now,
            verify_info: { ...verify, battle_index: '900002' },
        })
        assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n, changes)
        f.call('RemoveOrnament', { hero_id: hero.guid, type: 0, remove_all: true })
        assert.deepEqual(ornamentSkills(f.tables, f.state(), f.state().player.heros_info.heros[0]), [])
        const stopChanges = f.store.db.prepare('SELECT total_changes() AS n').get().n
        f.call('SkillStop', {
            unit_id: '0',
            skill_id: '19991001',
            op_time: now,
            verify_info: { ...verify, battle_index: '0', related_index: '900001' },
        })
        assert(!f.state().combat.skills['local-passive:19991001:900001'])
        assert(f.state().combat.skills['local-passive:19991001:900002'])
        f.call('SkillStop', {
            unit_id: '0',
            skill_id: '19991001',
            op_time: now,
            verify_info: { ...verify, battle_index: '0', related_index: '0' },
        })
        assert(!f.state().combat.skills['local-passive:19991001:900002'])
        assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n, stopChanges)
        assert.throws(
            () =>
                f.call('SkillStart', {
                    unit_id: '0',
                    skill: { skill_id: 19991001 },
                    op_time: now,
                    verify_info: { ...verify, battle_index: '900003' },
                }),
            /Missing combat actor/,
        )
    } finally {
        f.store.close()
    }
})
