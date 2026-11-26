import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables, seedPlayer } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { preparedSystemAccess } from '../src/system-access.js'
import { requireHomeWishlistAccess } from '../src/home-wishlist.js'
import { newStarterProfile } from '../src/starter-profile.js'
import { homeCondition } from '../src/home-grid.js'
import { ErrorCode } from '../src/error-codes.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base),
    request = { uid: 710000, product_id: 710000, count: 2, selects: [], trace: false }
function fixture(name, mode = 'legacy') {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => 1800000000 }),
        account = 'system-access-' + name
    store.login(account, (id, openId) => {
        const s = seedPlayer(tables, id, openId)
        if (mode === 'legacy') delete s.starterProfile
        else s.starterProfile = newStarterProfile(mode)
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
    assert.equal(state().mall?.popupQueue?.length ?? 0, 0)
    assert.equal(state().mall?.pendingPopup, undefined)
    call('GetRechargePopupData')
    return {
        store,
        game,
        frame,
        dispatch,
        call,
        state,
        initial,
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
function unchanged(f, fn, code) {
    const before = f.raw()
    assert.throws(fn, (e) => e.code === code)
    assert.deepEqual(f.raw(), before)
}
test('actual legacy5001 UI-open1504 permits canonical6185 without rechecking unearned195, preserving product/selection/quantity guards', () => {
    const f = fixture('legacy')
    try {
        const basic = decode(f.initial.find((p) => p.id === 5001)).data.basic_info
        assert(!(basic.lock_system ?? []).includes(1504))
        assert.equal(preparedSystemAccess(tables, f.state(), 1504), true)
        assert.equal(homeCondition(tables.find('system_unlock', 1504).unlockCondi, f.state()), false)
        const ps = f.call('AddHomeMaterialWishList', request)
        assert(
            ps.findIndex((p) => p.id === 6102) >= 0 &&
                ps.findIndex((p) => p.id === 6102) < ps.findIndex((p) => p.id === 6185),
        )
        assert.deepEqual(
            f.state().home.wishlist.find((r) => r.uid === 710000),
            { ...request, trace: false },
        )
        unchanged(f, () => f.call('AddHomeMaterialWishList', { ...request, uid: 1 }), ErrorCode.InvalidArgument)
        unchanged(
            f,
            () => f.call('AddHomeMaterialWishList', { uid: 99999999, product_id: 99999999, count: 1 }),
            ErrorCode.HomeMaterialWishlistConfInvalid,
        )
        unchanged(
            f,
            () => f.call('AddHomeMaterialWishList', { ...request, count: 100 }),
            ErrorCode.HomeMaterialWishlistNumLimit,
        )
        unchanged(
            f,
            () => f.call('AddHomeMaterialWishList', { ...request, selects: [123] }),
            ErrorCode.ProductSelectMaterialFail,
        )
        f.reconnect()
        assert.equal(f.state().home.wishlist[0].uid, 710000)
    } finally {
        f.store.close()
    }
})
test('normal1504 remains locked until earned; actual notifier removes its bitmap then wishlist stays open after195 facts regress', () => {
    const f = fixture('normal', 'normal')
    try {
        assert.equal(preparedSystemAccess(tables, f.state(), 1504), false)
        unchanged(f, () => f.call('AddHomeMaterialWishList', request), ErrorCode.SystemLock)
        const original = structuredClone(f.state().taskRecords ?? [])
        // Trusted past-completion fact, not a claim to play all106010 story here.
        f.edit((s) => {
            s.taskRecords = [...(s.taskRecords ?? []), { task_id: 106010, count: 1, time: 1 }]
        })
        const ps = f.call('GetRechargePopupData'),
            notices = ps.filter((p) => p.id === 10600).flatMap((p) => decode(p).unlock_id ?? [])
        assert(notices.includes(1504))
        assert.equal(preparedSystemAccess(tables, f.state(), 1504), true)
        f.edit((s) => {
            s.taskRecords = original
        })
        assert.equal(homeCondition(tables.find('system_unlock', 1504).unlockCondi, f.state()), false)
        assert.equal(preparedSystemAccess(tables, f.state(), 1504), true)
        f.call('AddHomeMaterialWishList', request)
        assert.equal(f.state().home.wishlist[0].product_id, 710000)
        assert(!f.call('GetRechargePopupData').some((p) => p.id === 10600))
    } finally {
        f.store.close()
    }
})
test('undefined prepared ledger is unknown, retains original qualified fallback, and never becomes all-open by missing marker', () => {
    const f = fixture('unprepared')
    try {
        const s = structuredClone(f.state())
        delete s.systemUnlockProgress
        const before = structuredClone(s)
        assert.equal(preparedSystemAccess(tables, s, 1504), undefined)
        assert.throws(
            () => requireHomeWishlistAccess(tables, s),
            (e) => e.code === ErrorCode.SystemLock,
        )
        assert.deepEqual(s, before)
        s.taskRecords = [...(s.taskRecords ?? []), { task_id: 106010, count: 1, time: 1 }]
        const eligible = structuredClone(s)
        requireHomeWishlistAccess(tables, s)
        assert.deepEqual(s, eligible)
        assert.equal(s.systemUnlockProgress, undefined)
    } finally {
        f.store.close()
    }
})
test('null/stale/mode mismatch/bad lock projection reject canonical CRUD atomically instead of falling back to a raw condition', () => {
    const f = fixture('corrupt')
    try {
        const good = structuredClone(f.state())
        for (const alter of [
            (s) => {
                s.systemUnlockProgress = null
            },
            (s) => {
                s.systemUnlockProgress.sourceHash = 'bad'
            },
            (s) => {
                s.player.basic_info.lock_system.push(1504)
            },
            (s) => {
                s.starterProfile = newStarterProfile('normal')
            },
            (s) => {
                s.starterProfile = null
            },
        ]) {
            f.edit((s) => {
                Object.assign(s, structuredClone(good))
                alter(s)
            })
            unchanged(f, () => f.call('AddHomeMaterialWishList', request), ErrorCode.GameConfig)
        }
    } finally {
        f.store.close()
    }
})
test('canonical admission is read-only; real6185 ACK codec and SQL abort roll back wishlist/open state and retry survives login', () => {
    for (const fault of ['codec', 'sql']) {
        const f = fixture(fault)
        try {
            const image = structuredClone(f.state())
            assert.equal(preparedSystemAccess(tables, f.state(), 1504), true)
            assert.deepEqual(f.state(), image)
            const packet = f.frame('AddHomeMaterialWishList', request),
                before = f.raw(),
                encode = protocol.encode
            if (fault === 'codec')
                protocol.encode = function (type, value) {
                    if (type === 'cs.ProtoNullRsp') throw Error('system-access codec failure')
                    return encode.call(this, type, value)
                }
            else
                f.store.db.exec(
                    "CREATE TRIGGER fail_access BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'system-access SQL failure'); END",
                )
            try {
                assert.throws(
                    () => f.dispatch(packet),
                    new RegExp('system-access ' + (fault === 'codec' ? 'codec' : 'SQL') + ' failure'),
                )
            } finally {
                protocol.encode = encode
                if (fault === 'sql') f.store.db.exec('DROP TRIGGER fail_access')
            }
            assert.deepEqual(f.raw(), before)
            f.dispatch(packet)
            f.reconnect()
            assert.equal(f.state().home.wishlist[0].uid, 710000)
        } finally {
            f.store.close()
        }
    }
})
