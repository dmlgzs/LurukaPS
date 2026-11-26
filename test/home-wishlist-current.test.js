import { newStarterProfile } from '../src/starter-profile.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { configuration } from '../src/config.js'
import { Tables, seedPlayer } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ensureHome } from '../src/home.js'
import { productionMaterials } from '../src/production-materials.js'
import { ErrorCode } from '../src/error-codes.js'
import { TaskGraphs } from '../src/tasks.js'
import { homeCondition } from '../src/home-grid.js'
import {
    bootstrapHomeWishlistIdentity,
    homeWishlistPresentation,
    validateWishlistSelections,
} from '../src/home-wishlist.js'
import oldWriter from './fixtures/legacy-home-wishlist-writer.json' with { type: 'json' }

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    productId = 710000
const digest = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
const native = (count = 2) => ({ uid: productId, product_id: productId, count, trace: false, selects: [] })
function baseline(name, setup, qualified = true) {
    const s = seedPlayer(tables, 1, name)
    if (!qualified) s.starterProfile = newStarterProfile('normal')
    // Trusted independent post-main-task checkpoint, not an assertion that
    // these tests play the preceding story or earn a wishlist completion.
    if (qualified) {
        const system = tables.find('system_unlock', 1504),
            [kind, taskId, nodeId] = system.unlockCondi.split('#').map(Number)
        assert.equal(kind, 12045)
        assert(new TaskGraphs(tables).get(taskId).nodes.has(nodeId))
        const completed = new Set(),
            levels = []
        const visit = (id) => {
            if (completed.has(id)) return
            completed.add(id)
            const row = tables.find('task', id)
            assert(row)
            for (const part of String(row.unlockcondition).split('|').filter(Boolean)) {
                const [condition, target] = part.split('#').map(Number)
                if (condition === 2007 || condition === 12045) visit(target)
                else if (condition === 2004) levels.push(target)
                else assert.fail('Unmodeled wishlist prerequisite ' + part)
            }
        }
        visit(taskId)
        s.tasks = []
        s.taskRecords = [...completed].map((task_id) => ({ task_id, count: 1, time: 1 }))
        s.player.basic_info.lv = Math.max(s.player.basic_info.lv, ...levels)
        assert(homeCondition(system.unlockCondi, s), 'Current wishlist1504 UI prerequisite must be qualified')
    }
    ensureHome(tables, s)
    setup?.(s)
    return s
}
function fixture(name, setup, qualified = true) {
    const protocol = new Protocol(cfg.base),
        store = new Store(':memory:'),
        account = store.login(name, () => baseline(name, setup, qualified)),
        game = new Game(protocol, store, tables, { clock: () => 1800000000 })
    let session = {},
        seq = 1
    const call = (name, value = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, {
            id: e.id,
            seq: seq++,
            payload: e.req ? protocol.encode(e.req, value) : Buffer.alloc(0),
        })
    }
    return {
        protocol,
        store,
        game,
        call,
        state: () => store.load(account.id).state,
        edit: (fn) => store.transact(account.id, 0, fn),
        login: () => call('EnterGame', { open_id: name }),
        reconnect: () => {
            session = {}
            return call('EnterGame', { open_id: name, reconnect: true })
        },
        saved: () => store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(account.id),
    }
}
class Consumer {
    wishes = new Map()
    items = new Map()
    events = []
    constructor(protocol) {
        this.protocol = protocol
    }
    consume(packets) {
        for (const p of packets) {
            const e = this.protocol.byId.get(p.id),
                v = this.protocol.decode(e.rsp, p.payload)
            this.events.push(p.id)
            const playerData = e.name === 'CSProtoEnterGame' ? v.data : e.name === 'CSProtoSyncPlayerData' ? v : null
            if (playerData) for (const item of playerData.sbag_infos?.items ?? []) this.items.set(item.guid, item)
            if (p.id === 6102) {
                for (const row of v.wishlist ?? []) {
                    assert(tables.find('products', row.product_id))
                    this.wishes.set(row.uid, structuredClone(row))
                }
                // Direct current060068ec: incoming rows first, dictionary.Remove old IDs second.
                for (const uid of v.del_wishlist ?? []) this.wishes.delete(uid)
            }
        }
    }
    success(uid) {
        const row = this.wishes.get(uid)
        assert(row)
        const costs = productionMaterials(tables, tables.find('products', row.product_id), row.selects ?? [])
        assert(
            costs.every((c) => c.itemtype === 3),
            'This model tests the actual workbench fixed type3 materials only',
        )
        return costs.every(
            (c) =>
                [...this.items.values()].filter((i) => i.itemid === c.itemid).reduce((n, i) => n + i.itemnum, 0) >=
                c.itemnum * row.count,
        )
    }
}
const legacy = (name) => structuredClone(oldWriter.scenarios.find((s) => s.name === name).home)

test('current1504 gate rejects fresh unqualified writes atomically while old wishlist data still migrates and remains preserved', () => {
    for (const withLegacy of [false, true]) {
        const input = withLegacy ? legacy('unique-current-product') : null,
            f = fixture(
                'wish-system-locked-' + withLegacy,
                input ? (s) => Object.assign(s.home, input) : undefined,
                false,
            )
        try {
            f.login()
            const saved = f.saved(),
                id = input?.wishlist[0].product_id ?? productId
            assert.equal(homeCondition(tables.find('system_unlock', 1504).unlockCondi, f.state()), false)
            for (const [name, request] of [
                ['AddHomeMaterialWishList', native()],
                ['TraceHomeMaterialWishList', { u32: id }],
                ['UnTraceHomeMaterialWishList', { u32: id }],
                ['DelHomeMaterialWishList', { u32: id }],
            ]) {
                assert.throws(() => f.call(name, request), { code: ErrorCode.SystemLock })
                assert.deepEqual(f.saved(), saved)
            }
            if (input) {
                assert.deepEqual(f.state().homeWishlistIdentity.archive.rows, input.wishlist)
                assert.equal(f.state().home.wishlist[0].uid, id)
            } else assert.equal(f.state().homeWishlistIdentity.archive, undefined)
        } finally {
            f.store.close()
        }
    }
})

test('current Native6185 first create/update, trace/untrace/delete and reconnect use product UID without material spending', () => {
    const f = fixture('wish-native-crud')
    try {
        const c = new Consumer(f.protocol)
        c.consume(f.login())
        const before = digest({
            bag: f.state().player.sbag_infos,
            pets: f.state().pets,
            taskRecords: f.state().taskRecords,
        })
        c.consume(f.call('AddHomeMaterialWishList', native()))
        assert.equal(f.state().home.wishlist[0].uid, productId)
        assert(c.wishes.has(productId))
        assert.equal(c.success(productId), false)
        c.consume(f.call('AddHomeMaterialWishList', native(3)))
        assert.equal(f.state().home.wishlist.length, 1)
        assert.equal(c.wishes.get(productId).count, 3)
        c.consume(f.call('TraceHomeMaterialWishList', { u32: productId }))
        assert.equal(c.wishes.get(productId).trace, true)
        c.consume(f.call('UnTraceHomeMaterialWishList', { u32: productId }))
        assert.equal(c.wishes.get(productId).trace, false)
        c.consume(f.reconnect())
        assert.equal(c.wishes.get(productId).count, 3)
        c.consume(f.call('DelHomeMaterialWishList', { u32: productId }))
        assert.equal(c.wishes.has(productId), false)
        assert.equal(f.state().home.wishlist.length, 0)
        assert.equal(
            digest({ bag: f.state().player.sbag_infos, pets: f.state().pets, taskRecords: f.state().taskRecords }),
            before,
        )
        assert.equal(f.state().homeWishlistIdentity.archive, undefined)
    } finally {
        f.store.close()
    }
})

test('current Native add-existing sequence removes then recreates canonical UID with its supplied accumulated count/trace', () => {
    const f = fixture('wish-native-readd')
    try {
        f.login()
        f.call('AddHomeMaterialWishList', native(2))
        f.call('TraceHomeMaterialWishList', { u32: productId })
        // Actual060068f0 preserves trace and adds count client-side before6186→6185.
        const next = { ...native(3), trace: true }
        f.call('DelHomeMaterialWishList', { u32: productId })
        f.call('AddHomeMaterialWishList', next)
        assert.deepEqual(f.state().home.wishlist, [next])
    } finally {
        f.store.close()
    }
})

test('current material-ready success follows actual GM item sync; wishlist does not manufacture completion/rewards or auto-remove', () => {
    const f = fixture('wish-material-ready')
    try {
        const c = new Consumer(f.protocol)
        c.consume(f.login())
        c.consume(f.call('AddHomeMaterialWishList', native()))
        c.consume(f.call('TraceHomeMaterialWishList', { u32: productId }))
        const costs = productionMaterials(tables, tables.find('products', productId), [])
        assert.equal(costs.length, 2)
        assert.equal(c.success(productId), false)
        for (let i = 0; i < costs.length; i++) {
            const item = costs[i],
                packets = f.call('GMCommand', {
                    command: Buffer.from(`item ${item.itemid} ${item.itemnum * 2}`).toString('base64'),
                })
            assert(packets.some((p) => f.protocol.byId.get(p.id).name === 'CSProtoSyncPlayerData'))
            c.consume(packets)
            assert.equal(c.success(productId), i === costs.length - 1)
        }
        assert.equal(f.state().home.wishlist.length, 1)
        assert.equal(f.state().home.wishlist[0].count, 2)
        const cold = new Consumer(f.protocol)
        cold.consume(f.reconnect())
        assert.equal(cold.success(productId), true)
        assert.equal(cold.wishes.get(productId).trace, true)
    } finally {
        f.store.close()
    }
})

test('once-only old writer migration preserves exact raw/trace/counter and emits safe typed old-UID deletion', () => {
    const input = legacy('unique-current-product'),
        f = fixture('wish-legacy-unique', (s) => Object.assign(s.home, input))
    try {
        const consumer = new Consumer(f.protocol),
            old = input.wishlist[0]
        // Conditional existing cache uses the genuine historical writer row; cold
        // unknown deletes are separately safe dictionary.Remove operations.
        consumer.consume([{ id: 6102, payload: f.protocol.encode('cs.SCHomeSync', { wishlist: [old] }) }])
        consumer.consume(f.login())
        const state = f.state(),
            archive = state.homeWishlistIdentity.archive
        assert.deepEqual(archive.rows, input.wishlist)
        assert.deepEqual(archive.nextWishUid, { present: true, value: input.nextWishUid })
        assert.deepEqual(state.home.wishlist, [{ ...old, uid: old.product_id }])
        assert.equal(state.home.nextWishUid, input.nextWishUid)
        assert.equal(consumer.wishes.has(old.uid), false)
        assert(consumer.wishes.has(old.product_id))
        const before = digest(state.homeWishlistIdentity)
        consumer.consume(f.reconnect())
        assert.equal(digest(f.state().homeWishlistIdentity), before)
        assert.equal(bootstrapHomeWishlistIdentity(tables, f.state()).changed, false)
    } finally {
        f.store.close()
    }
})

test('old duplicate products/missing current config are archived as complete groups, never merged or silently substituted', () => {
    for (const name of ['duplicate-current-product', 'retired-product']) {
        const input = legacy(name),
            f = fixture('wish-isolation-' + name, (s) => Object.assign(s.home, input))
        try {
            const packets = f.login(),
                s = f.state()
            assert.equal(s.home.wishlist.length, 0)
            assert.deepEqual(s.homeWishlistIdentity.archive.rows, input.wishlist)
            assert.equal(s.homeWishlistIdentity.archive.reasons.length, input.wishlist.length)
            assert(
                s.homeWishlistIdentity.archive.reasons.every(
                    (r) =>
                        r.reason === (name.startsWith('duplicate') ? 'duplicate-product' : 'missing-current-product'),
                ),
            )
            const c = new Consumer(f.protocol)
            c.consume(packets)
            assert.equal(c.wishes.size, 0)
            const before = structuredClone(s.homeWishlistIdentity)
            f.call('AddHomeMaterialWishList', native())
            assert.deepEqual(f.state().homeWishlistIdentity, before)
        } finally {
            f.store.close()
        }
    }
})

test('current valid wish stays byte-identical without archive; invalid legacy material choices quarantine without picking replacements', () => {
    const current = baseline('wish-already-current', (s) => {
        s.home.wishlist = [native()]
    })
    const raw = structuredClone(current.home.wishlist)
    bootstrapHomeWishlistIdentity(tables, current)
    assert.deepEqual(current.home.wishlist, raw)
    assert.equal(current.homeWishlistIdentity.archive, undefined)
    const bad = baseline('wish-invalid-old', (s) => Object.assign(s.home, legacy('unique-current-product')))
    bad.home.wishlist[0].selects = [0xffffffff]
    const original = structuredClone(bad.home.wishlist)
    bootstrapHomeWishlistIdentity(tables, bad)
    assert.equal(bad.home.wishlist.length, 0)
    assert.deepEqual(bad.homeWishlistIdentity.archive.rows, original)
    assert.equal(bad.homeWishlistIdentity.archive.reasons[0].reason, 'invalid-current-selections')
    const ordinary = tables.find('products', 160002),
        groups = ordinary.materialSelect.split('|').map(Number),
        options = groups.map((id) => tables.get('products_material_group').find((r) => r.materialGroupId === id).Id)
    validateWishlistSelections(tables, ordinary, options)
    assert.throws(() => validateWishlistSelections(tables, ordinary, [0]), {
        code: ErrorCode.FunctionClosed,
    })
    const quality = tables.get('products_multi_quality')[0],
        cook = tables.find('products', Number(quality.productId.split('|')[0].split('#')[1])),
        requirements = [quality.calculateNeedMaterial, quality.uncalculateNeedMaterial].flatMap((s) =>
            s
                .split('|')
                .filter(Boolean)
                .map((v) => Number(v.split('#')[0])),
        ),
        food = requirements.map((id) =>
            Number(tables.find('food_material_group', id).includeItems.split('|')[0].split('#')[0]),
        )
    validateWishlistSelections(tables, cook, food)
    assert.throws(
        () =>
            validateWishlistSelections(
                tables,
                cook,
                food.map(() => 0),
            ),
        { code: ErrorCode.FunctionClosed },
    )
})

test('migration and later canonical insertion cannot let an old seq tombstone delete a newly legitimate product UID', () => {
    const old = legacy('unique-current-product'),
        target = old.wishlist[0].product_id
    old.wishlist[0].uid = productId
    old.nextWishUid = productId + 1
    const f = fixture('wish-uid-collision', (s) => Object.assign(s.home, old))
    try {
        const c = new Consumer(f.protocol)
        c.consume(f.login())
        assert(c.wishes.has(target))
        assert(homeWishlistPresentation(tables, f.state()).del_wishlist.includes(productId))
        c.consume(f.call('AddHomeMaterialWishList', native()))
        assert(c.wishes.has(target))
        assert(c.wishes.has(productId))
        assert(!(homeWishlistPresentation(tables, f.state()).del_wishlist ?? []).includes(productId))
        c.consume(f.reconnect())
        assert(c.wishes.has(target) && c.wishes.has(productId))
    } finally {
        f.store.close()
    }
})

test('current negative identity/selection/limit requests are atomic; existing canonical row updates remain legal at capacity', () => {
    const f = fixture('wish-current-negative')
    try {
        f.login()
        for (const [request, code] of [
            [{ ...native(), uid: 1 }, ErrorCode.InvalidArgument],
            [{ ...native(), uid: 9999999, product_id: 9999999 }, ErrorCode.HomeMaterialWishlistConfInvalid],
            [native(0), ErrorCode.InvalidArgument],
            [native(100), ErrorCode.HomeMaterialWishlistNumLimit],
            [{ ...native(), selects: [0xffffffff] }, ErrorCode.ProductSelectMaterialFail],
        ]) {
            const before = f.saved()
            assert.throws(() => f.call('AddHomeMaterialWishList', request), { code })
            assert.deepEqual(f.saved(), before)
        }
        for (const name of ['DelHomeMaterialWishList', 'TraceHomeMaterialWishList', 'UnTraceHomeMaterialWishList']) {
            const before = f.saved()
            assert.throws(() => f.call(name, { u32: 1 }), { code: ErrorCode.HomeMaterialWishlistNotExsit })
            assert.deepEqual(f.saved(), before)
        }
        const max = Number(tables.get('game').find((r) => r.title === 'HOME_WISHLIST_LIMIT').value),
            recipes = tables
                .get('products')
                .filter(
                    (r) =>
                        r.id !== productId &&
                        r.wishlistLimit > 0 &&
                        !r.materialSelect &&
                        !tables
                            .get('products_multi_quality')
                            .some((q) => q.productId.split('|').some((p) => Number(p.split('#')[1]) === r.id)),
                )
                .slice(0, max)
        assert.equal(recipes.length, max)
        // Current canonical saved-capacity integrity fixture, not an asserted
        // natural unlock/progression path for all these distinct recipes.
        f.edit((s) => {
            s.home.wishlist = recipes.map((r) => ({ uid: r.id, product_id: r.id, count: 1, selects: [], trace: false }))
        })
        const before = f.saved()
        assert.throws(() => f.call('AddHomeMaterialWishList', native()), {
            code: ErrorCode.HomeMaterialWishlistNumLimit,
        })
        assert.deepEqual(f.saved(), before)
        const row = f.state().home.wishlist[0]
        f.call('AddHomeMaterialWishList', { ...row, count: 2 })
        assert.equal(f.state().home.wishlist.length, max)
    } finally {
        f.store.close()
    }
})

test('codec and actual SQL failure roll back first bootstrap archive and later public mutations, then cold retry succeeds', () => {
    for (const mode of ['codec', 'sql']) {
        const input = legacy('unique-current-product'),
            f = fixture('wish-rollback-' + mode, (s) => Object.assign(s.home, input))
        try {
            const before = f.saved(),
                encode = f.protocol.encode
            if (mode === 'codec')
                f.protocol.encode = function (name, ...args) {
                    if (name.replace(/^cs\./, '') === 'SCHomeSync') throw Error('injected wish codec')
                    return encode.call(this, name, ...args)
                }
            else
                f.store.db.exec(
                    "CREATE TEMP TRIGGER wish_fail BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'injected wish SQL'); END",
                )
            try {
                assert.throws(() => f.login(), /injected wish/)
            } finally {
                f.protocol.encode = encode
                if (mode === 'sql') f.store.db.exec('DROP TRIGGER wish_fail')
            }
            assert.deepEqual(f.saved(), before)
            assert.equal(f.state().homeWishlistIdentity, undefined)
            const c = new Consumer(f.protocol)
            c.consume(f.reconnect())
            assert(c.wishes.has(input.wishlist[0].product_id))
            const current = f.saved()
            f.protocol.encode = function (name, ...args) {
                if (name.replace(/^cs\./, '') === 'SCHomeSync') throw Error('injected wish codec')
                return encode.call(this, name, ...args)
            }
            try {
                assert.throws(() => f.call('AddHomeMaterialWishList', native()), /injected wish codec/)
            } finally {
                f.protocol.encode = encode
            }
            assert.deepEqual(f.saved(), current)
        } finally {
            f.store.close()
        }
    }
})

test('bootstrap cannot absorb later legacy rows or unknown products and rejects damaged archive without changing original state', () => {
    const s = baseline('wish-once-only')
    bootstrapHomeWishlistIdentity(tables, s)
    Object.assign(s.home, legacy('unique-current-product'))
    const before = digest(s)
    assert.throws(() => bootstrapHomeWishlistIdentity(tables, s), { code: ErrorCode.GameConfig })
    assert.equal(digest(s), before)
    const unknown = baseline('wish-unknown-old', (s) => {
        s.home.wishlist = [{ uid: 1, product_id: 9999999, count: 1, selects: [] }]
        s.home.nextWishUid = 2
    })
    assert.throws(() => bootstrapHomeWishlistIdentity(tables, unknown), { code: ErrorCode.GameConfig })
    const corrupt = baseline('wish-corrupt-archive', (s) => Object.assign(s.home, legacy('unique-current-product')))
    bootstrapHomeWishlistIdentity(tables, corrupt)
    corrupt.homeWishlistIdentity.archive.oldUids.push(productId)
    assert.throws(() => homeWishlistPresentation(tables, corrupt), { code: ErrorCode.GameConfig })
})

test('archive metadata checksum rejects deleting all reasons/UIDs or one matched pair without touching original preimage', () => {
    for (const scenario of ['unique-current-product', 'duplicate-current-product']) {
        const state = baseline('wish-metadata-' + scenario, (s) => Object.assign(s.home, legacy(scenario)))
        bootstrapHomeWishlistIdentity(tables, state)
        const archive = state.homeWishlistIdentity.archive
        assert.match(archive.metadataSha256, /^[a-f0-9]{64}$/)
        const originalPreimage = digest({ rows: archive.rows, nextWishUid: archive.nextWishUid })
        assert.equal(originalPreimage, archive.preimageSha256)
        for (const damage of [
            (a) => {
                a.reasons = []
                a.oldUids = []
            },
            ...(archive.reasons.length > 1
                ? [
                      (a) => {
                          const removed = a.reasons.pop()
                          a.oldUids = a.oldUids.filter((uid) => uid !== a.rows[removed.index].uid)
                      },
                  ]
                : []),
            (a) => {
                a.reasons[0].reason =
                    a.reasons[0].reason === 'uid-canonicalized' ? 'duplicate-product' : 'uid-canonicalized'
            },
            (a) => {
                delete a.metadataSha256
            },
        ]) {
            const corrupt = structuredClone(state)
            damage(corrupt.homeWishlistIdentity.archive)
            assert.equal(
                digest({
                    rows: corrupt.homeWishlistIdentity.archive.rows,
                    nextWishUid: corrupt.homeWishlistIdentity.archive.nextWishUid,
                }),
                originalPreimage,
            )
            const before = digest(corrupt)
            assert.throws(() => homeWishlistPresentation(tables, corrupt), { code: ErrorCode.GameConfig })
            assert.throws(() => bootstrapHomeWishlistIdentity(tables, corrupt), { code: ErrorCode.GameConfig })
            assert.equal(digest(corrupt), before)
        }
    }
})

test('Game rejects partially deleted archive metadata on reconnect atomically and retains valid raw archive across cold retry', () => {
    const f = fixture('wish-metadata-reconnect', (s) => Object.assign(s.home, legacy('duplicate-current-product')))
    try {
        f.login()
        const valid = structuredClone(f.state().homeWishlistIdentity)
        f.edit((s) => {
            const archive = s.homeWishlistIdentity.archive,
                removed = archive.reasons.pop()
            archive.oldUids = archive.oldUids.filter((uid) => uid !== archive.rows[removed.index].uid)
        })
        const before = f.saved()
        assert.throws(() => f.reconnect(), { code: ErrorCode.GameConfig })
        assert.deepEqual(f.saved(), before)
        f.edit((s) => {
            s.homeWishlistIdentity = structuredClone(valid)
        })
        const c = new Consumer(f.protocol)
        c.consume(f.reconnect())
        assert.equal(c.wishes.size, 0)
        assert.deepEqual(f.state().homeWishlistIdentity, valid)
    } finally {
        f.store.close()
    }
})
