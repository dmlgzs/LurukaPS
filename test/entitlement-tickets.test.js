import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ReplayWindow } from '../src/replay.js'
import { encodeFrame } from '../src/wire.js'
import { ErrorCode } from '../src/error-codes.js'
import { prepareBattlePass } from '../src/battle-pass.js'

const DAY = 86400,
    NOW = 1800000000
function fixture({ file = ':memory:', nextSeason = false } = {}) {
    const config = configuration(),
        tables = new Tables(config.tables),
        protocol = new Protocol(config.base)
    if (nextSeason) {
        // Controlled successor schedule reuses the actual season ID; no completion facts are fabricated.
        tables.get('battle_pass')[0].startTime = '20270101-040000'
        tables.get('battle_pass')[0].endTime = '20290201-035959'
    }
    let now = NOW,
        seq = 1
    const store = new Store(file),
        game = new Game(protocol, store, tables, { clock: () => now }),
        session = {}
    const frame = (name, request = {}, forcedSeq) => {
        const e = protocol.byName.get('CSProto' + name)
        return { id: e.id, seq: forcedSeq ?? seq++, pushSeq: 0, payload: protocol.encode(e.req, request) }
    }
    const call = (name, request = {}, target = session) => game.dispatch(target, frame(name, request))
    const login = () => call('EnterGame', { open_id: 'entitlement-ticket' }, session.id ? {} : session)
    login()
    const state = () => store.load(session.id).state
    const edit = (fn) => store.transact(session.id, 0, fn)
    // Legitimate existing account precondition: this main-story step was completed.
    edit((s) => {
        s.taskRecords = [...(s.taskRecords ?? []).filter((r) => r.task_id !== 106010), { task_id: 106010, count: 1 }]
    })
    const constant = (key) => Number(tables.get('mall_game').find((r) => r.title === key).value)
    const ids = {
        monthly: constant('MONTHLY_CARD_EXCHANGE_ITEM_ID'),
        advanced: constant('BATTLEPASS_ADV_EXCHANGE_ITEM_ID'),
        luxury: constant('BATTLEPASS_LUXURY_EXCHANGE_ITEM_ID'),
    }
    const stock = (mode, count = 1, deadtime = 0) =>
        edit((s) => {
            s.player.sbag_infos.items = [{ itemid: ids[mode], itemnum: count, deadtime }]
        })
    const use = (mode) => call('UseItem', { itemid: ids[mode], num: 1 })
    const decode = (packets, id) => {
        const p = packets.find((p) => p.id === id)
        assert(p, 'Missing packet ' + id)
        return protocol.decode(protocol.byId.get(id).rsp, p.payload)
    }
    return {
        tables,
        protocol,
        store,
        game,
        session,
        frame,
        call,
        login,
        state,
        edit,
        constant,
        ids,
        stock,
        use,
        decode,
        setTime: (t) => {
            now = t
        },
        now: () => now,
    }
}
const quantity = (s, id) =>
    s.player.sbag_infos.items.filter((r) => r.itemid === id).reduce((sum, r) => sum + r.itemnum, 0)
const currency = (s, id) => Number(s.player.attr_infos.attrs.find((r) => r.attr_id === id)?.attr_val ?? 0)
const orders = (s) => ({
    local: s.mall?.localOrders,
    recharge: s.mall?.recharges,
    purchases: s.mall?.purchases,
    premium: Object.fromEntries(
        Object.entries(s.battlePass?.seasons ?? {}).map(([key, value]) => [key, value.premiumOrders]),
    ),
})
const counters = (f) => f.store.db.prepare('SELECT * FROM sequences ORDER BY name').all()
function rejects(f, name, req, code) {
    const before = f.store.load(f.session.id),
        initial = counters(f),
        saved = f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id)
    assert.throws(
        () => f.call(name, req),
        (e) => e.code === code,
    )
    assert.deepEqual(f.store.load(f.session.id), before)
    assert.deepEqual(counters(f), initial)
    assert.deepEqual(
        f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
        saved,
    )
}
const paid = (f, id, nonce) =>
    f.call('NonMallCreatePayOrder', {
        purchase_sdk_id: id,
        buy_count: 1,
        product_id: 'lurukaps-offline:' + nonce + ':previous-real-order',
        amount: '0',
    })

test('all three actual6030 ticket families consume owned stock, sync entitlement before empty ACK, and present one FIFO receipt without payment provenance', () => {
    for (const mode of ['monthly', 'advanced', 'luxury']) {
        const f = fixture()
        try {
            f.stock(mode)
            const before = f.state(),
                provenance = orders(before),
                packets = f.use(mode),
                s = f.state()
            assert.equal(quantity(s, f.ids[mode]), 0)
            assert.deepEqual(f.decode(packets, 6030).rewards, [])
            const status = mode === 'monthly' ? 18020 : 18005
            assert(packets.findIndex((p) => p.id === status) < packets.findIndex((p) => p.id === 6030))
            const playerIndex = packets.findIndex((p) => p.id === f.protocol.byName.get('CSProtoSyncPlayerData').id)
            assert(playerIndex >= 0 && playerIndex < packets.findIndex((p) => p.id === 6030))
            assert(packets.findIndex((p) => p.id === 6030) < packets.findIndex((p) => p.id === 18048))
            assert.equal(packets.filter((p) => p.id === 18048).length, 1)
            const popup = f.decode(packets, 18048)
            assert.equal(popup.pay_source, 0)
            assert.equal(s.entitlementTickets.receipts.length, 1)
            assert.equal(s.entitlementTickets.receipts[0].item_id, f.ids[mode])
            assert.equal(s.entitlementTickets.receipts[0].receipt_id, popup.popup_id)
            assert.deepEqual(orders(s), provenance)
            assert.equal(f.store.db.prepare("SELECT value FROM sequences WHERE name='offline-order'").get(), undefined)
            if (mode === 'monthly') {
                assert.equal(s.monthlyCard.end_time, NOW + 30 * DAY)
                assert.equal(currency(s, 901) - currency(before, 901), 300)
                assert.equal(currency(s, 902), currency(before, 902), 'Ticket never grants SDK repeat-purchase bonus')
                assert.equal(popup.monthly_card_data.rewards.rewards[0].itemnum, 300)
            } else {
                const p = prepareBattlePass(f.tables, s, NOW)
                assert.equal(p.ledger.pay_state, mode === 'advanced' ? 1 : 2)
                assert.equal(p.ledger.level, mode === 'advanced' ? 1 : 11)
                assert.equal(s.player.basic_info.diamond - before.player.basic_info.diamond, 680)
                assert.deepEqual(p.ledger.paid, [])
                assert.equal(p.ledger.premiumOrders, undefined)
                assert.equal(popup.battlepass_data.rewards.rewards.find((r) => r.itemid === 1).itemnum, 680)
            }
            assert.equal(f.decode(f.call('GetRechargePopupData'), 18048).popup_id, 0)
            assert.equal(f.decode(f.call('GetRechargePopupData'), 18048).popup_id, 0)
        } finally {
            f.store.close()
        }
    }
})

test('cold hot and expired monthly tickets use the real pre-use0/60/61-day boundary and preserve the claimed day', () => {
    for (const days of [0, 60, 61]) {
        const f = fixture()
        try {
            f.stock('monthly')
            if (days)
                f.edit((s) => {
                    s.monthlyCard = {
                        config_id: 5001,
                        purchase_sdk_id: 5001,
                        end_time: NOW + days * DAY,
                        claim_until: NOW + 1000,
                    }
                })
            if (days === 61) {
                rejects(f, 'UseItem', { itemid: f.ids.monthly, num: 1 }, ErrorCode.MonthlyCardMaxLimit)
                continue
            }
            const packets = f.use('monthly'),
                s = f.state()
            assert.equal(s.monthlyCard.end_time, NOW + (days + 30) * DAY)
            assert.equal(s.monthlyCard.claim_until, days ? NOW + 1000 : 0)
            assert.equal(f.decode(packets, 18020).is_first, !days)
        } finally {
            f.store.close()
        }
    }
    const f = fixture()
    try {
        f.stock('monthly', 2)
        f.edit((s) => {
            s.monthlyCard = { config_id: 1, purchase_sdk_id: 5001, end_time: NOW - DAY, claim_until: 0 }
        })
        f.use('monthly')
        assert.equal(f.state().monthlyCard.end_time, NOW + 30 * DAY)
        assert(f.decode(f.call('MonthlyCardReward'), 18021).rewards.length > 0)
        const claimed = f.state().monthlyCard.claim_until,
            diamond = f.state().player.basic_info.diamond
        f.use('monthly')
        assert.equal(f.state().monthlyCard.claim_until, claimed)
        assert.deepEqual(f.decode(f.call('MonthlyCardReward'), 18021).rewards, [])
        assert.equal(f.state().player.basic_info.diamond, diamond)
        f.setTime(claimed)
        assert(f.decode(f.call('MonthlyCardReward'), 18021).rewards.length > 0)
        assert.equal(f.state().player.basic_info.diamond, diamond + 90)
    } finally {
        f.store.close()
    }
})

test('single-use arguments system locks expired stock and shared6038 ticket batches reject without consuming any source', () => {
    const f = fixture()
    try {
        f.stock('monthly', 3)
        rejects(f, 'UseItem', { itemid: f.ids.monthly, num: 0 }, ErrorCode.UseItemSendNumZero)
        rejects(f, 'UseItem', { itemid: f.ids.monthly, num: 2 }, ErrorCode.UseItemArgFail)
        rejects(f, 'UseItem', { itemid: f.ids.monthly, num: 1, args: ['1'] }, ErrorCode.UseItemArgFail)
        rejects(f, 'BatchUseItem', { items: [{ itemid: f.ids.monthly, num: 1 }] }, ErrorCode.FunctionClosed)
        f.stock('monthly', 1, NOW)
        rejects(f, 'UseItem', { itemid: f.ids.monthly, num: 1 }, ErrorCode.ItemNotEnough)
        f.stock('monthly')
        f.edit((s) => {
            s.taskRecords = []
            for (const t of s.tasks ?? [])
                if (t.task_id === 106010) t.finish_nodes = (t.finish_nodes ?? []).filter((n) => n !== 78)
        })
        rejects(f, 'UseItem', { itemid: f.ids.monthly, num: 1 }, ErrorCode.MonthlyCardSysLock)
        f.stock('advanced')
        rejects(f, 'UseItem', { itemid: f.ids.advanced, num: 1 }, ErrorCode.SystemLock)
    } finally {
        f.store.close()
    }
})

test('both battle-pass tickets reject already-owned tiers refunds and the exact close boundary; luxury caps level and preserves prior claims', () => {
    const f = fixture()
    try {
        for (const mode of ['advanced', 'luxury'])
            for (const state of [1, 2]) {
                f.stock(mode)
                f.edit((s) => {
                    const p = prepareBattlePass(f.tables, s, NOW)
                    p.ledger.pay_state = state
                    p.ledger.is_refund = false
                })
                rejects(f, 'UseItem', { itemid: f.ids[mode], num: 1 }, ErrorCode.BattlePassAlreadyPaid)
            }
        f.edit((s) => {
            const p = prepareBattlePass(f.tables, s, NOW)
            p.ledger.pay_state = 0
            p.ledger.is_refund = true
        })
        rejects(f, 'UseItem', { itemid: f.ids.luxury, num: 1 }, ErrorCode.BattlePassRefund)
        f.edit((s) => {
            const p = prepareBattlePass(f.tables, s, NOW)
            p.ledger.is_refund = false
            p.ledger.level = 65
        })
        f.call('BattlePassGetLevelReward', { level: 1, is_paid: false })
        const before = prepareBattlePass(f.tables, f.state(), NOW).ledger
        const packets = f.use('luxury'),
            after = prepareBattlePass(f.tables, f.state(), NOW).ledger
        assert.equal(after.level, 70)
        assert.equal(f.decode(packets, 18008).up_level, 5)
        assert.deepEqual(after.free, before.free)
        assert.deepEqual(after.paid, before.paid)
        assert.deepEqual(after.tasks, before.tasks)
    } finally {
        f.store.close()
    }
    const closed = fixture()
    try {
        closed.stock('advanced')
        const p = prepareBattlePass(closed.tables, closed.state(), NOW)
        closed.setTime(p.season.effectiveEnd)
        rejects(closed, 'UseItem', { itemid: closed.ids.advanced, num: 1 }, ErrorCode.BattlePassNotFond)
    } finally {
        closed.store.close()
    }
})

test('actual SQLite reopen keeps consumed item receipts and isolates an old refunded season from a controlled successor with the same numeric ID', () => {
    const parent = path.resolve(os.tmpdir()),
        dir = fs.mkdtempSync(path.join(parent, 'entitlement-b340-'))
    let f
    try {
        const file = path.join(dir, 'state.sqlite')
        f = fixture({ file })
        f.stock('advanced')
        f.use('advanced')
        const oldKey = f.state().battlePass.activeKey
        f.edit((s) => {
            s.battlePass.seasons[oldKey].is_refund = true
        })
        f.store.close()
        f = fixture({ file, nextSeason: true })
        assert.equal(f.state().entitlementTickets.receipts.length, 1)
        assert.equal(f.state().entitlementTickets.receipts[0].season_key, oldKey)
        const p = prepareBattlePass(f.tables, f.state(), NOW)
        assert.notEqual(p.key, oldKey)
        assert.equal(p.ledger.pay_state, 0)
        f.stock('luxury')
        f.use('luxury')
        assert.equal(f.state().battlePass.seasons[oldKey].is_refund, true)
        assert.equal(f.state().battlePass.seasons[oldKey].pay_state, 1)
        assert.equal(f.state().entitlementTickets.receipts.length, 2)
        assert.deepEqual(
            f.state().entitlementTickets.receipts.map((r) => r.mode),
            ['advanced', 'luxury'],
        )
        assert.equal(f.state().battlePass.seasons[p.key].premiumOrders, undefined)
    } finally {
        f?.store.close()
        const resolved = path.resolve(dir)
        assert.equal(path.dirname(resolved), parent)
        assert(path.basename(resolved).startsWith('entitlement-b340-'))
        fs.rmSync(resolved, { recursive: true, force: true })
    }
})

test('same-connection ReplayWindow returns cached frames without reapplying; a fresh accepted monthly use consumes the next ticket', () => {
    const f = fixture(),
        replay = new ReplayWindow()
    try {
        f.stock('monthly', 2)
        const frame = f.frame('UseItem', { itemid: f.ids.monthly, num: 1 }, 200)
        const send = (request) => {
            const cached = replay.find(request)
            if (cached) return cached
            const packets = f.game.dispatch(f.session, request),
                buffers = packets.map((p) => encodeFrame(p, p.payload))
            replay.save(request, buffers)
            return buffers
        }
        const first = send(frame),
            before = f.store.load(f.session.id),
            counter = counters(f)
        assert.deepEqual(send(frame), first)
        assert.deepEqual(f.store.load(f.session.id), before)
        assert.deepEqual(counters(f), counter)
        replay.invalidate()
        assert.throws(() => send(frame), /outside replay window/)
        assert.deepEqual(f.store.load(f.session.id), before)
        send({ ...frame, seq: 201 })
        assert.equal(f.state().monthlyCard.end_time, NOW + 60 * DAY)
        assert.equal(f.state().entitlementTickets.receipts.length, 2)
        assert.equal(quantity(f.state(), f.ids.monthly), 0)
    } finally {
        f.store.close()
    }
})

test('monthly SQLite reopen retains the claimed day and consumed receipt; a new-connection new-sequence use is a new legitimate consumption', () => {
    const parent = path.resolve(os.tmpdir()),
        dir = fs.mkdtempSync(path.join(parent, 'monthly-ticket-b340-'))
    let f
    try {
        const file = path.join(dir, 'state.sqlite')
        f = fixture({ file })
        f.stock('monthly', 2)
        f.use('monthly')
        f.call('MonthlyCardReward')
        const before = f.state(),
            receipt = structuredClone(before.entitlementTickets.receipts[0])
        const claimed = before.monthlyCard.claim_until,
            diamond = before.player.basic_info.diamond
        f.store.close()
        f = fixture({ file })
        assert.equal(f.state().monthlyCard.end_time, NOW + 30 * DAY)
        assert.equal(f.state().monthlyCard.claim_until, claimed)
        assert.deepEqual(f.state().entitlementTickets.receipts, [receipt])
        assert.equal(currency(f.state(), 901), currency(before, 901))
        assert.deepEqual(f.decode(f.call('MonthlyCardReward'), 18021).rewards, [])
        assert.equal(f.state().player.basic_info.diamond, diamond)
        f.use('monthly')
        assert.equal(f.state().monthlyCard.end_time, NOW + 60 * DAY)
        assert.equal(f.state().monthlyCard.claim_until, claimed)
        assert.equal(f.state().entitlementTickets.receipts.length, 2)
        assert.equal(quantity(f.state(), f.ids.monthly), 0)
        assert.deepEqual(orders(f.state()), orders(before))
    } finally {
        f?.store.close()
        const resolved = path.resolve(dir)
        assert.equal(path.dirname(resolved), parent)
        assert(path.basename(resolved).startsWith('monthly-ticket-b340-'))
        fs.rmSync(resolved, { recursive: true, force: true })
    }
})

test('ticket and real paid presentation receipts share one identity domain and FIFO under concurrent follow-up query chains', () => {
    const f = fixture()
    try {
        const one = f.decode(paid(f, 2001, 'ticket-fifo-paid1'), 18048),
            two = f.decode(paid(f, 2002, 'ticket-fifo-paid2'), 18048)
        // Controlled legacy pending-presentation save: these payloads came from
        // real fulfilled paid orders; their wallet rewards are never granted again.
        f.edit((s) => {
            s.mall.popupQueue = [one, two]
        })
        const original = orders(f.state()),
            wallet = currency(f.state(), 901)
        f.stock('monthly')
        const packets = f.use('monthly'),
            shown = [f.decode(packets, 18048).popup_id],
            queries = ['monthly-ACK', 'active18048']
        while (queries.length) {
            queries.shift()
            const data = f.decode(f.call('GetRechargePopupData'), 18048)
            if (data.monthly_card_data || data.recharge_diamond) {
                shown.push(data.popup_id)
                queries.push('consumer-next')
            }
            assert(queries.length < 5)
        }
        assert.deepEqual(shown.slice(0, 2), [one.popup_id, two.popup_id])
        assert.equal(new Set(shown).size, 3)
        assert.equal(shown.at(-1), f.state().entitlementTickets.receipts[0].receipt_id)
        assert.equal(f.state().mall.popupQueue.length, 0)
        assert.deepEqual(orders(f.state()), original)
        assert.equal(currency(f.state(), 901), wallet + 300)
    } finally {
        f.store.close()
    }
})

test('every family rolls back stock benefit source receipt FIFO and presentation sequence on codec and late SQLite failure', () => {
    for (const mode of ['monthly', 'advanced', 'luxury']) {
        const f = fixture(),
            encode = f.protocol.encode
        try {
            f.stock(mode)
            const before = f.store.load(f.session.id),
                counter = counters(f),
                saved = () =>
                    f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
                sql = saved()
            const unchanged = () => {
                assert.deepEqual(f.store.load(f.session.id), before)
                assert.deepEqual(counters(f), counter)
                assert.deepEqual(saved(), sql)
            }
            for (const id of [
                f.protocol.byName.get('CSProtoSyncPlayerData').id,
                mode === 'monthly' ? 18020 : 18005,
                6030,
                18048,
            ]) {
                const type = f.protocol.byId.get(id).rsp
                f.protocol.encode = function (name, ...args) {
                    if (name === type) throw Error('ticket-codec-' + id)
                    return encode.call(this, name, ...args)
                }
                assert.throws(() => f.use(mode), /ticket-codec/)
                unchanged()
                f.protocol.encode = encode
            }
            f.store.db.exec(
                "CREATE TEMP TRIGGER ticket_fail BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'ticket-sql'); END",
            )
            assert.throws(() => f.use(mode), /ticket-sql/)
            unchanged()
            f.store.db.exec('DROP TRIGGER ticket_fail')
            f.use(mode)
            assert.equal(f.state().entitlementTickets.receipts.length, 1)
        } finally {
            f.protocol.encode = encode
            f.store.close()
        }
    }
})

test('bad entitlement configuration managed receipts and exhausted shared presentation identity reject atomically', () => {
    const f = fixture()
    try {
        f.stock('monthly')
        const row = f.tables.get('mall_game').find((r) => r.title === 'MONTHLY_CARD_EXCHANGE_ITEM_ID'),
            old = row.value
        row.value = '0'
        rejects(f, 'UseItem', { itemid: f.ids.monthly, num: 1 }, ErrorCode.GameConfig)
        row.value = old
        const month = f.tables.find('monthly_card', 5001),
            oldDay = month.day
        month.day = 0
        rejects(f, 'UseItem', { itemid: f.ids.monthly, num: 1 }, ErrorCode.GameConfig)
        month.day = oldDay
        f.edit((s) => {
            s.entitlementTickets = { version: 2, receipts: [] }
        })
        rejects(f, 'UseItem', { itemid: f.ids.monthly, num: 1 }, ErrorCode.GameConfig)
        f.edit((s) => {
            delete s.entitlementTickets
        })
        f.store.db.prepare('INSERT INTO sequences(name,value) VALUES(?,?)').run('offline-popup', 0xffffffff)
        rejects(f, 'UseItem', { itemid: f.ids.monthly, num: 1 }, ErrorCode.GameConfig)
    } finally {
        f.store.close()
    }
})
