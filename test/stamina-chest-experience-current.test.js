import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { EntrustCatalog } from '../src/entrust.js'
import { WorldObjectCatalog } from '../src/world-objects.js'
import { parseRewards } from '../src/rewards.js'
import { staminaChestExperience } from '../src/stamina-chest-experience.js'
import { materialServerFixture } from './material-blueprint-current-fixture.js'
import { ErrorCode } from '../src/error-codes.js'

const tables = new Tables(configuration().tables),
    catalog = new EntrustCatalog(tables)
const totalExperience = (f) => {
    const basic = f.state().player.basic_info
    let total = basic.exp
    for (let level = 1; level < basic.lv; level++) {
        assert(f.tables.find('player_level', level))
        total += f.tables.find('player_level', level).exp
    }
    return total
}
test('all124 current commission/material quotes match STAMINA_EXP;all400 reachable base/bonus pools contain no player XP', () => {
    const dropGroups = new Map()
    for (const row of new WorldObjectCatalog(tables).get('drop')) {
        if (!dropGroups.has(row.dropId)) dropGroups.set(row.dropId, [])
        dropGroups.get(row.dropId).push(row)
    }
    const visit = (id, ancestors = new Set()) => {
        assert(!ancestors.has(id), 'drop source must not cycle')
        const rows = dropGroups.get(id)
        assert(rows?.length, 'actual current drop source must exist')
        for (const row of rows.filter((value) => value.weight > 0 && value.maxValue > 0)) {
            if (row.type === 27) visit(row.itemId, new Set([...ancestors, id]))
            else
                assert(
                    !(row.type === 10 && row.itemId === 10),
                    'current fee XP must not be duplicated in any possible drop branch',
                )
        }
    }
    let count = 0,
        sources = 0
    for (const [table, kind] of [
        ['dungeon_entrust', undefined],
        ['dungeon_material', 'material'],
    ]) {
        const expected = table === 'dungeon_entrust' ? 32 : 92
        assert.equal(tables.get(table).length, expected)
        for (const row of tables.get(table)) {
            const chest = catalog.chest(row.id, kind),
                costs = parseRewards(chest.need)
            const expectedXp =
                costs
                    .filter((cost) => cost.itemtype === 10 && cost.itemid === 3)
                    .reduce((sum, cost) => sum + cost.itemnum, 0) * 10
            assert([300, 400].includes(expectedXp))
            assert.deepEqual(staminaChestExperience(tables, row.rewardShow, costs, 1), {
                itemtype: 10,
                itemid: 10,
                itemnum: expectedXp,
            })
            assert.deepEqual(
                staminaChestExperience(
                    tables,
                    row.rewardShow,
                    costs.map((cost) => ({ ...cost, itemnum: cost.itemnum * 3 })),
                    3,
                ),
                { itemtype: 10, itemid: 10, itemnum: expectedXp * 3 },
            )
            for (const id of [chest.drop, ...(kind === 'material' ? row.challengeReward.split('|').map(Number) : [])]) {
                visit(id)
                sources++
            }
            count++
        }
    }
    assert.equal(count, 124)
    assert.equal(sources, 400)
})

test('missing/bad rules,ambiguous preview,fee disagreement and numeric overflow use named configuration errors', () => {
    const costs = [{ itemtype: 10, itemid: 3, itemnum: 30 }],
        fake = (value, type = 'int') => ({
            get(name) {
                assert.equal(name, 'game')
                return value === undefined ? [] : [{ title: 'STAMINA_EXP', type, value }]
            },
        }),
        configError = (error) => error.code === ErrorCode.GameConfig
    for (const [source, preview, fee, shares] of [
        [fake(undefined), '10#10#300', costs, 1],
        [fake('0'), '10#10#300', costs, 1],
        [fake('10', 'float'), '10#10#300', costs, 1],
        [fake('10'), '', costs, 1],
        [fake('10'), '10#10#300#600', costs, 1],
        [fake('10'), '10#10#300|10#10#300', costs, 1],
        [fake('10'), '10#10#300', costs, 2],
        [fake('10'), '10#10#300', [], 1],
        [fake('10'), '10#10#300', [{ itemtype: 10, itemid: 3, itemnum: 0xffffffff }], 0xffffffff],
    ])
        assert.throws(() => staminaChestExperience(source, preview, fee, shares), configError)
    assert.equal(staminaChestExperience(fake('10'), '10#10#300|10#706#-1#2|3#400001#2#4', costs, 1).itemnum, 300)
})

test('real material victory pays no XP until9974;two40-stamina shares award800 once with codec rollback and login idempotence', () => {
    const f = materialServerFixture('material-fee-xp-current')
    try {
        f.begin(30101)
        const beforeVictory = totalExperience(f)
        f.win()
        assert.equal(totalExperience(f), beforeVictory)
        const before = f.state(),
            stamina = f.stamina(),
            pending = f.store.pending.get(before.player.basic_info.id),
            encode = f.protocol.encode,
            responseType = f.protocol.byName.get('CSProtoStaminaBoxGet').rsp
        try {
            f.protocol.encode = function (name, ...args) {
                if (name === responseType) throw Error('paid-xp-codec')
                return encode.call(this, name, ...args)
            }
            assert.throws(() => f.call('StaminaBoxGet', { box_id: f.chest().id, times: 2 }), /paid-xp-codec/)
            assert.deepEqual(f.state(), before)
            assert.strictEqual(f.store.pending.get(before.player.basic_info.id), pending)
        } finally {
            f.protocol.encode = encode
        }
        const value = f.reply('StaminaBoxGet', f.call('StaminaBoxGet', { box_id: f.chest().id, times: 2 }))
        assert.deepEqual(
            value.reward.rewards
                .filter((reward) => reward.itemtype === 10 && reward.itemid === 10)
                .map(({ itemtype, itemid, itemnum }) => ({ itemtype, itemid, itemnum })),
            [{ itemtype: 10, itemid: 10, itemnum: 800 }],
        )
        assert.equal(totalExperience(f), beforeVictory + 800)
        assert.equal(f.stamina(), stamina - 80)
        const earned = totalExperience(f)
        assert.deepEqual(
            f.reply('StaminaBoxGet', f.call('StaminaBoxGet', { box_id: f.chest().id, times: 1 })).reward.rewards,
            [],
        )
        f.login()
        assert.deepEqual(
            f.reply('StaminaBoxGet', f.call('StaminaBoxGet', { box_id: f.chest().id, times: 1 })).reward.rewards,
            [],
        )
        assert.equal(totalExperience(f), earned)
        assert.equal(f.stamina(), stamina - 80)
    } finally {
        f.close()
    }
})

test('a damaged quote or duplicate XP drop cannot charge stamina,change XP or consume the actual victory receipt', () => {
    const f = materialServerFixture('material-fee-xp-reject-current')
    try {
        f.begin(30101)
        f.win()
        const before = f.state(),
            get = f.tables.get,
            drops = WorldObjectCatalog.prototype.drops,
            request = { box_id: f.chest().id, times: 1 }
        try {
            f.tables.get = function (name, ...args) {
                const rows = get.call(this, name, ...args)
                return name === 'game' ? rows.filter((row) => row.title !== 'STAMINA_EXP') : rows
            }
            assert.throws(
                () => f.call('StaminaBoxGet', request),
                (error) => error.code === ErrorCode.GameConfig,
            )
            assert.deepEqual(f.state(), before)
        } finally {
            f.tables.get = get
        }
        try {
            WorldObjectCatalog.prototype.drops = function (id, ...args) {
                const rows = drops.call(this, id, ...args)
                return id === f.chest().drop ? [...rows, { itemtype: 10, itemid: 10, itemnum: 300 }] : rows
            }
            assert.throws(
                () => f.call('StaminaBoxGet', request),
                (error) => error.code === ErrorCode.GameConfig,
            )
            assert.deepEqual(f.state(), before)
        } finally {
            WorldObjectCatalog.prototype.drops = drops
        }
        f.store.transact(f.state().player.basic_info.id, 0, (state) => {
            state.player.attr_infos.attrs.find((row) => row.attr_id === 3).attr_val = '1'
        })
        const poor = f.state()
        assert.throws(
            () => f.call('StaminaBoxGet', request),
            (error) => error.code === ErrorCode.ItemNotEnough,
        )
        assert.deepEqual(f.state(), poor)
        f.store.transact(f.state().player.basic_info.id, 0, (state) => {
            state.player.attr_infos.attrs.find((row) => row.attr_id === 3).attr_val =
                before.player.attr_infos.attrs.find((row) => row.attr_id === 3).attr_val
        })
        f.call('StaminaBoxGet', request)
        assert.equal(f.run().chest_claimed, true)
    } finally {
        f.close()
    }
})
