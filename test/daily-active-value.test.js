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
import { recordActiveProgress, activeCatalogue } from '../src/daily-active.js'
import { ErrorCode } from '../src/error-codes.js'
import { assertSyncBefore } from './exchange-sync-assertions.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables)
function fixture(source = tables, file = ':memory:') {
    const protocol = new Protocol(cfg.base),
        store = new Store(file)
    let now = Date.parse('2026-10-18T20:00:00Z') / 1000,
        session = {},
        seq = 1
    const game = new Game(protocol, store, source, { clock: () => now })
    const call = (name, data = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, data) })
            .map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    }
    const reload = () => {
        session = {}
        return call('EnterGame', { open_id: 'active-value' })
    }
    reload()
    store.transact(session.id, 0, (s) => {
        s.tasks = []
        s.taskRecords = source
            .get('task')
            .filter((t) => t.type === 1)
            .map((t) => ({ task_id: t.id, count: 1, time: 1 }))
    })
    const state = () => store.load(session.id).state
    const complete = (type) => {
        const rows = activeCatalogue(source).rows.filter((r) => r.taskType === type)
        // Condition-model fixture only; actual gameplay source integration is
        // tested separately and unresolved source kinds remain documented.
        store.transact(session.id, 0, (s) => {
            for (const r of rows) recordActiveProgress(source, s, r.kind, r.para, now)
        })
        return call('GetActiveReward', { u32s: rows.map((r) => r.id) })
    }
    return {
        store,
        protocol,
        game,
        call,
        reload,
        state,
        complete,
        setNow: (n) => {
            now = n
        },
        get now() {
            return now
        },
        get session() {
            return session
        },
        edit: (fn) => store.transact(session.id, 0, fn),
        close: () => store.close(),
    }
}
const claim = (f, type) => f.call('GetActiveValueReward', { u32: type })
const reply = (out) => out.find((p) => p.id === 6702).data
const wallet = (s, id) =>
    id === 1
        ? s.player.basic_info.diamond
        : id === 2
          ? s.player.basic_info.gold
          : Number(s.player.attr_infos.attrs.find((r) => r.attr_id === id)?.attr_val ?? 0)
const count = (s, id) => s.player.sbag_infos.items.filter((r) => r.itemid === id).reduce((n, r) => n + r.itemnum, 0)
function unchanged(f, fn, code) {
    const before = f.state()
    assert.throws(fn, (e) => e.code === code)
    assert.deepEqual(f.state(), before)
}

test('6702 receives a category, pays every reached unclaimed tier, synchronizes actual rewards and stays once-only', () => {
    const f = fixture()
    try {
        unchanged(f, () => claim(f, 1), ErrorCode.ActiveValueNotEnough)
        f.call('GetActiveReward', { u32s: [1] })
        const before = f.state(),
            first = claim(f, 1),
            result = reply(first)
        assert.equal(result.src, 22)
        assert.equal(wallet(f.state(), 1) - wallet(before, 1), 5)
        assert.equal(count(f.state(), 400001) - count(before, 400001), 1)
        assert.equal(wallet(f.state(), 2) - wallet(before, 2), 1000)
        assertSyncBefore(f.protocol, first, 'CSProtoSyncPlayerData', 6702)
        assertSyncBefore(f.protocol, first, 'CSProtoDailyActiveInfoSync', 6702)
        assert.deepEqual(f.state().dailyActive.day.rewardIds, [1])
        const after = f.state()
        assert.deepEqual(reply(claim(f, 1)).rewards, [])
        assert.equal(wallet(f.state(), 1), wallet(after, 1))
        f.complete(1)
        const remaining = reply(claim(f, 1))
        assert.equal(remaining.rewards.find((r) => r.itemtype === 10 && r.itemid === 1).itemnum, 35)
        assert.deepEqual(f.state().dailyActive.day.rewardIds, [1, 2, 3, 4, 5])
        assert.deepEqual(f.state().dailyActive.week.rewardIds, [])
        f.reload()
        assert.deepEqual(reply(claim(f, 1)).rewards, [])
    } finally {
        f.close()
    }
})

test('weekly rewards use their own IDs and balances and all ten current tiers contain supported actual rewards', () => {
    const f = fixture()
    try {
        f.complete(2)
        const before = f.state(),
            out = claim(f, 2),
            after = f.state(),
            rows = tables.get('activity_reward').filter((r) => r.taskType === 2)
        assert.deepEqual(
            after.dailyActive.week.rewardIds,
            rows.map((r) => r.id),
        )
        assert.deepEqual(after.dailyActive.day.rewardIds, [])
        assert.equal(wallet(after, 411) - wallet(before, 411), 5)
        assert.equal(reply(out).rewards.find((r) => r.itemtype === 10 && r.itemid === 411).itemnum, 5)
        assert.deepEqual(reply(claim(f, 2)).rewards, [])
    } finally {
        f.close()
    }
})

test('invalid categories and inconsistent saved active points/receipts are distinguished from unmet activity', () => {
    const f = fixture()
    try {
        unchanged(f, () => claim(f, 0), ErrorCode.ActiveRewardTypeFail)
        unchanged(f, () => claim(f, 3), ErrorCode.ActiveRewardTypeFail)
        f.edit((s) => {
            s.dailyActive.day.active = 100
        })
        unchanged(f, () => claim(f, 1), ErrorCode.GameConfig)
        f.edit((s) => {
            s.dailyActive.day.active = 0
            s.dailyActive.day.rewardIds = [6]
        })
        unchanged(f, () => claim(f, 1), ErrorCode.GameConfig)
    } finally {
        f.close()
    }
})

test('a malformed later reward or response encoding failure cannot leave earlier tiers paid or marked claimed', () => {
    const source = Object.create(tables)
    source.get = (n) =>
        n === 'activity_reward'
            ? tables.get(n).map((r) => (r.id === 5 ? { ...r, reward: '3#999999999#1' } : r))
            : tables.get(n)
    const broken = fixture(source)
    try {
        broken.complete(1)
        unchanged(broken, () => claim(broken, 1), ErrorCode.GameConfig)
    } finally {
        broken.close()
    }
    for (const name of ['CSProtoGetActiveValueReward', 'CSProtoDailyActiveInfoSync']) {
        const f = fixture()
        try {
            f.complete(1)
            const before = f.state(),
                encode = f.protocol.encode.bind(f.protocol),
                type = f.protocol.byName.get(name).rsp
            f.protocol.encode = (n, v) => {
                if (n === type) throw Error('active value codec failure')
                return encode(n, v)
            }
            assert.throws(() => claim(f, 1), /active value codec failure/)
            assert.deepEqual(f.state(), before)
            f.protocol.encode = encode
            claim(f, 1)
            assert.deepEqual(reply(claim(f, 1)).rewards, [])
        } finally {
            f.close()
        }
    }
})

test('daily reset clears only daily box receipts and the new day can claim the first box again', () => {
    const f = fixture()
    try {
        f.complete(1)
        f.complete(2)
        claim(f, 1)
        claim(f, 2)
        f.setNow(f.now + 86400)
        f.call('GetActiveReward', { u32s: [1] })
        assert.deepEqual(f.state().dailyActive.day.rewardIds, [])
        assert.deepEqual(f.state().dailyActive.week.rewardIds, [6, 7, 8, 9, 10])
        assert.equal(reply(claim(f, 1)).rewards.find((r) => r.itemtype === 10 && r.itemid === 1).itemnum, 5)
        assert.deepEqual(f.state().dailyActive.day.rewardIds, [1])
    } finally {
        f.close()
    }
})

test('missing source metadata remains nonblocking for actual box rewards and claims', () => {
    const source = Object.create(tables)
    source.find = (n, id) => (n === 'reason_itemnum_change' && id === 22 ? undefined : tables.find(n, id))
    const f = fixture(source)
    try {
        f.call('GetActiveReward', { u32s: [1] })
        const before = f.state(),
            result = reply(claim(f, 1))
        assert(result.rewards.length > 0)
        assert.equal(result.src ?? 0, 0)
        assert.equal(wallet(f.state(), 1) - wallet(before, 1), 5)
        assert.deepEqual(f.state().dailyActive.day.rewardIds, [1])
    } finally {
        f.close()
    }
})

test('box receipts and actual inventory survive a real SQLite restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-active-value-')),
        file = path.join(dir, 'state.sqlite')
    let f, reopened
    try {
        f = fixture(tables, file)
        f.complete(1)
        claim(f, 1)
        const id = f.session.id,
            before = f.state()
        f.close()
        f = undefined
        reopened = new Store(file)
        const after = reopened.load(id).state
        assert.deepEqual(after.dailyActive.day.rewardIds, [1, 2, 3, 4, 5])
        assert.equal(wallet(after, 1), wallet(before, 1))
        assert.equal(count(after, 400001), count(before, 400001))
        const protocol = new Protocol(cfg.base),
            session = {}
        const game = new Game(protocol, reopened, tables, { clock: () => Date.parse('2026-10-18T20:00:00Z') / 1000 })
        for (const [name, data] of [
            ['EnterGame', { open_id: 'active-value' }],
            ['GetActiveValueReward', { u32: 1 }],
        ]) {
            const e = protocol.byName.get('CSProto' + name)
            const out = game.dispatch(session, { id: e.id, seq: 1, payload: protocol.encode(e.req, data) })
            if (e.id === 6702)
                assert.deepEqual(protocol.decode(e.rsp, out.find((p) => p.id === e.id).payload).rewards, [])
        }
        assert.equal(wallet(reopened.load(id).state, 1), wallet(before, 1))
    } finally {
        f?.close()
        reopened?.close()
        assert.equal(path.dirname(dir), os.tmpdir())
        assert(path.basename(dir).startsWith('lurukaps-active-value-'))
        fs.rmSync(dir, { recursive: true })
    }
})
