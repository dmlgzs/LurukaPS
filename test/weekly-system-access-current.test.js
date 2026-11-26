import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables, seedPlayer } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { preparedSystemAccess } from '../src/system-access.js'
import { weeklyDungeonUnlocked, requireWeeklySystem } from '../src/weekly-dungeons.js'
import { ErrorCode } from '../src/error-codes.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
function fixture(name, { mode = 'legacy', level = 10 } = {}) {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => 1800000000 }),
        account = 'weekly-system-' + name
    store.login(account, (id, openId) => {
        // A synthetic historical account may retain its explicitly sandbox-born
        // assets; deleting only this marker is never a production new-account rule.
        const s = seedPlayer(tables, id, openId, { mode: mode === 'legacy' ? 'sandbox' : mode })
        if (mode === 'legacy') delete s.starterProfile
        s.player.basic_info.lv = level
        const row = s.player.attr_infos.attrs.find((a) => a.attr_id === 104)
        if (row) row.attr_val = '0'
        else s.player.attr_infos.attrs.push({ attr_id: 104, attr_val: '0' })
        return s
    })
    let session = {},
        seq = 1
    const frame = (name, r = {}) => {
            const e = protocol.byName.get('CSProto' + name)
            return { id: e.id, seq: seq++, payload: protocol.encode(e.req, r) }
        },
        dispatch = (f) => game.dispatch(session, f),
        call = (n, r) => dispatch(frame(n, r)),
        state = () => store.load(session.id).state
    const initial = call('EnterGame', { open_id: account })
    if (!state().characterCustomized)
        call('PlayerCustomData', { name: Buffer.from('周本考察').toString('base64'), wardrobe_info: { sex: 2 } })
    assert.equal(state().mall?.popupQueue?.length ?? 0, 0)
    assert.equal(state().mall?.pendingPopup, undefined)
    call('GetRechargePopupData', {})
    return {
        store,
        game,
        call,
        state,
        initial,
        frame,
        dispatch,
        enter: (id = 101) =>
            call('MultiCampaignCreate', { dungeon_id: tables.find('dungeon_weekly', id).dungeonId, scene_type: 12 }),
        edit: (fn) => store.transact(session.id, 0, fn),
        raw: () => ({
            state: state(),
            sql: store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(session.id),
        }),
        reconnect: () => {
            session = {}
            return call('EnterGame', { open_id: account, reconnect: true })
        },
    }
}
const decode = (p) => protocol.decode(protocol.byId.get(p.id).rsp, p.payload)
const quota = (s) => s.player.attr_infos.attrs.find((a) => a.attr_id === 104).attr_val
const protectedFail = (f, fn, code) => {
    const before = f.raw()
    assert.throws(fn, (e) => e.code === code)
    assert.deepEqual(f.raw(), before)
}
test('actual legacy UI-open1735 permits legitimate101 level10 entry with zero quota without unearned raw menu history', () => {
    const f = fixture('legacy')
    try {
        const basic = decode(f.initial.find((p) => p.id === 5001)).data.basic_info
        assert(!(basic.lock_system ?? []).includes(1735))
        assert.equal(preparedSystemAccess(tables, f.state(), 1735), true)
        assert.equal(weeklyDungeonUnlocked(tables.find('dungeon_weekly', 101).taskUnlock, f.state()), true)
        assert(!(f.state().taskRecords ?? []).some((r) => r.task_id === 106013 && r.count > 0))
        assert.equal(f.state().entrust?.records?.[8]?.entrust_star ?? 0, 0)
        const before = quota(f.state()),
            ps = f.enter()
        assert(ps.some((p) => p.id === 9513) && ps.some((p) => p.id === 9103))
        assert.equal(f.state().entrust.run.entrust_id, 101)
        assert.equal(f.state().entrust.run.kind, 'weekly')
        assert.equal(quota(f.state()), before)
    } finally {
        f.store.close()
    }
})
test('normal1735 remains unearned until both real configured task/star facts; actual10600 opens once and a later fact rewind cannot relock the menu', () => {
    const f = fixture('normal', { mode: 'normal' })
    try {
        assert.equal(preparedSystemAccess(tables, f.state(), 1735), false)
        protectedFail(f, () => f.enter(), ErrorCode.SystemLock)
        const original = structuredClone({ taskRecords: f.state().taskRecords, records: f.state().entrust?.records })
        // Explicit trusted checkpoint facts; do not claim to play those prior stories
        // or award a commission victory/reward through this fixture.
        f.edit((s) => {
            s.taskRecords = [...(s.taskRecords ?? []), { task_id: 106013, count: 1, time: 1 }]
        })
        assert(
            !f
                .call('GetRechargePopupData', {})
                .filter((p) => p.id === 10600)
                .flatMap((p) => decode(p).unlock_id ?? [])
                .includes(1735),
        )
        f.edit((s) => {
            s.entrust ??= { records: {}, starRewards: {}, nextInstanceId: 1 }
            s.entrust.records[8] = { entrust_id: 8, entrust_star: 1, success_time: '1' }
        })
        const ps = f.call('GetRechargePopupData', {})
        assert(
            ps
                .filter((p) => p.id === 10600)
                .flatMap((p) => decode(p).unlock_id ?? [])
                .includes(1735),
        )
        f.edit((s) => {
            if (original.taskRecords === undefined) delete s.taskRecords
            else s.taskRecords = original.taskRecords
            s.entrust.records = original.records ?? {}
        })
        assert.equal(preparedSystemAccess(tables, f.state(), 1735), true)
        f.enter()
        assert.equal(f.state().entrust.run.kind, 'weekly')
    } finally {
        f.store.close()
    }
})
test('menu openness never bypasses independent weekly difficulty level or prior-star prerequisites', () => {
    const f = fixture('own-rules')
    try {
        assert.equal(preparedSystemAccess(tables, f.state(), 1735), true)
        protectedFail(f, () => f.enter(102), ErrorCode.EntrustUnlock)
        f.edit((s) => {
            s.player.basic_info.lv = 20
        })
        assert.equal(f.state().weeklyDungeonRecords?.[101], undefined)
        protectedFail(f, () => f.enter(102), ErrorCode.EntrustUnlock)
    } finally {
        f.store.close()
    }
})
test('null/stale/bad projection remain strict; no-ledger fallback uses original menu conditions without creating authority', () => {
    const f = fixture('strict')
    try {
        const good = f.state(),
            restore = () =>
                f.edit((s) => {
                    for (const k of Object.keys(s)) delete s[k]
                    Object.assign(s, structuredClone(good))
                })
        for (const mutate of [
            (s) => {
                s.systemUnlockProgress = null
            },
            (s) => {
                s.systemUnlockProgress.sourceHash = 'bad'
            },
            (s) => {
                s.player.basic_info.lock_system.push(1735)
            },
        ]) {
            restore()
            f.edit(mutate)
            protectedFail(f, () => f.enter(), ErrorCode.GameConfig)
        }
        restore()
        const unprepared = structuredClone(f.state())
        delete unprepared.systemUnlockProgress
        const c = { tables, state: unprepared, activityCatalog: f.game.activities },
            before = structuredClone(unprepared)
        assert.throws(
            () => requireWeeklySystem(c),
            (e) => e.code === ErrorCode.SystemLock,
        )
        assert.deepEqual(unprepared, before)
        unprepared.taskRecords = [...(unprepared.taskRecords ?? []), { task_id: 106013, count: 1, time: 1 }]
        unprepared.entrust ??= { records: {}, starRewards: {}, nextInstanceId: 1 }
        unprepared.entrust.records[8] = { entrust_id: 8, entrust_star: 1 }
        const eligible = structuredClone(unprepared)
        requireWeeklySystem(c)
        assert.deepEqual(unprepared, eligible)
        assert.equal(unprepared.systemUnlockProgress, undefined)
        const hidden = {
            get: (name) => tables.get(name),
            find: (name, id) => {
                const r = tables.find(name, id)
                return name === 'dungeon_entrust_type' && id === 6 ? { ...r, ifShow: 0 } : r
            },
        }
        assert.throws(
            () => requireWeeklySystem({ tables: hidden, state: good, activityCatalog: f.game.activities }),
            (e) => e.code === ErrorCode.FunctionClosed,
        )
    } finally {
        f.store.close()
    }
})
test('real9510 scene-push codec and SQL failures preserve menu/run/map/quota then retry and cold login reuse one run', () => {
    for (const fault of ['codec', 'sql']) {
        const f = fixture(fault)
        try {
            const packet = f.frame('MultiCampaignCreate', { dungeon_id: 35750, scene_type: 12 }),
                before = f.raw(),
                encode = protocol.encode
            if (fault === 'codec')
                protocol.encode = function (type, value) {
                    if (type === protocol.byId.get(9103).rsp) throw Error('weekly menu codec failure')
                    return encode.call(this, type, value)
                }
            else
                f.store.db.exec(
                    "CREATE TRIGGER fail_weekly_menu BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'weekly menu SQL failure'); END",
                )
            try {
                assert.throws(
                    () => f.dispatch(packet),
                    new RegExp('weekly menu ' + (fault === 'codec' ? 'codec' : 'SQL') + ' failure'),
                )
            } finally {
                protocol.encode = encode
                if (fault === 'sql') f.store.db.exec('DROP TRIGGER fail_weekly_menu')
            }
            assert.deepEqual(f.raw(), before)
            f.dispatch(packet)
            const instance = f.state().entrust.run.instance_id,
                balance = quota(f.state())
            f.reconnect()
            assert.equal(f.state().entrust.run.instance_id, instance)
            assert.equal(quota(f.state()), balance)
        } finally {
            f.store.close()
        }
    }
})
