import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'
import { grantRewards } from '../src/rewards.js'

const config = configuration(),
    protocol = new Protocol(config.base)
function fixture(seeds = [1]) {
    const tables = new Tables(config.tables),
        store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => 1800000000, rng: (max) => max - 1 }),
        session = {}
    let seq = 1
    const call = (name, data = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, data) })
            .map((packet) => ({
                id: packet.id,
                data: protocol.decode(protocol.byId.get(packet.id).rsp, packet.payload),
            }))
    }
    call('EnterGame', { open_id: 'crop-reward' })
    store.transact(session.id, 0, (state) => {
        state.world.map_id = Number(tables.get('game').find((row) => row.title === 'HOME_ID').value)
        state.tasks = []
        state.taskRecords = tables
            .get('task')
            .filter((row) => row.type === 1)
            .map((row) => ({ task_id: row.id, count: 1, time: 1 }))
        state.home.builds.push(
            ...seeds.map((id, index) => ({
                guid: 100 + index,
                build_id: 20161,
                build_type: 15,
                status: 1,
                locate: { block_id: 102, anchor: 1 + index, direction: 0 },
                crop_info: {
                    field_type: 1,
                    water_num: 360,
                    water_max: 360,
                    seed_id: id,
                    state: 2,
                    state_finish_time: 1799999000,
                    pre_cost_time: 600,
                },
            })),
        )
    })
    return { call, tables, store, session, state: () => store.load(session.id).state }
}
const amount = (state, id) => BigInt(state.player.attr_infos.attrs.find((a) => a.attr_id === id)?.attr_val ?? 0)
const items = (state, id) =>
    state.player.sbag_infos.items.filter((item) => item.itemid === id).reduce((n, item) => n + item.itemnum, 0)

test('real single harvest credits configured crops and home EXP, syncs the wallet, and does not spawn EXP as an item model', () => {
    const f = fixture()
    try {
        const before = f.state(),
            packets = f.call('FieldHarvest', { build_guid: 100 }),
            reply = packets.find((p) => p.id === protocol.byName.get('CSProtoFieldHarvest').id).data
        assert.equal(items(f.state(), 400101) - items(before, 400101), 4)
        assert.equal(amount(f.state(), 1003) - amount(before, 1003), 16n)
        assert.ok(reply.reward.rewards.some((r) => r.itemtype === 10 && r.itemid === 1003 && r.itemnum === 16))
        assert.deepEqual(reply.drop_ids, [1210011])
        assert.ok(
            packets.some(
                (p) =>
                    p.id === protocol.byName.get('CSProtoSyncPlayerData').id &&
                    p.data.attr_infos?.attrs.some((a) => a.attr_id === 1003),
            ),
        )
        assert.equal(f.state().home.builds.find((b) => b.guid === 100).crop_info.seed_id, undefined)
        const after = f.state()
        assert.throws(() => f.call('FieldHarvest', { build_guid: 100 }), /not ready/)
        assert.deepEqual(f.state(), after)
    } finally {
        f.store.close()
    }
})

test('batch harvest grants EXP once per field and invalid later EXP configuration rolls back all earlier grants', () => {
    const f = fixture([1, 2])
    try {
        // The first crop crosses a home level before the second crop fails.
        // Rollback must restore level/EXP/reward receipts as well as bag items.
        f.store.transact(f.session.id, 0, (state) =>
            grantRewards(f.tables, state, [{ itemtype: 10, itemid: 1003, itemnum: 50 }]),
        )
        const before = f.state()
        const rows = f.tables
            .get('home_seeds')
            .map((row) => (row.id === 2 ? { ...row, homeDropId_exp: 4294967295 } : row))
        f.tables.cache.set('home_seeds', rows)
        f.tables.indices.delete('home_seeds')
        assert.throws(
            () => f.call('FieldHarvestList', { build_guids: [100, 101] }),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
        rows.find((row) => row.id === 2).homeDropId_exp = 1210120
        const reply = f
            .call('FieldHarvestList', { build_guids: [100, 101] })
            .find((p) => p.id === protocol.byName.get('CSProtoFieldHarvestList').id).data
        assert.equal(reply.results.length, 2)
        assert.equal(amount(f.state(), 1003) - amount(before, 1003), 32n)
        assert.equal(items(f.state(), 400101) - items(before, 400101), 4)
        assert.equal(items(f.state(), 400102) - items(before, 400102), 4)
    } finally {
        f.store.close()
    }
})

test('all configured normal harvest EXP drops are fixed guaranteed rows and may not be silently omitted', () => {
    const tables = new Tables(config.tables),
        seeds = tables.get('home_seeds').filter((row) => row.homeDropId_exp > 0)
    assert.equal(seeds.length, 50)
    for (const seed of seeds) {
        const row = tables.find('home_drop', seed.homeDropId_exp)
        assert.equal(row.itemType, 10)
        assert.equal(Number(row.itemId), 1003)
        assert.equal(row.rate, 10000)
        assert.equal(row.minValue, row.maxValue)
        assert.ok(row.minValue > 0)
    }
})
