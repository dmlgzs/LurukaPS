import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { configuration } from '../src/config.js'
import { Tables, seedPlayer } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { homePayload } from '../src/home.js'
import { homeBuildingPresentation, mergeHomeBuildingShortcutWriteback } from '../src/home-building-presentation.js'
import { homeBuildingAvailability } from '../src/home-building-availability.js'
import { gridAnchor, validatePlacement } from '../src/home-grid.js'
import { ErrorCode } from '../src/error-codes.js'
import ownership from './fixtures/retired-home-building-ownership.json' with { type: 'json' }

const cfg = configuration(),
    tables = new Tables(cfg.tables)
const retired = new Set(ownership.inventory.map((row) => row.build_id))
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function addHistoricalOwnership(state) {
    state.home.inventory.push(...structuredClone(ownership.inventory))
    // Preserve original positions, including empty/sentinel/current slots.
    state.home.shortcuts = [{ type: 1, item_id: [10000, 0, -1, ...ownership.shortcuts[0].item_id, 10000] }]
}
function fixture(name) {
    const protocol = new Protocol(cfg.base),
        store = new Store(':memory:')
    const state = seedPlayer(tables, 1, name)
    // This is a trusted historical ownership fixture, not an assertion that
    // unavailable furniture could legally be placed in the old version.
    homePayload(tables, state)
    addHistoricalOwnership(state)
    const account = store.login(name, () => state)
    const game = new Game(protocol, store, tables, { clock: () => 1800000000 })
    let session = {},
        sequence = 1
    const call = (name, request = {}) => {
        const e = protocol.byName.get(name) ?? protocol.byName.get('CSProto' + name)
        return game.dispatch(session, {
            id: e.id,
            seq: sequence++,
            payload: e.req ? protocol.encode(e.req, request) : Buffer.alloc(0),
        })
    }
    return {
        protocol,
        store,
        game,
        call,
        account,
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
function consume(protocol, packets, bag = new Map()) {
    let syncs = 0
    for (const packet of packets) {
        if (packet.id !== 6102) continue
        syncs++
        const data = protocol.decode('cs.SCHomeSync', packet.payload)
        for (const row of data.builds ?? []) {
            if (row.build_id) bag.set(row.build_id, row)
        }
        // Current Lua rsp_syncBuildingBag retains IDs without filtering.
        // pageHomeBag emits a cell even when the missing tpl has stackNum0;
        // cellIconHome then dereferences homeBuildingTpl/getHomeObjTpl.
        for (const row of bag.values()) {
            if (row.total_num <= row.used_num) continue
            const building = tables.find('home_building', row.build_id)
            assert(building, 'Current Lua bag icon consumer would receive a missing catalog row')
            assert(tables.find('home_object', building.objId))
        }
        for (const bar of data.shortcut_bars ?? []) {
            if (bar.type !== 1) continue
            for (const id of bar.item_id) if (id > 0) assert(tables.find('home_building', id))
        }
    }
    return { syncs, bag }
}
function location(state, guid) {
    const block = tables.find('home_block', 101),
        start = block.blockStartPos.split('|').map(Number),
        end = block.blockEndPos.split('|').map(Number)
    for (let x = Math.min(start[0], end[0]); x < Math.max(start[0], end[0]); x++)
        for (let y = Math.min(start[1], end[1]); y < Math.max(start[1], end[1]); y++) {
            const locate = {
                block_id: 101,
                anchor: gridAnchor(x, y),
                direction: 0,
                position: { x, y: 0, z: y },
                rotation: { x: 0, y: 0, z: 0 },
                scale: { x: 1, y: 1, z: 1 },
                center: { x: 0, y: 0, z: 0 },
            }
            if (state.home.builds.find((b) => b.guid === guid)?.locate.anchor === locate.anchor) continue
            try {
                validatePlacement(tables, state, 10000, locate, guid)
                return locate
            } catch (error) {
                if (error.code !== ErrorCode.InvalidArgument) throw error
            }
        }
    throw Error('No legal current workbench position')
}

test('pure:28 proven retired ownership rows stay raw; wire omits only those IDs and zeroes shortcut slots without movement', () => {
    const state = seedPlayer(tables, 1, 'compat-pure')
    homePayload(tables, state)
    addHistoricalOwnership(state)
    const before = hash(state),
        payload = { builds: state.home.inventory, shortcut_bars: state.home.shortcuts },
        result = homeBuildingPresentation(tables, state, payload)
    assert.equal(retired.size, 28)
    assert.deepEqual(
        result.builds,
        payload.builds.filter((row) => !retired.has(row.build_id)),
    )
    assert.deepEqual(result.shortcut_bars[0].item_id, [10000, 0, -1, ...Array(28).fill(0), 10000])
    assert.equal(result.shortcut_bars[0].item_id.length, payload.shortcut_bars[0].item_id.length)
    assert.equal(hash(state), before)
    assert.deepEqual(homeBuildingPresentation(tables, state, result), result)
    assert.equal(state.home.inventory.filter((r) => retired.has(r.build_id)).length, 28)
})

test('pure: ordinary rows and valid negative sentinel are identical; unknown missing/current broken objects remain strict', () => {
    const state = seedPlayer(tables, 1, 'compat-normal')
    homePayload(tables, state)
    state.home.shortcuts = [
        { type: 1, item_id: [10000, 0, -1] },
        { type: 2, item_id: [2, 0] },
    ]
    const payload = { builds: state.home.inventory, shortcut_bars: state.home.shortcuts }
    assert.equal(homeBuildingPresentation(tables, state, payload), payload)
    state.home.inventory.push({ build_id: 9999999, total_num: 1, used_num: 0, unlock: true })
    assert.throws(() => homeBuildingPresentation(tables, state, payload), { code: ErrorCode.BuildConfNotFound })
    const broken = new Tables(cfg.tables)
    broken.cache.set(
        'home_building',
        tables.get('home_building').map((row) => (row.id === 10000 ? { ...row, objId: 9999999 } : row)),
    )
    assert.throws(() => homeBuildingAvailability(broken, 10000), { code: ErrorCode.GameConfig })
    const additional = new Tables(cfg.tables)
    additional.cache.set('home_building', [
        ...tables.get('home_building'),
        { ...tables.find('home_building', 10000), id: 9999998 },
    ])
    assert.equal(homeBuildingAvailability(additional, 10000).available, true)
    assert.throws(() => homeBuildingAvailability(additional, 30251), { code: ErrorCode.GameConfig })
})

test('current consumer source retains unknown bag IDs; the finite presenter avoids its missing-tpl dereference', () => {
    const lua = path.resolve(cfg.tables, '../Lua/src/src')
    assert(
        fs
            .readFileSync(path.join(lua, 'ui/store/home/homeAction.lua'), 'utf8')
            .includes('self.data.buildingBag[v.build_id]'),
    )
    assert(
        fs
            .readFileSync(path.join(lua, 'ui/pages/home/homeBag/cellIconHome.lua'), 'utf8')
            .includes('self.bind.img_icon = _homeBuildingTpl:getBuildIcon(tpl)'),
    )
    assert(
        fs
            .readFileSync(path.join(lua, 'ui/configTpl/homeBuildingTpl.lua'), 'utf8')
            .includes('L_GameTpl:getHomeObjTpl(tpl.objId)'),
    )
    assert(fs.readFileSync(path.join(lua, 'ui/store/home/homeState.lua'), 'utf8').includes('list[i] = 0'))
})

test('LOCAL writeback preserves only retired empty slots, archives each original position once, and permits current edits/clears', () => {
    const state = seedPlayer(tables, 1, 'compat-writeback')
    homePayload(tables, state)
    addHistoricalOwnership(state)
    const incoming = { type: 1, item_id: [0, 10000, -1, ...Array(28).fill(0), 0] }
    const first = mergeHomeBuildingShortcutWriteback(tables, state, incoming)
    assert.deepEqual(first.item_id, [0, 10000, -1, ...ownership.shortcuts[0].item_id, 0])
    assert.deepEqual(incoming.item_id, [0, 10000, -1, ...Array(28).fill(0), 0])
    assert.equal(state.homeBuildingCompatibility.shortcutSlots.length, 28)
    const archived = structuredClone(state.homeBuildingCompatibility)
    state.home.shortcuts = [first]
    const overwrite = { type: 1, item_id: [...incoming.item_id] }
    overwrite.item_id[3] = 10000
    const next = mergeHomeBuildingShortcutWriteback(tables, state, overwrite)
    assert.equal(next.item_id[3], 10000)
    assert.deepEqual(state.homeBuildingCompatibility, archived)
    assert.deepEqual(archived.shortcutSlots[0], { type: 1, slot: 3, build_id: 30251 })
    state.home.shortcuts = [next]
    for (let i = 0; i < 5; i++) mergeHomeBuildingShortcutWriteback(tables, state, overwrite)
    assert.deepEqual(state.homeBuildingCompatibility, archived)
    assert.throws(() => mergeHomeBuildingShortcutWriteback(tables, state, { type: 1, item_id: [9999999] }), {
        code: ErrorCode.BuildConfNotFound,
    })
    assert.throws(() => mergeHomeBuildingShortcutWriteback(tables, state, { type: 1, item_id: [30251] }), {
        code: ErrorCode.BuildConfNotFound,
    })
    const ordinary = seedPlayer(tables, 2, 'compat-ordinary-clear')
    homePayload(tables, ordinary)
    ordinary.home.shortcuts = [{ type: 1, item_id: [10000, -1, 0] }]
    const clear = { type: 1, item_id: [0, -1, 0] }
    assert.equal(mergeHomeBuildingShortcutWriteback(tables, ordinary, clear), clear)
    assert.equal(ordinary.homeBuildingCompatibility, undefined)
})

test('Game candidate: current belt echo retains28 hidden raw slots, positive replacement archives provenance, and normal clear still works', () => {
    const f = fixture('compat-shortcut-echo')
    try {
        const packets = f.login()
        const bar = structuredClone(
            f.protocol
                .decode('cs.SCHomeSync', packets.find((p) => p.id === 6102).payload)
                .shortcut_bars.find((b) => b.type === 1),
        )
        bar.item_id[1] = 10000
        bar.item_id[0] = 0
        consume(f.protocol, f.call('HomeShortcutChange', { shortcut_bar: [bar] }))
        assert.equal(f.state().home.shortcuts[0].item_id[0], 0)
        assert.equal(f.state().home.shortcuts[0].item_id[1], 10000)
        assert.equal(f.state().home.shortcuts[0].item_id.filter((id) => retired.has(id)).length, 28)
        const archive = structuredClone(f.state().homeBuildingCompatibility)
        bar.item_id[3] = 10000
        consume(f.protocol, f.call('HomeShortcutChange', { shortcut_bar: [bar] }))
        assert.equal(f.state().home.shortcuts[0].item_id[3], 10000)
        assert.equal(f.state().home.shortcuts[0].item_id.filter((id) => retired.has(id)).length, 27)
        assert.deepEqual(f.state().homeBuildingCompatibility, archive)
        const repeat = f.state().homeBuildingCompatibility
        consume(f.protocol, f.call('HomeShortcutChange', { shortcut_bar: [bar] }))
        assert.deepEqual(f.state().homeBuildingCompatibility, repeat)
        consume(f.protocol, f.reconnect())
        assert.deepEqual(f.state().homeBuildingCompatibility, archive)
        assert.deepEqual(
            f.state().home.inventory.filter((r) => retired.has(r.build_id)),
            ownership.inventory,
        )
    } finally {
        f.store.close()
    }
})

test('Game candidate: actual SQL save failure rolls back shortcut writes and compatibility archive; retry and reconnect remain valid', () => {
    const f = fixture('compat-sql-save')
    try {
        f.login()
        const before = f.saved(),
            bar = { type: 1, item_id: [10000, 0, -1, ...Array(28).fill(0), 10000] }
        f.store.db.exec(
            "CREATE TEMP TRIGGER injected_compat_save BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'injected home SQL failure'); END",
        )
        try {
            assert.throws(() => f.call('HomeShortcutChange', { shortcut_bar: [bar] }), /injected home SQL failure/)
        } finally {
            f.store.db.exec('DROP TRIGGER injected_compat_save')
        }
        assert.deepEqual(f.saved(), before)
        assert.equal(f.state().homeBuildingCompatibility, undefined)
        consume(f.protocol, f.call('HomeShortcutChange', { shortcut_bar: [bar] }))
        assert.equal(f.state().homeBuildingCompatibility.shortcutSlots.length, 28)
        consume(f.protocol, f.reconnect())
        assert.equal(f.state().homeBuildingCompatibility.shortcutSlots.length, 28)
        assert.deepEqual(
            f.state().home.inventory.filter((r) => retired.has(r.build_id)),
            ownership.inventory,
        )
    } finally {
        f.store.close()
    }
})

test('Game candidate: cold login, EnterHome, normal current placement/movement and reconnect preserve28 assets and shortcut indices', () => {
    const f = fixture('compat-game')
    try {
        const raw = structuredClone(f.state().home),
            initial = f.login()
        assert(consume(f.protocol, initial).syncs > 0)
        consume(f.protocol, f.call('EnterHome'))
        const before = f.state(),
            workbench = before.home.builds.find((b) => b.build_id === 10000)
        assert(workbench)
        const move = { guid: workbench.guid, build_id: 10000, locate: location(before, workbench.guid) }
        consume(f.protocol, f.call('BuildLocate', move))
        assert.equal(f.state().home.builds.find((b) => b.guid === workbench.guid).locate.anchor, move.locate.anchor)
        // A normal current belt-selected item follows the existing store/
        // locate path. Reuse the real instance; do not invent an extra slot.
        consume(f.protocol, f.call('BuildUnlocate', { guid: workbench.guid }))
        assert(f.state().home.storedBuilds.some((b) => b.guid === workbench.guid))
        assert(!f.state().home.builds.some((b) => b.guid === workbench.guid))
        const bagPackets = f.call('EnterHome')
        consume(f.protocol, bagPackets)
        const belt = f.protocol
            .decode('cs.SCHomeSync', bagPackets.find((p) => p.id === 6102).payload)
            .shortcut_bars.find((bar) => bar.type === 1)
        assert.equal(belt.item_id[0], 10000)
        consume(f.protocol, f.call('BuildLocate', { build_id: belt.item_id[0], locate: location(f.state(), 0) }))
        assert(f.state().home.builds.some((b) => b.guid === workbench.guid && b.build_id === 10000))
        assert(!f.state().home.storedBuilds.some((b) => b.guid === workbench.guid))
        const current = f.state().home.shortcuts[0].item_id
        assert.deepEqual(current, raw.shortcuts[0].item_id)
        consume(f.protocol, f.reconnect())
        assert.deepEqual(
            f.state().home.inventory.filter((r) => retired.has(r.build_id)),
            ownership.inventory,
        )
        assert.deepEqual(f.state().home.shortcuts, raw.shortcuts)
        assert(f.state().home.builds.every((b) => !retired.has(b.build_id)))
    } finally {
        f.store.close()
    }
})

test('Game candidate:6102 codec failure rolls back SQL/revision/assets and cold retries still filter safely', () => {
    const f = fixture('compat-rollback')
    try {
        f.login()
        const before = f.saved(),
            encode = f.protocol.encode
        f.protocol.encode = function (name, ...args) {
            if (name.replace(/^cs\./, '') === 'SCHomeSync') throw Error('injected home codec failure')
            return encode.call(this, name, ...args)
        }
        try {
            assert.throws(
                () => f.call('SetHomeName', { name: Buffer.from('candidate').toString('base64') }),
                /injected home codec failure/,
            )
        } finally {
            f.protocol.encode = encode
        }
        assert.deepEqual(f.saved(), before)
        consume(f.protocol, f.call('EnterHome'))
        consume(f.protocol, f.reconnect())
        assert.deepEqual(
            f.state().home.inventory.filter((r) => retired.has(r.build_id)),
            ownership.inventory,
        )
    } finally {
        f.store.close()
    }
})
