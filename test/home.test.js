import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables, bytes, seedPlayer } from '../src/player.js'
import { TaskGraphs } from '../src/tasks.js'
import { homeCondition } from '../src/home-grid.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { grantRewards } from '../src/rewards.js'
const c = configuration(),
    tables = new Tables(c.tables),
    p = new Protocol(c.base)
const wishlistProductId = 710000
const initialPlacements = tables
    .get('game')
    .find((row) => row.title === 'HOME_DEFAULT_PLACEMENT')
    .value.split('|')
    .map((part) => part.split('#').map(Number))
const wishlistLimit = Number(tables.get('game').find((row) => row.title === 'HOME_WISHLIST_LIMIT').value)
const capacityRecipes = tables
    .get('products')
    .filter(
        (row) =>
            row.id !== wishlistProductId &&
            row.wishlistLimit > 0 &&
            !row.materialSelect &&
            !tables
                .get('products_multi_quality')
                .some((q) => q.productId.split('|').some((part) => Number(part.split('#')[1]) === row.id)),
    )
    .slice(0, wishlistLimit)
assert.equal(capacityRecipes.length, wishlistLimit)
// Trusted independent post-task checkpoint; this suite does not play the
// preceding story. Only the actual1504 prerequisite closure is supplied.
function qualifiedPlayer(id, name) {
    const state = seedPlayer(tables, id, name),
        system = tables.find('system_unlock', 1504)
    const [kind, taskId, nodeId] = system.unlockCondi.split('#').map(Number)
    assert.equal(kind, 12045)
    assert(new TaskGraphs(tables).get(taskId).nodes.has(nodeId))
    const completed = new Set(),
        levels = []
    const visit = (id) => {
        if (completed.has(id)) return
        completed.add(id)
        const row = tables.find('task', id)
        for (const part of String(row.unlockcondition).split('|').filter(Boolean)) {
            const [condition, target] = part.split('#').map(Number)
            if (condition === 2007 || condition === 12045) visit(target)
            else if (condition === 2004) levels.push(target)
            else assert.fail('Unmodeled wishlist prerequisite ' + part)
        }
    }
    visit(taskId)
    state.tasks = []
    state.taskRecords = [...completed].map((task_id) => ({ task_id, count: 1, time: 1 }))
    state.player.basic_info.lv = Math.max(state.player.basic_info.lv, ...levels)
    assert(homeCondition(system.unlockCondi, state))
    return state
}
function setup() {
    const store = new Store(':memory:'),
        game = new Game(p, store, tables),
        session = {}
    let seq = 1
    const call = (name, r, s = session) => {
        const e = p.byName.get('CSProto' + name)
        return game.dispatch(s, { id: e.id, seq: seq++, pushSeq: 0, payload: p.encode(e.req, r) })
    }
    store.login('home', qualifiedPlayer)
    const login = call('EnterGame', { open_id: 'home' })
    return { store, session, call, login }
}
test('home initializes configured workbench and owns building inventory independently', () => {
    const { store, session, call, login } = setup()
    try {
        const home = p.decode('SCHomeSync', login.find((x) => x.id === 6102).payload)
        assert.equal(home.home_builds[0].build_id, 10000)
        assert.equal(home.home_builds[0].locate.block_id, 101)
        assert.deepEqual(
            home.home_builds
                .filter((build) => initialPlacements.some((row) => row[1] === build.build_id))
                .map((build) => [
                    13,
                    build.build_id,
                    build.locate.block_id,
                    build.locate.anchor,
                    build.locate.direction,
                ]),
            initialPlacements,
        )
        assert.equal(home.home_builds[0].status, 1)
        assert.equal(home.builds[0].used_num, 1)
        const reply = call('EnterHome', { creator_id: session.id })
        assert(reply.findIndex((x) => x.id === 6102) < reply.findIndex((x) => x.id === 6101))
        const before = store.load(session.id)
        assert.throws(() => call('EnterHome', { creator_id: session.id + 1 }))
        assert.deepEqual(store.load(session.id), before)
        store.transact(session.id, 0, (s) => grantRewards(tables, s, [{ itemtype: 13, itemid: 20041, itemnum: 2 }]))
        const after = store.load(session.id).state.home
        assert.equal(after.inventory.find((x) => x.build_id === 20041).total_num, 2)
        assert.equal(after.inventory.find((x) => x.build_id === 20041).used_num, 0)
        assert.equal(after.builds.length, initialPlacements.length)
    } finally {
        store.close()
    }
})
test('home name, shortcuts and wishlist survive login; invalid updates roll back', () => {
    const { store, session, call } = setup()
    try {
        call('SetHomeName', { name: bytes('小花园') })
        call('HomeShortcutChange', { shortcut_bar: [{ type: 1, item_id: [10000, 0, -1] }] })
        call('AddHomeMaterialWishList', { uid: wishlistProductId, product_id: wishlistProductId, count: 2 })
        let state = store.load(session.id).state
        const uid = state.home.wishlist[0].uid
        call('TraceHomeMaterialWishList', { u32: uid })
        const login = call('EnterGame', { open_id: 'home' }, {})
        const home = p.decode('SCHomeSync', login.find((x) => x.id === 6102).payload)
        assert.equal(Buffer.from(home.home_name, 'base64').toString(), '小花园')
        assert.deepEqual(home.shortcut_bars[0].item_id.slice(0, 3), [10000, 0, -1])
        assert.equal(
            home.shortcut_bars[0].item_id.length,
            Number(tables.get('game').find((row) => row.title === 'HOME_BELT_NUM_PC').value),
        )
        assert(home.shortcut_bars[0].item_id.slice(3).every((id) => id === 0))
        assert.equal(home.wishlist[0].trace, true)
        const before = store.load(session.id)
        assert.throws(() =>
            call('HomeShortcutChange', {
                shortcut_bar: [
                    { type: 1, item_id: [10000] },
                    { type: 1, item_id: [20041] },
                ],
            }),
        )
        assert.deepEqual(store.load(session.id), before)
        assert.throws(() => call('AddHomeMaterialWishList', { uid: 999, product_id: wishlistProductId, count: 1 }))
        assert.deepEqual(store.load(session.id), before)
        const removed = call('DelHomeMaterialWishList', { u32: uid })
        assert.equal(removed[0].id, 6102)
        assert.deepEqual(p.decode('SCHomeSync', removed[0].payload).del_wishlist, [uid])
        assert.equal(store.load(session.id).state.home.wishlist.length, 0)
    } finally {
        store.close()
    }
})
test('wishlist capacity and later invalid building rewards preserve transactional state', () => {
    const { store, session, call } = setup()
    try {
        store.transact(session.id, 0, (s) => {
            // Current canonical saved-capacity integrity fixture, not a claim
            // of natural unlock qualification for all recipes.
            s.home.wishlist = capacityRecipes.map((row) => ({
                uid: row.id,
                product_id: row.id,
                count: 1,
                selects: [],
                trace: false,
            }))
            s.home.nextWishUid = wishlistLimit + 1
        })
        const before = store.load(session.id)
        assert.throws(
            () => call('AddHomeMaterialWishList', { uid: wishlistProductId, product_id: wishlistProductId, count: 1 }),
            /full/,
        )
        assert.deepEqual(store.load(session.id), before)
        assert.throws(() =>
            store.transact(session.id, 0, (s) =>
                grantRewards(tables, s, [
                    { itemtype: 13, itemid: 20041, itemnum: 1 },
                    { itemtype: 13, itemid: 999999999, itemnum: 1 },
                ]),
            ),
        )
        assert.deepEqual(store.load(session.id), before)
    } finally {
        store.close()
    }
})
