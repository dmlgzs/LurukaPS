import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { parseRewards, grantRewards } from '../src/rewards.js'
import { addItems } from '../src/inventory.js'
import { gridAnchor } from '../src/home-grid.js'
import { ErrorCode } from '../src/error-codes.js'

function fixture(name, level = 6) {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base),
        store = new Store(':memory:'),
        game = new Game(protocol, store, tables),
        session = {}
    let seq = 1
    const call = (name, data = {}, target = session) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(target, {
            id: e.id,
            seq: seq++,
            payload: e.req ? protocol.encode(e.req, data) : Buffer.alloc(0),
        })
    }
    call('EnterGame', { open_id: name })
    store.transact(session.id, 0, (s) => {
        s.world.map_id = 100
        s.player.basic_info.lv = level
        ;(s.taskRecords ??= []).push({ task_id: 106009, count: 1 }, { task_id: 400201, count: 1 })
        s.player.basic_info.gold = 10000000
        const costs = new Map(),
            currencies = new Map()
        for (const row of tables.get('home_building_collection'))
            for (const cost of parseRewards(row.material))
                if (cost.itemtype === 3) costs.set(cost.itemid, (costs.get(cost.itemid) || 0) + cost.itemnum)
                else if (cost.itemtype === 10)
                    currencies.set(cost.itemid, (currencies.get(cost.itemid) || 0) + cost.itemnum)
        for (const [attr_id, total] of currencies) {
            const attr = s.player.attr_infos.attrs.find((row) => row.attr_id === attr_id)
            if (attr) attr.attr_val = String(total + 100)
            else s.player.attr_infos.attrs.push({ attr_id, attr_val: String(total + 100) })
        }
        addItems(
            s,
            [...costs].map(([itemid, itemnum]) => ({ itemtype: 3, itemid, itemnum: itemnum + 100 })),
        )
    })
    return {
        tables,
        protocol,
        store,
        game,
        session,
        call,
        state: () => store.load(session.id).state,
        close: () => store.close(),
    }
}
const unlock = (f, id, source = 0) => f.call('CollectBuildCreate', { collect_id: id, source_build: source })
const count = (s, id) =>
    s.player.sbag_infos.items.filter((item) => item.itemid === id).reduce((n, item) => n + item.itemnum, 0)
const currency = (s, id) => Number(s.player.attr_infos.attrs.find((row) => row.attr_id === id)?.attr_val ?? 0)
const definition = (f, id) => {
    const row = f.tables.find('home_collection_world', id)
    return f.tables.get('home_building_collection').find((b) => b.groupId === row.groupId && b.level === 1)
}

test('6526 repairs the configured world collection ID once with real costs and typed55 sync before acknowledgement', () => {
    const f = fixture('world-collect-create')
    try {
        const before = f.state(),
            config = definition(f, 1),
            out = unlock(f, 1),
            after = f.state()
        const acknowledgement = out.findIndex((packet) => packet.id === 6526)
        assert(acknowledgement >= 0)
        const packet = out.find((p) => p.id === 6102)
        assert(packet)
        assert(out.indexOf(packet) < acknowledgement)
        const wire = f.protocol.decode('SCHomeSync', packet.payload).home_builds.find((b) => b.build_type === 55)
        assert.equal(wire.collect_build_data.guid, 1)
        assert.equal(wire.collect_build_data.build_id, config.id)
        assert.equal(wire.collect_build_data.pet_guid, '0')
        assert.deepEqual(wire.collect_build_data.items, [])
        assert.equal(wire.collect_build_data.start_time, 0)
        assert.equal(wire.guid, after.home.worldCollections[1].guid)
        assert.equal(
            currency(after, 103),
            currency(before, 103) -
                parseRewards(config.material)
                    .filter((r) => r.itemtype === 10 && r.itemid === 103)
                    .reduce((n, r) => n + r.itemnum, 0),
        )
        assert.equal(after.player.basic_info.gold, before.player.basic_info.gold)
        for (const cost of parseRewards(config.material).filter((r) => r.itemtype === 3))
            assert.equal(count(after, cost.itemid), count(before, cost.itemid) - cost.itemnum)
        assert.deepEqual(after.world, before.world)
        assert.deepEqual(after.pets, before.pets)
        const settled = f.state()
        unlock(f, 1)
        assert.deepEqual(f.state(), settled)
        const login = f.call('EnterGame', { open_id: 'world-collect-create' }, {})
        const saved = f.protocol
            .decode('SCHomeSync', login.find((p) => p.id === 6102).payload)
            .home_builds.find((b) => b.build_type === 55)
        assert.equal(saved.guid, wire.guid)
        assert.equal(saved.collect_build_data.build_id, config.id)
    } finally {
        f.close()
    }
})
test('all33 configured world points resolve by domain/area/group and pay their own materials', () => {
    const f = fixture('world-collect-all')
    try {
        const all = f.tables.get('home_collection_world'),
            before = f.state(),
            total = new Map()
        assert.equal(all.length, 33)
        for (const row of all) {
            for (const cost of parseRewards(definition(f, row.id).material))
                total.set(
                    cost.itemtype + ':' + cost.itemid,
                    (total.get(cost.itemtype + ':' + cost.itemid) || 0) + cost.itemnum,
                )
            unlock(f, row.id)
        }
        const after = f.state(),
            entries = Object.values(after.home.worldCollections)
        assert.equal(entries.length, 33)
        for (const row of all) assert.equal(after.home.worldCollections[row.id].build_id, definition(f, row.id).id)
        assert.equal(currency(after, 103), currency(before, 103) - total.get('10:103'))
        assert.equal(after.player.basic_info.gold, before.player.basic_info.gold)
        for (const [key, value] of total)
            if (key.startsWith('3:'))
                assert.equal(count(after, Number(key.slice(2))), count(before, Number(key.slice(2))) - value)
        const identities = [...after.home.builds, ...Object.values(after.home.ranches || {}), ...entries].map(
            (b) => b.guid,
        )
        assert.equal(new Set(identities).size, identities.length)
        assert.deepEqual(after.world, before.world, 'remote management does not teleport the owner')
    } finally {
        f.close()
    }
})
test('the region task condition follows domain.areaId rather than treating domainId as the area ID', () => {
    const f = fixture('world-collect-area')
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.taskRecords = s.taskRecords.filter((row) => ![106009, 400201].includes(row.task_id))
        })
        let before = f.store.load(f.session.id)
        assert.throws(
            () => unlock(f, 1),
            (e) => e.code === ErrorCode.CollectBuildConditionLimit,
        )
        assert.deepEqual(f.store.load(f.session.id), before)
        f.store.transact(f.session.id, 0, (s) => {
            s.taskRecords.push({ task_id: 106009, count: 1 })
        })
        unlock(f, 1)
        before = f.store.load(f.session.id)
        assert.throws(
            () => unlock(f, 26),
            (e) => e.code === ErrorCode.CollectBuildConditionLimit,
        )
        assert.deepEqual(f.store.load(f.session.id), before)
        f.store.transact(f.session.id, 0, (s) => {
            s.taskRecords.push({ task_id: 400201, count: 1 })
        })
        unlock(f, 26)
        assert.equal(f.state().home.worldCollections[26].collect_id, 26)
    } finally {
        f.close()
    }
})
test('unknown IDs, missing materials, retained source variants and response failures cannot spend or create partly', () => {
    const f = fixture('world-collect-invalid')
    try {
        let before = f.store.load(f.session.id)
        assert.throws(
            () => unlock(f, 1110101),
            (e) => e.code === ErrorCode.CollectWorldConfNotFound,
        )
        assert.deepEqual(f.store.load(f.session.id), before)
        assert.throws(
            () => unlock(f, 1, 123),
            (e) => e.code === ErrorCode.FunctionClosed,
        )
        assert.deepEqual(f.store.load(f.session.id), before)
        f.store.transact(f.session.id, 0, (s) => {
            s.player.sbag_infos.items = s.player.sbag_infos.items.filter((i) => i.itemid !== 300000)
        })
        before = f.store.load(f.session.id)
        assert.throws(
            () => unlock(f, 1),
            (e) => e.code === ErrorCode.ItemNotEnough,
        )
        assert.deepEqual(f.store.load(f.session.id), before)
        f.store.transact(f.session.id, 0, (s) => {
            addItems(s, [{ itemtype: 3, itemid: 300000, itemnum: 50 }])
        })
        before = f.store.load(f.session.id)
        const packet = f.game.packet
        f.game.packet = function (name, ...args) {
            if (name === 'CSProtoHomeSync') throw Error('collect sync failed')
            return packet.call(this, name, ...args)
        }
        assert.throws(() => unlock(f, 1), /collect sync failed/)
        assert.deepEqual(f.store.load(f.session.id), before)
        f.game.packet = packet
        unlock(f, 1)
        assert(f.state().home.worldCollections[1])
    } finally {
        f.close()
    }
})

test('repair currency103 is independent of gold2 and insufficient currency cannot borrow from the gold wallet', () => {
    const f = fixture('world-collect-currency')
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.player.attr_infos.attrs.find((row) => row.attr_id === 103).attr_val = '0'
        })
        const before = f.store.load(f.session.id)
        assert(before.state.player.basic_info.gold > 1000000)
        assert.throws(
            () => unlock(f, 16),
            (error) => error.code === ErrorCode.ItemNotEnough,
        )
        assert.deepEqual(f.store.load(f.session.id), before)
    } finally {
        f.close()
    }
})
test('ranch initialization and normal/shared allocation cannot reuse a world container GUID when a legacy counter is missing', () => {
    const f = fixture('world-collect-guid', 1)
    try {
        unlock(f, 1)
        const guid = f.state().home.worldCollections[1].guid
        assert(!f.state().home.ranches?.[201])
        f.store.transact(f.session.id, 0, (s) => {
            delete s.home.nextBuildGuid
            s.player.basic_info.lv = 6
        })
        f.call('HomeTechnologyTypeInfo', { type: 1 })
        const ranch = f.state().home.ranches[201]
        assert(ranch.guid > guid)
        f.store.transact(f.session.id, 0, (s) => {
            delete s.home.nextBuildGuid
        })
        unlock(f, 2)
        const after = f.state(),
            ids = [
                ...after.home.builds,
                ...Object.values(after.home.ranches),
                ...Object.values(after.home.worldCollections),
            ].map((e) => e.guid)
        assert.equal(new Set(ids).size, ids.length)
        f.store.transact(f.session.id, 0, (s) => {
            s.world.map_id = Number(f.tables.get('game').find((row) => row.title === 'HOME_ID').value)
            delete s.home.nextBuildGuid
            grantRewards(f.tables, s, [{ itemtype: 13, itemid: 10000, itemnum: 1 }])
        })
        const result = f.call('BuildLocate', {
            build_id: 10000,
            locate: { block_id: 101, anchor: gridAnchor(-60, -20), direction: 0 },
        })
        const build = f.protocol.decode('WorldMapHomeBuild', result.find((packet) => packet.id === 6105).payload)
        assert(!ids.includes(build.guid), 'placing a real building preserves the virtual container identities')
    } finally {
        f.close()
    }
})
