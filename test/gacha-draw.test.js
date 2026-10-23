import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { GachaCatalog } from '../src/gacha.js'
import { GachaDrawEngine } from '../src/gacha-draw.js'
import { gachaTables } from '../src/gacha-tables.js'
import { grantRewards } from '../src/rewards.js'
import { ErrorCode } from '../src/error-codes.js'
const cfg = configuration()
function fixture(name, options = {}) {
    const tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base),
        store = new Store(':memory:'),
        session = {}
    const { prepareTables, ...gameOptions } = options
    if (prepareTables) prepareTables(tables)
    const game = new Game(protocol, store, tables, { clock: () => 1790000000, ...gameOptions })
    let seq = 1
    const frame = (name, data = {}, number = seq++) => {
        const e = protocol.byName.get('CSProto' + name)
        return { id: e.id, seq: number, payload: protocol.encode(e.req, data) }
    }
    const dispatch = (request, who = session) => {
        const e = protocol.byId.get(request.id),
            packets = game.dispatch(who, request),
            ack = packets.find((p) => p.id === e.id)
        return { packets, data: protocol.decode(e.rsp, ack.payload) }
    }
    const call = (name, data = {}, who = session) => dispatch(frame(name, data), who)
    const login = call('EnterGame', { open_id: name })
    const state = () => store.load(session.id).state
    const fund = (id, count) =>
        store.transact(session.id, 0, (s) => grantRewards(tables, s, [{ itemtype: 3, itemid: id, itemnum: count }]))
    const count = (id) =>
        state()
            .player.sbag_infos.items.filter((i) => i.itemid === id)
            .reduce((n, i) => n + i.itemnum, 0)
    const pool = (id) => state().gacha.pools[id]
    const draw = (id, count = 1) => call('GachaDraw', { pool_id: id, draw_count: count })
    return { tables, protocol, store, session, game, frame, dispatch, call, login, state, fund, count, pool, draw }
}
function wallet(f, diamond, paid = 0, bonus = 0) {
    f.store.transact(f.session.id, 0, (s) => {
        s.player.basic_info.diamond = diamond
        for (const [id, value] of [
            [901, paid],
            [902, bonus],
        ]) {
            const old = s.player.attr_infos.attrs.find((a) => a.attr_id === id)
            if (old) old.attr_val = String(value)
            else s.player.attr_infos.attrs.push({ attr_id: id, attr_val: String(value) })
        }
    })
}

test('the confirmed 9701 buys only missing tickets and replay never spends diamonds again', () => {
    const f = fixture('gacha-ticket-exchange', { rng: (max) => max - 1 })
    try {
        f.fund(501001, 3)
        wallet(f, 2000)
        const request = f.frame('GachaDraw', { pool_id: 1001, draw_count: 10 })
        const result = f.dispatch(request)
        assert.equal(result.data.gacha_results.length, 10)
        assert.equal(f.count(501001), 0)
        assert.equal(f.state().player.basic_info.diamond, 880)
        const syncEntry = f.protocol.byName.get('CSProtoSyncPlayerData')
        const sync = result.packets.find(
            (p) => p.id === syncEntry.id && f.protocol.decode(syncEntry.rsp, p.payload).basic_info,
        )
        assert(sync)
        assert(result.packets.indexOf(sync) < result.packets.findIndex((p) => p.id === 9701))
        f.dispatch(request)
        assert.equal(f.state().player.basic_info.diamond, 880)
        assert.equal(f.state().gacha.history.length, 10)
    } finally {
        f.store.close()
    }
})

test('confirmed ticket exchange uses free diamonds first then the combined paid and bonus star wallet', () => {
    const f = fixture('gacha-star-exchange', { rng: (max) => max - 1 })
    try {
        wallet(f, 100, 100, 20)
        f.draw(2001)
        assert.equal(f.count(501002), 0)
        assert.equal(f.state().player.basic_info.diamond, 0)
        assert.equal(f.state().player.attr_infos.attrs.find((a) => a.attr_id === 902).attr_val, '0')
        assert.equal(f.state().player.attr_infos.attrs.find((a) => a.attr_id === 901).attr_val, '60')
        f.fund(501002, 1)
        f.draw(2001)
        assert.equal(f.state().player.attr_infos.attrs.find((a) => a.attr_id === 901).attr_val, '60')
    } finally {
        f.store.close()
    }
})

test('ticket exchange respects the discounted fee, expired stacks and the genuinely free first draw', () => {
    const f = fixture('gacha-exchange-discount', { rng: (max) => max - 1 })
    try {
        wallet(f, 2000)
        f.fund(501000, 3)
        f.store.transact(f.session.id, 0, (s) =>
            s.player.sbag_infos.items.push({
                itemid: 501000,
                itemnum: 20,
                itemtype: 3,
                guid: '900000',
                deadtime: 1780000000,
            }),
        )
        f.draw(8001, 10)
        assert.equal(f.state().player.basic_info.diamond, 1200)
        assert.equal(f.state().player.sbag_infos.items.find((i) => i.guid === '900000').itemnum, 20)
        f.draw(9001)
        assert.equal(f.state().player.basic_info.diamond, 1200)
    } finally {
        f.store.close()
    }
})

test('insufficient combined currency and a later bad reward roll back the entire exchange and draw', () => {
    const f = fixture('gacha-exchange-atomic', { rng: (max) => max - 1 })
    const band = gachaTables(f.tables)
            .get('gacha_add_reward')
            .find((r) => r.type === 2 && r.rarity === 2),
        old = band.reward
    try {
        wallet(f, 100, 30, 29)
        let saved = structuredClone(f.state())
        assert.throws(
            () => f.draw(2001),
            (e) => e.code === ErrorCode.ItemNotEnough,
        )
        assert.deepEqual(f.state(), saved)
        wallet(f, 1600)
        band.reward = '3#4294967295#1'
        saved = structuredClone(f.state())
        assert.throws(
            () => f.draw(2001, 10),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), saved)
    } finally {
        band.reward = old
        f.store.close()
    }
})
test('all five current pools compile their actual 17 populated guarantee rules', () => {
    const tables = gachaTables(new Tables(cfg.tables)),
        catalog = new GachaCatalog(tables),
        engine = new GachaDrawEngine(catalog, tables)
    let count = 0
    for (const config of catalog.pools.values()) {
        const compiled = engine.compile(config)
        assert.equal(compiled.scale, 100000)
        assert(compiled.rules.every((rule) => rule.buckets.every((bucket) => bucket.items.length > 0)))
        count += compiled.rules.length
    }
    assert.equal(catalog.pools.size, 5)
    assert.equal(count, 17)
})

test('ordinary category masses share one model with HTTP details without counting forced tutorial rewards twice', () => {
    const tables = gachaTables(new Tables(cfg.tables)),
        catalog = new GachaCatalog(tables),
        engine = new GachaDrawEngine(catalog, tables)
    for (const [id, ssr] of [
        [1001, 800],
        [2001, 1200],
        [8001, 800],
        [9001, 800],
        [10001, 1200],
    ]) {
        const model = engine.compile(catalog.configuration(id))
        const mass = (rarity) =>
            model.rules.filter((rule) => rule.minimum === rarity).reduce((sum, rule) => sum + rule.probability_mass, 0)
        assert.equal(mass(4), ssr)
        assert.equal(mass(3), 6000)
        assert.equal(mass(2), 100000 - ssr - 6000)
        assert.equal(model.rules.at(-1).probability_threshold, 100000)
        if (id === 8001) assert.equal(model.rules.find((rule) => rule.guaranteeId === 801).probability_mass, 0)
        if (id === 9001) {
            const tutorial = model.rules.find((rule) => rule.guaranteeId === 900)
            assert.equal(tutorial.probability_mass, 0)
            assert.equal(tutorial.probability_threshold, 0)
        }
    }
})

test('category probabilities need not be increasing thresholds, while overflowing total mass is rejected', () => {
    const tables = gachaTables(new Tables(cfg.tables)),
        catalog = new GachaCatalog(tables),
        engine = new GachaDrawEngine(catalog, tables)
    catalog.guarantees.set(101, { ...catalog.guarantees.get(101), probability_base: 2000 })
    catalog.guarantees.set(103, { ...catalog.guarantees.get(103), probability_base: 1000 })
    const model = engine.compile(catalog.configuration(1001))
    assert.deepEqual(
        model.rules.map((rule) => rule.probability_mass),
        [2000, 1000, 97000],
    )
    assert.deepEqual(
        model.rules.map((rule) => rule.probability_threshold),
        [2000, 3000, 100000],
    )
    catalog.guarantees.set(101, { ...catalog.guarantees.get(101), probability_base: 99500 })
    assert.throws(
        () => engine.compile(catalog.configuration(1001)),
        (error) => error.code === ErrorCode.GameConfig,
    )
})
test('5200 publishes the explicit offline card-pool window on login and preserves it through activity refresh', () => {
    const f = fixture('gacha-time-sync')
    try {
        for (const packets of [f.login.packets, f.call('ActivityGet').packets]) {
            const packet = packets.find((p) => p.id === 5200)
            assert(packet)
            const times = f.protocol.decode(f.protocol.byId.get(5200).rsp, packet.payload).data_list
            for (const id of [90, 91, 92, 93, 94]) {
                const row = times.find((t) => t.time_id === id)
                assert.equal(row.start_time, '0')
                assert.equal(row.end_time, '4102444800')
            }
        }
    } finally {
        f.store.close()
    }
})
test('a real SSR draw spends the correct ticket, transforms an owned hero, grants table extras and writes queryable history', () => {
    const f = fixture('gacha-real-up', { rng: () => 0 })
    try {
        f.fund(501001, 2)
        const shard = f.count(1100005),
            extra = f.count(502001),
            tickets = f.count(501001)
        const { packets, data } = f.draw(1001)
        assert.deepEqual(data.gacha_results[0], {
            main_item: { item_type: 1, item_id: 101010, item_num: 1 },
            extra_item: [{ item_type: 3, item_id: 502001, item_num: 20 }],
            transform_item: { item_type: 3, item_id: 1100005, item_num: 1 },
            gacha_surprise: { surprise_type: 0 },
        })
        assert.equal(f.count(501001), tickets - 1)
        assert.equal(f.count(1100005), shard + 1)
        assert.equal(f.count(502001), extra + 20)
        assert.equal(data.pool_info.gacha_pool.pool_draw_count, 1)
        assert.equal(data.pool_info.gacha_pool.draw_up_hero_count, 1)
        assert(data.pool_info.pity.filter((p) => [101, 103].includes(p.pity_id)).every((p) => p.pity_count === 0))
        const ack = packets.findIndex((p) => p.id === 9701),
            sync = f.protocol.byName.get('CSProtoSyncPlayerData').id
        assert(packets.slice(0, ack).some((p) => p.id === sync))
        const history = f
            .call('GachaHistory', { gacha_type: 1, cursor: '0', select_num: 20 })
            .packets.find((p) => p.id === 9706)
        const page = f.protocol.decode(f.protocol.byId.get(9706).rsp, history.payload)
        assert.equal(page.total_count, '1')
        assert.deepEqual(page.items[0].item, [{ item_type: 1, item_id: 101010, item_num: 1 }])
        f.call('EnterGame', { open_id: 'gacha-real-up' }, {})
        assert.equal(f.pool(1001).gacha_pool.pool_draw_count, 1)
        assert.equal(f.state().gacha.hero_counts[101010], 2)
    } finally {
        f.store.close()
    }
})
test('disjoint base probabilities and four-star-or-higher guarantees preserve higher-rarity outcomes', () => {
    for (const [roll, rarity] of [
        [799, 4],
        [800, 3],
        [5999, 3],
        [6000, 3],
        [6799, 3],
        [6800, 2],
        [99999, 2],
    ]) {
        const f = fixture('gacha-boundary-' + roll, { rng: (max) => (max === 100000 ? roll : 0) })
        try {
            f.fund(501001, 1)
            const main = f.draw(1001).data.gacha_results[0].main_item
            assert.equal(f.tables.find(main.item_type === 1 ? 'hero' : 'soulessence', main.item_id).rarity, rarity)
            if (rarity === 3) assert.equal(f.pool(1001).gacha_pool.draw_up_hero_count, 0)
        } finally {
            f.store.close()
        }
    }
    const f = fixture('gacha-pity-priority', { rng: (max) => max - 1 })
    try {
        f.fund(501001, 2)
        f.call('GachaData')
        f.store.transact(f.session.id, 0, (s) => {
            const pity = s.gacha.pools[1001].pity
            pity.find((p) => p.pity_id === 101).pity_count = 88
            pity.find((p) => p.pity_id === 103).pity_count = 9
        })
        assert.equal(f.tables.find('soulessence', f.draw(1001).data.gacha_results[0].main_item.item_id).rarity, 3)
        const next = f.draw(1001).data
        assert.equal(next.gacha_results[0].main_item.item_id, 101010)
        assert(next.pool_info.pity.filter((p) => [101, 103].includes(p.pity_id)).every((p) => p.pity_count === 0))
    } finally {
        f.store.close()
    }
})
test('newbie ten-pulls cost eight tickets, force a first SSR within thirty and stop at the real pool limit', () => {
    const f = fixture('gacha-newbie', { rng: (max) => max - 1 })
    try {
        f.fund(501000, 32)
        const before = f.count(501000)
        assert.throws(
            () => f.draw(8001, 1),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
        for (let batch = 0; batch < 3; batch++) {
            const reply = f.draw(8001, 10).data
            assert.equal(reply.gacha_results.length, 10)
        }
        assert.equal(f.count(501000), before - 24)
        assert.equal(f.pool(8001).gacha_pool.pool_draw_count, 30)
        assert(f.pool(8001).pity.find((p) => p.pity_id === 801).is_completed)
        assert(f.pool(8001).gacha_pool.triggered_special_rules.includes(801))
        assert.equal(f.state().gacha.history.length, 30)
        const saved = structuredClone(f.state())
        assert.throws(
            () => f.draw(8001, 10),
            (e) => e.code === ErrorCode.GachaPoolIsNotOpen,
        )
        assert.deepEqual(f.state(), saved)
    } finally {
        f.store.close()
    }
})
test('FIRST_FREE requires a single observation and its one-time fixed target is not repeated', () => {
    const f = fixture('gacha-first-free', { rng: (max) => max - 1 })
    try {
        assert.throws(
            () => f.draw(9001, 10),
            (e) => e.code === ErrorCode.GachaFirstDrawNotUsed,
        )
        const first = f.draw(9001).data
        assert.equal(first.gacha_results[0].main_item.item_id, 102001)
        assert.equal(first.pool_info.gacha_pool.pool_draw_count, 1)
        assert(first.pool_info.pity.find((p) => p.pity_id === 900).is_completed)
        const saved = structuredClone(f.state())
        assert.throws(
            () => f.draw(9001),
            (e) => e.code === ErrorCode.ItemNotEnough,
        )
        assert.deepEqual(f.state(), saved)
        f.fund(501000, 1)
        assert.equal(f.draw(9001).data.gacha_results[0].main_item.item_type, 9)
    } finally {
        f.store.close()
    }
})
test('missing schedules can be closed or explicitly overridden, while genuine time rows retain their actual dates', () => {
    const f = fixture('gacha-closed', { gachaPolicy: { missing_schedule: 'closed' } })
    try {
        f.fund(501001, 1)
        const saved = structuredClone(f.state())
        assert.throws(
            () => f.draw(1001),
            (e) => e.code === ErrorCode.GachaPoolIsNotOpen,
        )
        assert.deepEqual(f.state(), saved)
        const tables = gachaTables(f.tables),
            catalog = new GachaCatalog(tables),
            engine = new GachaDrawEngine(catalog, tables)
        assert.equal(engine.open({ ...catalog.configuration(1001), timelimit: 1 }, 1790000000), false)
    } finally {
        f.store.close()
    }
    const open = fixture('gacha-override', {
        rng: () => 0,
        gachaPolicy: { missing_schedule: 'closed', pool_overrides: { 1001: true } },
    })
    try {
        open.fund(501001, 1)
        assert.equal(open.draw(1001).data.gacha_results.length, 1)
    } finally {
        open.store.close()
    }
})
test('a new permanent hero receives a normal GUID and ownership/battle cache before the draw result', () => {
    const f = fixture('gacha-new-hero', { rng: () => 0 })
    try {
        f.store.transact(
            f.session.id,
            0,
            (s) => (s.player.heros_info.heros = s.player.heros_info.heros.filter((h) => h.conf_id !== 101010)),
        )
        f.fund(501001, 1)
        // Removing a debug-seeded hero in the fixture does not notify the
        // client. Model the cold cache of a client which never owned it.
        f.session.syncCache.clear()
        const { packets, data } = f.draw(1001),
            hero = f.state().player.heros_info.heros.find((h) => h.conf_id === 101010)
        assert(hero)
        assert.equal(BigInt(hero.guid) >> 56n, 1n)
        assert(!data.gacha_results[0].transform_item)
        const ack = packets.findIndex((p) => p.id === 9701),
            sync = f.protocol.byName.get('CSProtoSyncPlayerData').id
        assert(
            packets
                .slice(0, ack)
                .filter((p) => p.id === sync)
                .some((p) =>
                    f.protocol
                        .decode(f.protocol.byId.get(sync).rsp, p.payload)
                        .heros_info?.heros.some((h) => h.conf_id === 101010),
                ),
        )
        assert(packets.slice(0, ack).some((p) => p.id === f.protocol.byName.get('CSProtoHeroAttrInfoSync').id))
        assert.equal(f.state().gacha.hero_counts[101010], 1)
    } finally {
        f.store.close()
    }
})
test('request receipts prevent double spending, reject changed input and return current counters after later draws', () => {
    const f = fixture('gacha-receipt', { rng: () => 0 })
    try {
        f.fund(501001, 4)
        const frame = f.frame('GachaDraw', { pool_id: 1001, draw_count: 1 }),
            first = f.dispatch(frame).data,
            saved = structuredClone(f.state())
        assert.deepEqual(f.dispatch(frame).data.gacha_results, first.gacha_results)
        assert.deepEqual(f.state(), saved)
        f.draw(1001)
        const after = structuredClone(f.state()),
            replay = f.dispatch(frame).data
        assert.equal(replay.pool_info.gacha_pool.pool_draw_count, 2)
        assert.deepEqual(f.state(), after)
        const changed = { ...frame, payload: f.protocol.encode('CSDoGachaReq', { pool_id: 1001, draw_count: 10 }) }
        assert.throws(
            () => f.dispatch(changed),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
        assert.deepEqual(f.state(), after)
        assert(Object.keys(f.state().gacha.draw_receipts).every((key) => /^[0-9a-f]{64}$/.test(key)))
    } finally {
        f.store.close()
    }
})
test('a later invalid extra reward rolls back tickets, converted shards, previous results, counters and history', () => {
    let rolls = 0
    const f = fixture('gacha-atomic', { rng: (max) => (max === 100000 ? (rolls++ === 0 ? 0 : 99999) : 0) }),
        tables = gachaTables(f.tables)
    const band = tables.get('gacha_add_reward').find((r) => r.type === 2 && r.rarity === 2),
        old = band.reward
    try {
        f.fund(501001, 10)
        band.reward = '3#4294967295#1'
        const before = structuredClone(f.state())
        assert.throws(
            () => f.draw(1001, 10),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
        assert.equal(rolls, 2)
    } finally {
        band.reward = old
        f.store.close()
    }
})
test('history allocation remains exact above 2^53 and a uint64 exhaustion rolls back the entire batch', () => {
    const f = fixture('gacha-history-large', { rng: (max) => max - 1 })
    try {
        f.fund(501001, 20)
        f.call('GachaData')
        f.store.transact(f.session.id, 0, (s) => (s.gacha.nextRecordId = '9007199254740993'))
        f.draw(1001)
        assert.equal(f.state().gacha.history[0].record_id, '9007199254740993')
        assert.equal(f.state().gacha.nextRecordId, '9007199254740994')
        f.store.transact(f.session.id, 0, (s) => (s.gacha.nextRecordId = '18446744073709551615'))
        const before = structuredClone(f.state())
        assert.throws(
            () => f.draw(1001, 10),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})
test('actual draw counters unlock existing 9702 and 9703 claims, including duplicate UP heroes', () => {
    const f = fixture('gacha-claims', { rng: () => 0 })
    try {
        f.fund(501001, 10)
        f.draw(1001, 10)
        assert.equal(f.count(502001), 320)
        assert.equal(f.count(1100005), 10)
        assert.equal(f.pool(1001).gacha_pool.draw_up_hero_count, 10)
        assert(f.call('GachaStep', { u32: 1001 }).data.rewards.rewards.length)
        const up = f.call('GachaUp', { u32: 1001 }).data
        assert.equal(
            up.rewards.rewards.reduce((sum, r) => sum + (r.itemtype === 10 && r.itemid === 1 ? r.itemnum : 0), 0),
            450,
        )
        assert.deepEqual(f.call('GachaStep', { u32: 1001 }).data.rewards.rewards, [])
        assert.deepEqual(f.call('GachaUp', { u32: 1001 }).data.rewards.rewards, [])
        // Counter migration starts at one owned copy; the 8+ row is reached.
        assert.equal(f.state().gacha.hero_counts[101010], 11)
    } finally {
        f.store.close()
    }
})

test('permanent soul aiming uses the explicit local policy and creates a real owned equipment instance', () => {
    const f = fixture('gacha-aim-draw', { rng: () => 0 })
    try {
        f.fund(501000, 1)
        f.call('GachaAimTarget', { pool_id: 10001, item_id: 10037 })
        const before = f.state().player.soulessence_infos.soulessences.filter((s) => s.id === 10037).length
        const { data } = f.draw(10001)
        assert.deepEqual(data.gacha_results[0].main_item, { item_type: 9, item_id: 10037, item_num: 1 })
        assert.equal(f.state().player.soulessence_infos.soulessences.filter((s) => s.id === 10037).length, before + 1)
        assert(data.gacha_results[0].extra_item.some((i) => i.item_id === 502001 && i.item_num === 20))
    } finally {
        f.store.close()
    }
})

test('the limited soul pool spends its distinct ticket and never counts soul acquisitions as UP heroes', () => {
    const f = fixture('gacha-limited-soul', { rng: () => 0 })
    try {
        f.fund(501002, 1)
        const before = f.state().player.soulessence_infos.soulessences.length,
            { data } = f.draw(2001)
        assert.deepEqual(data.gacha_results[0].main_item, { item_type: 9, item_id: 10122, item_num: 1 })
        assert.equal(f.count(501002), 0)
        assert.equal(f.state().player.soulessence_infos.soulessences.length, before + 1)
        assert.equal(data.pool_info.gacha_pool.draw_up_hero_count, 0)
        assert(data.pool_info.pity.filter((p) => [201, 203].includes(p.pity_id)).every((p) => p.pity_count === 0))
    } finally {
        f.store.close()
    }
})
test('four-star category weights select the declared UP, ordinary-hero and soul buckets', () => {
    const offered = new Tables(cfg.tables).get('gacha_pool').find((r) => r.gachaId === 1001)
    for (const [weightRoll, field] of [
        [1, 'UP_hero_SR'],
        [2, 'hero_SR'],
        [3, 'soulessence_SR'],
    ]) {
        const f = fixture('gacha-sr-bucket-' + weightRoll, {
            rng: (max) => (max === 100000 ? 1000 : max === 4 ? weightRoll : 0),
        })
        try {
            f.fund(501001, 1)
            const main = f.draw(1001).data.gacha_results[0].main_item
            assert(offered[field].split('|').some((token) => Number(token.split('#')[1]) === main.item_id))
        } finally {
            f.store.close()
        }
    }
})
test('central hero rewards contribute to the same acquisition counter used by gacha extra reward bands', () => {
    const f = fixture('gacha-cross-source-count', { rng: () => 0 })
    try {
        f.store.transact(f.session.id, 0, (s) => {
            for (let i = 0; i < 6; i++) grantRewards(f.tables, s, [{ itemtype: 1, itemid: 101010, itemnum: 1 }])
        })
        assert.equal(f.state().heroAcquisitionCounts[101010], 7)
        f.fund(501001, 1)
        const result = f.draw(1001).data.gacha_results[0]
        assert.equal(result.extra_item[0].item_num, 50)
        assert.equal(f.state().gacha.hero_counts[101010], 8)
        assert.equal(f.state().heroAcquisitionCounts[101010], 8)
    } finally {
        f.store.close()
    }
})
test('a legacy trial actor is not mistaken for a permanent owned hero during acquisition', () => {
    const f = fixture('gacha-trial-ownership', { rng: () => 0 })
    try {
        f.store.transact(f.session.id, 0, (s) => {
            const h = s.player.heros_info.heros.find((h) => h.conf_id === 101010)
            s.player.heros_info.heros = s.player.heros_info.heros.filter((h) => h.conf_id !== 101010)
            s.player.heros_info.heros.push({
                ...h,
                trail: true,
                guid: ((5n << 56n) | (101010n << 32n) | 777n).toString(),
            })
        })
        f.session.syncCache.clear()
        f.fund(501001, 1)
        const result = f.draw(1001).data.gacha_results[0]
        assert(!result.transform_item)
        const hero = f.state().player.heros_info.heros.find((h) => h.conf_id === 101010 && !h.trail)
        assert(hero)
        assert.equal(BigInt(hero.guid) >> 56n, 1n)
        assert.equal(f.state().heroAcquisitionCounts[101010], 1)
    } finally {
        f.store.close()
    }
})
test('inheritable guarantee groups share counters across pools while each draw total remains independent', () => {
    let raw, poolRows, rules, rawLength, ruleLength, poolLength
    const f = fixture('gacha-inherit', {
        rng: (max) => max - 1,
        prepareTables: (tables) => {
            const wrapped = gachaTables(tables)
            raw = wrapped.get('gacha')
            rules = wrapped.get('gacha_guarantee')
            poolRows = tables.get('gacha_pool')
            poolLength = poolRows.length
            rawLength = raw.length
            ruleLength = rules.length
            const base = raw.find((r) => r.gachaId === 1001)
            raw.push({ ...base, gachaId: 1002, timelimit: 0, guaranteeId: '1101|1103|1104', stepId: 0, upReward: 0 })
            for (const id of [101, 103, 104])
                rules.push({ ...rules.find((r) => r.guaranteeId === id), guaranteeId: id + 1000 })
            poolRows.push({ ...poolRows.find((r) => r.gachaId === 1001), gachaId: 1002 })
        },
    })
    try {
        f.fund(501001, 3)
        const first = f.draw(1001).data
        assert(first.other_pool_infos.some((p) => p.gacha_pool.pool_id === 1002))
        assert.equal(f.pool(1002).pity.find((p) => p.pity_id === 1101).pity_count, 1)
        const second = f.draw(1002).data
        assert.equal(f.pool(1001).pity.find((p) => p.pity_id === 101).pity_count, 2)
        assert.equal(second.pool_info.gacha_pool.pool_draw_count, 1)
        assert.equal(f.pool(1001).gacha_pool.pool_draw_count, 1)
        const retiredState = structuredClone(f.state())
        f.store.transact(
            f.session.id,
            0,
            (s) => (s.gacha.pools[1002].pity.find((p) => p.pity_id === 1101).pity_count = 89),
        )
        const third = f.draw(1002).data
        assert.equal(third.gacha_results[0].main_item.item_id, 101010)
        assert.equal(f.pool(1001).pity.find((p) => p.pity_id === 101).pity_count, 0)
        assert.equal(f.pool(1002).gacha_pool.pool_draw_count, 2)
        assert.equal(f.pool(1001).gacha_pool.pool_draw_count, 1)
        // Synthetic next-table version: neither old banner is configured, but
        // their writer-preserved group metadata remains in the saved account.
        raw.push({
            ...raw.find((r) => r.gachaId === 1001),
            gachaId: 1003,
            timelimit: 0,
            guaranteeId: '2101|2103|2104',
            stepId: 0,
            upReward: 0,
        })
        for (const id of [101, 103, 104])
            rules.push({ ...rules.find((r) => r.guaranteeId === id), guaranteeId: id + 2000 })
        poolRows.push({ ...poolRows.find((r) => r.gachaId === 1001), gachaId: 1003 })
        const wrapped = gachaTables(f.tables),
            catalog = new GachaCatalog(wrapped)
        catalog.pools.delete(1001)
        catalog.pools.delete(1002)
        const engine = new GachaDrawEngine(catalog, wrapped)
        const queried = engine.view(retiredState).find((info) => info.gacha_pool.pool_id === 1003)
        assert.equal(queried.pity.find((p) => p.pity_id === 2101).pity_count, 2)
        assert.equal(queried.gacha_pool.pool_draw_count, 0)
        const continued = engine.draw(
            { state: retiredState, now: 1790000001, randomInt: (max) => max - 1, requestKey: 'retired-source-test' },
            { pool_id: 1003, draw_count: 1 },
        )
        assert.equal(continued.reply.pool_info.pity.find((p) => p.pity_id === 2101).pity_count, 3)
        assert.equal(continued.reply.pool_info.gacha_pool.pool_draw_count, 1)
        assert.equal(retiredState.gacha.pools[1001].gacha_pool.pool_draw_count, 1)
        assert.equal(retiredState.gacha.pools[1002].gacha_pool.pool_draw_count, 1)
    } finally {
        raw.splice(rawLength)
        rules.splice(ruleLength)
        poolRows.splice(poolLength)
        f.store.close()
    }
})
