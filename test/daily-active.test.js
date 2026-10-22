import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Protocol } from '../src/protocol.js'
import { Game } from '../src/game.js'
import { activeCatalogue, activeSnapshot, recordActiveProgress, observeActiveSession } from '../src/daily-active.js'
import { grantRewards } from '../src/rewards.js'
import { ErrorCode } from '../src/error-codes.js'
import { assertSyncBefore } from './exchange-sync-assertions.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables)
function fixture(file = ':memory:', start = 1800000000, source = tables) {
    const store = new Store(file),
        protocol = new Protocol(cfg.base)
    let now = start,
        session = {},
        seq = 1
    const game = new Game(protocol, store, source, { clock: () => now })
    const call = (name, data = {}, who = session) => {
        const e = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(who, { id: e.id, seq: seq++, payload: protocol.encode(e.req, data) })
            .map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    }
    const reload = () => {
        session = {}
        return call('EnterGame', { open_id: 'daily-active' })
    }
    const login = reload()
    store.transact(session.id, 0, (s) => {
        s.tasks = []
        s.taskRecords = source
            .get('task')
            .filter((t) => t.type === 1)
            .map((t) => ({ task_id: t.id, count: 1, time: 1 }))
        s.player.basic_info.lv = 30
        s.player.basic_info.gold = 10000000
    })
    return {
        store,
        protocol,
        game,
        call,
        reload,
        login,
        state: () => store.load(session.id).state,
        edit: (fn) => store.transact(session.id, 0, fn),
        setNow: (n) => {
            now = n
        },
        get now() {
            return now
        },
        get session() {
            return session
        },
        close: () => store.close(),
    }
}
const response = (out) => out.find((p) => p.id === 6600).data
const claim = (f, ids) => f.call('GetActiveReward', { u32s: ids })
const task = (f, id) =>
    activeSnapshot(tables, f.state(), f.now)
        .group_infos.flatMap((g) => g.task_infos)
        .find((t) => t.task_id === id)
function failed(f, fn, code) {
    const before = f.state()
    assert.throws(fn, (e) => e.code === code)
    assert.deepEqual(f.state(), before)
}

test('6600 login task grants real active value once and publishes authoritative 6601 before the reply', () => {
    const f = fixture()
    try {
        assert.equal(activeCatalogue(tables).rows.length, 20)
        const login = f.login.find((p) => p.id === 6601).data
        assert.equal(login.group_infos.length, 2)
        assert.deepEqual(task(f, 1), { task_id: 1, task_value: 1, task_status: 1 })
        assert.equal(task(f, 1001).task_value, 1)
        assert.equal(task(f, 6).task_value, 0) // Debug pets and past account contents are not captures.
        const out = claim(f, [1])
        assertSyncBefore(f.protocol, out, 'CSProtoDailyActiveInfoSync', 6600)
        assert.equal(response(out).src, 22)
        assert.deepEqual(response(out).rewards, [])
        assert.equal(f.state().dailyActive.day.active, 20)
        assert.equal(task(f, 1).task_status, 2)
        assert.deepEqual(response(claim(f, [1])).rewards, [])
        f.reload()
        claim(f, [1])
        assert.equal(f.state().dailyActive.day.active, 20)
    } finally {
        f.close()
    }
})

test('6600 validates the whole selected batch before changing claims or active value', () => {
    const f = fixture()
    try {
        failed(f, () => claim(f, []), ErrorCode.InvalidArgument)
        failed(f, () => claim(f, [1, 1]), ErrorCode.InvalidArgument)
        failed(f, () => claim(f, [1, 999999]), ErrorCode.InvalidArgument)
        failed(f, () => claim(f, [1, 3]), ErrorCode.kActiveTaskNotComplete)
        assert.equal(f.state().dailyActive.day.active, 0)
    } finally {
        f.close()
    }
})

test('actual hero/pet experience use progresses only real level transitions and reward pets are not catches', () => {
    const f = fixture()
    try {
        let hero, pet
        f.edit((s) => {
            hero = s.player.heros_info.heros.find((h) => !h.trail && h.type === 0).guid
            const item = Number(String(tables.get('game').find((r) => r.title === 'PET_EXPITEMID').value).split('|')[0])
            grantRewards(tables, s, [
                { itemtype: 3, itemid: 400003, itemnum: 2 },
                { itemtype: 3, itemid: item, itemnum: 10 },
            ])
            pet = grantRewards(tables, s, [{ itemtype: 5, itemid: 500002, itemnum: 1 }])[0].guid
        })
        assert.equal(task(f, 6).task_value, 0)
        const heroOut = f.call('LvUpHero', { hero_id: hero, items: [{ item_id: 400003, item_num: 1 }] })
        assert.equal(task(f, 3).task_status, 1)
        assert.equal(heroOut.filter((p) => p.id === 6602).length, 1)
        const expItem = Number(String(tables.get('game').find((r) => r.title === 'PET_EXPITEMID').value).split('|')[0])
        f.call('LvUpPet', { pet_id: pet, items: [{ item_id: expItem, item_num: 5 }] })
        assert.equal(task(f, 5).task_status, 1)
        claim(f, [1, 3, 5])
        assert.equal(f.state().dailyActive.day.active, 60)
        assert.equal(task(f, 6).task_value, 0)
    } finally {
        f.close()
    }
})

test('daily and weekly periods use UTC+8 configured reset boundaries and distinct observed login days', () => {
    const monday = Date.parse('2026-10-18T20:00:00Z') / 1000
    const f = fixture(':memory:', monday)
    try {
        claim(f, [1])
        for (let i = 1; i <= 4; i++) {
            f.setNow(monday + i * 86400)
            f.reload()
            f.reload()
        }
        assert.equal(task(f, 1001).task_value, 5)
        claim(f, [1001])
        assert.equal(f.state().dailyActive.week.active, 20)
        f.setNow(monday + 6 * 86400 + 86399)
        f.reload()
        const week = f.state().dailyActive.week.key
        assert.equal(f.state().dailyActive.week.active, 20)
        f.setNow(monday + 7 * 86400)
        f.reload()
        assert.notEqual(f.state().dailyActive.week.key, week)
        assert.equal(f.state().dailyActive.week.active, 0)
        assert.equal(task(f, 1001).task_value, 1)
        assert.equal(task(f, 1).task_status, 1)
    } finally {
        f.close()
    }
})

test('an online first claim after daily rollover clears old client chest flags before applying fresh points', () => {
    const monday = Date.parse('2026-10-18T20:00:00Z') / 1000,
        f = fixture(':memory:', monday)
    try {
        claim(f, [1])
        f.edit((s) => {
            s.dailyActive.day.rewardIds = [1]
        })
        f.reload()
        f.setNow(monday + 86400)
        const pushes = claim(f, [1]).filter((p) => p.id === 6601)
        assert.equal(pushes[0].data.group_infos[0].active_value, 0)
        assert.equal(pushes.at(-1).data.group_infos[0].active_value, 20)
        assert.deepEqual(pushes.at(-1).data.group_infos[0].reward_ids, [])
    } finally {
        f.close()
    }
})

test('idle normal ticks reset the calendar once, while unchanged ticks do not write SQLite', () => {
    const monday = Date.parse('2026-10-18T20:00:00Z') / 1000,
        f = fixture(':memory:', monday)
    try {
        claim(f, [1])
        f.setNow(monday + 86400)
        const out = f.game.tick(f.session.id, f.session)
        assert(out.some((p) => p.id === 6601))
        assert.equal(task(f, 1).task_status, 1)
        assert.equal(f.state().dailyActive.day.active, 0)
        assert.equal(task(f, 1001).task_value, 2)
        const changes = f.store.db.prepare('select total_changes() n').get().n
        for (let i = 0; i < 20; i++) f.game.tick(f.session.id, f.session)
        assert.equal(f.store.db.prepare('select total_changes() n').get().n, changes)
        // Arena event clocks have millisecond precision, not integral seconds.
        f.edit((s) => recordActiveProgress(tables, s, 15071, 1, f.now + 0.125))
        assert.equal(task(f, 9).task_status, 1)
    } finally {
        f.close()
    }
})

test('table condition engine preserves every current shape, caps progress and keeps the prior period immutable', () => {
    const f = fixture()
    try {
        const old = f.state(),
            draft = { ...old }
        for (const row of activeCatalogue(tables).rows) recordActiveProgress(tables, draft, row.kind, row.para, f.now)
        const out = activeSnapshot(tables, draft, f.now)
        assert(out.group_infos.flatMap((g) => g.task_infos).every((t) => t.task_status === 1))
        assert.equal(old.dailyActive.day.counts[12002], undefined)
        assert.equal(old.dailyActive.week.counts[13109], undefined)
        recordActiveProgress(tables, draft, 12002, 100000, f.now)
        assert.equal(draft.dailyActive.day.counts[12002], 30)
        // This exercises condition storage, not proof that every gameplay
        // source (notably random chests and unopened dungeon modes) is live.
    } finally {
        f.close()
    }
})

test('6600 reply or pre-ACK status encoding failure rolls back the receipt and points and can be retried', () => {
    for (const name of ['CSProtoGetActiveReward', 'CSProtoDailyActiveInfoSync']) {
        const f = fixture()
        try {
            const old = f.state(),
                encode = f.protocol.encode.bind(f.protocol),
                type = f.protocol.byName.get(name).rsp
            f.protocol.encode = (n, v) => {
                if (n === type) throw Error('injected active codec failure')
                return encode(n, v)
            }
            assert.throws(() => claim(f, [1]), /injected active codec failure/)
            assert.deepEqual(f.state(), old)
            f.protocol.encode = encode
            claim(f, [1])
            claim(f, [1])
            assert.equal(f.state().dailyActive.day.active, 20)
        } finally {
            f.close()
        }
    }
})

test('authoritative enemy deaths count once on the fast memory path and encoding failure cannot leak progress', () => {
    const f = fixture()
    try {
        f.call('EnterWorldMap', { map_id: 100, point_id: 10045 })
        const hero = f.state().player.heros_info.heros[0].guid
        const request = {
            base_time: '1000',
            uint64_dic: [hero, '216172782118283809'],
            battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -100000000 } }],
        }
        const encode = f.protocol.encode.bind(f.protocol),
            type = f.protocol.byName.get('CSProtoDailyActiveInfoSync').rsp
        const before = f.state(),
            changes = f.store.db.prepare('select total_changes() n').get().n
        f.protocol.encode = (n, v) => {
            if (n === type) throw Error('active kill codec failure')
            return encode(n, v)
        }
        assert.throws(() => f.call('BattleInfoReduce', request), /active kill codec failure/)
        assert.deepEqual(f.state(), before)
        f.protocol.encode = encode
        const out = f.call('BattleInfoReduce', request)
        assert(out.some((p) => p.id === 6601))
        assert.equal(task(f, 7).task_value, 1)
        f.call('BattleInfoReduce', request)
        assert.equal(task(f, 7).task_value, 1)
        assert.equal(f.store.db.prepare('select total_changes() n').get().n, changes)
    } finally {
        f.close()
    }
})

test('6600 period state and claimed points survive SQLite close and reopen', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-active-')),
        file = path.join(dir, 'state.sqlite')
    let f, store
    try {
        f = fixture(file)
        claim(f, [1])
        const id = f.session.id,
            before = f.state().dailyActive
        f.close()
        f = undefined
        store = new Store(file)
        assert.deepEqual(store.load(id).state.dailyActive, before)
        const protocol = new Protocol(cfg.base),
            game = new Game(protocol, store, tables, { clock: () => 1800000000 }),
            session = {}
        for (const [name, data] of [
            ['EnterGame', { open_id: 'daily-active' }],
            ['GetActiveReward', { u32s: [1] }],
        ]) {
            const e = protocol.byName.get('CSProto' + name)
            game.dispatch(session, { id: e.id, seq: 1, payload: protocol.encode(e.req, data) })
        }
        assert.equal(store.load(id).state.dailyActive.day.active, 20)
    } finally {
        f?.close()
        store?.close()
        assert.equal(path.dirname(dir), os.tmpdir())
        assert(path.basename(dir).startsWith('lurukaps-active-'))
        fs.rmSync(dir, { recursive: true })
    }
})
