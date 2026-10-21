import test from 'node:test'
import assert from 'node:assert/strict'
import { ornamentFixture } from './helpers/ornament-fixture.js'
import { nextOrnamentLevel } from '../src/ornament-upgrade.js'
import { ornamentValueTables } from '../src/ornament-values.js'
import { ornamentAttributes } from '../src/hero-equipment.js'
import { grantRewards } from '../src/rewards.js'
import { ErrorCode } from '../src/error-codes.js'

function fund(f, costs, times = 1) {
    f.store.transact(f.session.id, 0, (s) =>
        grantRewards(
            f.tables,
            s,
            costs.map((c) => ({ ...c, itemnum: c.itemnum * times })),
        ),
    )
}

test('unrelated legacy rows cannot block a valid upgrade, while conflicting rows for the requested item are rejected', () => {
    const f = ornamentFixture('ornament-level-conflicts')
    try {
        const item = f.state().ornaments[0],
            original = f.tables.get('accessory_level')
        const current = original.find((r) => r.accessoryId === item.id && r.level === item.lv)
        const withRows = (extra) => {
            const tables = Object.create(f.tables)
            tables.get = (name) => (name === 'accessory_level' ? [...original, ...extra] : f.tables.get(name))
            return tables
        }
        assert.equal(
            nextOrnamentLevel(withRows([{ accessoryId: 99999999, level: 'bad-unused' }]), item).level,
            item.lv + 1,
        )
        assert.equal(nextOrnamentLevel(withRows([{ ...current, Id: 99999999 }]), item).level, item.lv + 1)
        assert.throws(
            () => nextOrnamentLevel(withRows([{ ...current, Id: 99999999, item: '10#2#999999' }]), item),
            (e) => e.code === ErrorCode.AccessoryLevelUpConfFail,
        )
    } finally {
        f.store.close()
    }
})

test('all current accessory level transitions have configured costs and current next-level main attributes', () => {
    const f = ornamentFixture('ornament-all-levels')
    try {
        const tables = ornamentValueTables(f.tables)
        let checked = 0
        for (const config of tables.get('accessory')) {
            const rows = tables.get('accessory_level').filter((r) => r.accessoryId === config.id),
                max = Math.max(...rows.map((r) => r.level))
            assert(rows.length > 0, String(config.id))
            for (const row of rows) {
                const item = { id: config.id, lv: row.level }
                if (row.level < max) {
                    const plan = nextOrnamentLevel(f.tables, item)
                    assert.equal(plan.level, row.level + 1)
                    checked++
                } else
                    assert.throws(
                        () => nextOrnamentLevel(f.tables, item),
                        (e) => e.code === ErrorCode.OrnamentMaxLv,
                    )
            }
        }
        assert.equal(checked, 1837)
        assert.equal(tables.find('accessory', 1370311).name, f.tables.find('accessory', 1370311).name)
        assert.equal(tables.find('accessory', 1370311).elementAttr, 0)
        const added = tables.get('accessory_main').find((r) => r.id === 2124)
        assert.equal(added.groupId, 1370311)
        assert.equal(added.battleInfo, '2001')
        assert.equal(added.value, 20)
    } finally {
        f.store.close()
    }
})

test('6021 consumes the current row, preserves the instance and publishes a worn upgrade before ACK and relogin', () => {
    const f = ornamentFixture('ornament-upgrade-worn')
    try {
        const initial = f.state().ornaments[0],
            hero = f.state().player.heros_info.heros[0]
        f.call('MoveOrnament', { hero_id: hero.guid, ornament_guid: initial.guid })
        f.call('SetLockOrnament', { guid: initial.guid, lock: true })
        const before = structuredClone(f.state().ornaments.find((i) => i.guid === initial.guid)),
            plan = nextOrnamentLevel(f.tables, before)
        fund(f, plan.costs)
        const oldAttrs = ornamentAttributes(f.tables, f.state(), f.state().player.heros_info.heros[0])
        const packets = f.call('UpgradeOrnament', { u32: initial.guid })
        assert.equal(packets.at(-1).id, 6021)
        assert(packets.slice(0, -1).some((p) => p.id === 6029))
        const current = f.state().ornaments.find((i) => i.guid === initial.guid)
        assert.deepEqual(current, { ...before, lv: before.lv + 1 })
        const attrs = ornamentAttributes(f.tables, f.state(), f.state().player.heros_info.heros[0])
        assert([...attrs].some(([id, value]) => value > (oldAttrs.get(id) ?? 0)))
        f.reload()
        assert.equal(f.state().ornaments.find((i) => i.guid === initial.guid).lv, 1)
    } finally {
        f.store.close()
    }
})

test('consecutive client auto-upgrade requests advance once each and stop atomically at the configured maximum', () => {
    const f = ornamentFixture('ornament-auto')
    try {
        const item = f.state().ornaments[0]
        const max = Math.max(
            ...f.tables
                .get('accessory_level')
                .filter((r) => r.accessoryId === item.id)
                .map((r) => r.level),
        )
        for (let level = 0; level < max; level++) {
            fund(f, nextOrnamentLevel(f.tables, { ...item, lv: level }).costs)
            f.call('UpgradeOrnament', { u32: item.guid })
            assert.equal(f.state().ornaments.find((i) => i.guid === item.guid).lv, level + 1)
        }
        const saved = structuredClone(f.state())
        assert.throws(
            () => f.call('UpgradeOrnament', { u32: item.guid }),
            (e) => e.code === ErrorCode.OrnamentMaxLv,
        )
        assert.deepEqual(f.state(), saved)
        assert.throws(
            () => f.call('UpgradeOrnament', { u32: 0xffffffff }),
            (e) => e.code === ErrorCode.OrnamentNotExist,
        )
        assert.deepEqual(f.state(), saved)
    } finally {
        f.store.close()
    }
})

test('a late currency shortage restores already deducted materials and never changes level or ownership', () => {
    const f = ornamentFixture('ornament-upgrade-atomic')
    try {
        const item = f.state().ornaments[0],
            costs = nextOrnamentLevel(f.tables, item).costs
        assert(costs.some((c) => c.itemtype === 3))
        const coin = costs.find((c) => c.itemtype === 10)
        assert(coin)
        fund(f, costs)
        f.store.transact(f.session.id, 0, (s) => {
            if (coin.itemid === 1 || coin.itemid === 2) s.player.basic_info[coin.itemid === 1 ? 'diamond' : 'gold'] = 0
            else s.player.attr_infos.attrs.find((a) => a.attr_id === coin.itemid).attr_val = '0'
        })
        const saved = structuredClone(f.state())
        assert.throws(
            () => f.call('UpgradeOrnament', { u32: item.guid }),
            (e) => e.code === ErrorCode.ItemNotEnough,
        )
        assert.deepEqual(f.state(), saved)
    } finally {
        f.store.close()
    }
})
