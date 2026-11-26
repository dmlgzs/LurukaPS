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
import { ErrorCode } from '../src/error-codes.js'
import { soulLevelLimit } from '../src/soul-level.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base),
    now = 1800000000
const config = tables.find('soulessence', 10044)
const curve = tables.get('soulessence_level').filter((row) => row.rarity === config.rarity)
const material = Number(
    String(tables.get('game').find((row) => row.title === 'SOULESSENCE_EXP_ITEM').value).split('|')[0],
)
const experience = Number(tables.find('common_item', material).useFunction)
const quantity = Math.ceil(
    (curve.find((row) => row.lv === 31).exp_all - curve.find((row) => row.lv === 30).exp_all) / experience,
)
const goldCost =
    Math.trunc(
        (experience * Number(tables.get('game').find((row) => row.title === 'WEAPON_LEVELUP_GOLD').value)) / 10000,
    ) * quantity
function fixture(filename = ':memory:') {
    const store = new Store(filename),
        game = new Game(protocol, store, tables, { clock: () => now }),
        session = {}
    let seq = 1
    const call = (name, request = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, request) })
    }
    call('EnterGame', { open_id: 'soul-level-current' })
    // Current normal has no preowned essence. Grant just this actual instance
    // through the existing producer; reopening must not create a second one.
    if (!store.load(session.id).state.player.soulessence_infos.soulessences.some((row) => row.id === config.id))
        call('GMCommand', { command: Buffer.from(`give 9 ${config.id} 1`).toString('base64') })
    return {
        store,
        session,
        call,
        state: () => store.load(session.id).state,
        edit: (fn) => store.transact(session.id, 0, fn),
        close: () => store.close(),
    }
}
function prepare(f, level = 20) {
    f.call('GMCommands', {
        cmds: [`give 3 ${material} ${quantity + 10}`, `give 10 2 ${goldCost + 19}`].map((command) => ({
            command: Buffer.from(command).toString('base64'),
        })),
    })
    f.edit((s) => {
        // Explicit already-strengthened/player-progress checkpoint. Materials
        // and currency above have real inventory identities and are then spent.
        const soul = s.player.soulessence_infos.soulessences.find((row) => row.id === config.id)
        Object.assign(soul, { lv: 30, rank: 1, exp: 0 })
        s.player.basic_info.lv = level
    })
    return f.state().player.soulessence_infos.soulessences.find((row) => row.id === config.id).guid
}
const soul = (f, guid) => f.state().player.soulessence_infos.soulessences.find((row) => row.guid === guid)

test('current1.0 condition ladder replaces saved-rank cap for every actual soul configuration', () => {
    const expected = new Map([
        [1, 30],
        [19, 30],
        [20, 50],
        [29, 50],
        [30, 60],
        [40, 70],
        [50, 80],
        [60, 90],
        [70, 100],
    ])
    for (const row of tables.get('soulessence'))
        for (const [level, cap] of expected) {
            assert.equal(
                soulLevelLimit(tables, { player: { basic_info: { lv: level } } }, { id: row.id, rank: 1 }).cap,
                cap,
            )
            assert.equal(
                soulLevelLimit(tables, { player: { basic_info: { lv: level } } }, { id: row.id, rank: 7 }).cap,
                cap,
            )
        }
})

test('actual6047 client material vector advances beyond old30 cap and charges exact material/XP gold only', () => {
    const f = fixture()
    try {
        const guid = prepare(f),
            before = f.state(),
            old = soul(f, guid),
            packets = f.call('ComposeSoulEssence', { guid, cost_items: [{ id: material, num: quantity }] })
        assert.ok(soul(f, guid).lv >= 31)
        assert.equal(soul(f, guid).rank, old.rank, 'do not invent an automatic serialized rank contract')
        assert.equal(soul(f, guid).lock, old.lock)
        assert.equal(soul(f, guid).wear_hero, old.wear_hero)
        assert.equal(soul(f, guid).guid, guid)
        assert.equal(f.state().player.basic_info.gold, before.player.basic_info.gold - goldCost)
        assert.equal(f.state().player.sbag_infos.items.find((row) => row.itemid === material).itemnum, 10)
        const total = curve.find((row) => row.lv === 30).exp_all + experience * quantity
        assert.equal(curve.find((row) => row.lv === soul(f, guid).lv).exp_all + soul(f, guid).exp, total)
        assert.ok(packets.some((packet) => packet.id === 6047))
        assert.deepEqual(
            protocol.decode('cs.Rewards', packets.find((packet) => packet.id === 6047).payload).rewards,
            [],
        )
    } finally {
        f.close()
    }
})

test('unmet player gate prevents6047 at cap atomically, then player20 can continue through the same request', () => {
    const f = fixture()
    try {
        const guid = prepare(f, 19),
            before = f.state(),
            logs = f.store.db.prepare('SELECT * FROM request_log').all(),
            token = f.store.readCacheToken(f.session.id)
        assert.throws(
            () => f.call('ComposeSoulEssence', { guid, cost_items: [{ id: material, num: quantity }] }),
            (e) => e.code === ErrorCode.SoulEssenceNoConfig,
        )
        assert.deepEqual(f.state(), before)
        assert.deepEqual(f.store.db.prepare('SELECT * FROM request_log').all(), logs)
        assert.equal(f.store.readCacheToken(f.session.id), token)
        f.edit((s) => (s.player.basic_info.lv = 20))
        f.call('ComposeSoulEssence', { guid, cost_items: [{ id: material, num: quantity }] })
        assert.ok(soul(f, guid).lv > 30)
    } finally {
        f.close()
    }
})

test('reply codec failure rolls back the newly unlocked level, material and gold', () => {
    const f = fixture(),
        encode = protocol.encode
    try {
        const guid = prepare(f),
            before = f.state()
        protocol.encode = function (name, value) {
            if (name === 'cs.Rewards') throw Error('soul-level-codec')
            return encode.call(this, name, value)
        }
        assert.throws(
            () => f.call('ComposeSoulEssence', { guid, cost_items: [{ id: material, num: quantity }] }),
            /soul-level-codec/,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        protocol.encode = encode
        f.close()
    }
})

test('real SQLite close/reopen and EnterGame retain post30 level and legacy identity without retired6049', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-soul-current-')),
        filename = path.join(directory, 'state.sqlite')
    let f = fixture(filename)
    try {
        const guid = prepare(f)
        f.call('ComposeSoulEssence', { guid, cost_items: [{ id: material, num: quantity }] })
        const granted = soul(f, guid),
            gold = f.state().player.basic_info.gold
        f.close()
        f = fixture(filename)
        assert.deepEqual(soul(f, guid), granted)
        assert.equal(f.state().player.basic_info.gold, gold)
        assert.ok(soul(f, guid).lv > 30)
        assert.equal(protocol.byName.has('CSProtoRankUpSoulEssence'), false)
    } finally {
        f.close()
        const resolved = fs.realpathSync(directory)
        assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()))
        assert.ok(path.basename(resolved).startsWith('lurukaps-soul-current-'))
        fs.rmSync(resolved, { recursive: true, force: true })
    }
})

test('broken curves, malformed saved rank and unimplemented conditions never silently unlock a cap', () => {
    const rows = tables.get('soulessence_rank'),
        state = { player: { basic_info: { lv: 100 } } },
        item = { id: config.id, rank: 1 }
    const altered = (change) => ({
        get: () => rows.map((row) => (row.relatedId === config.id ? change({ ...row }) : row)),
    })
    assert.throws(
        () =>
            soulLevelLimit(
                altered((row) => ({ ...row, rankLevelLimit: 0 })),
                state,
                item,
            ),
        (e) => e.code === ErrorCode.GameConfig,
    )
    assert.throws(
        () => soulLevelLimit(tables, state, { ...item, rank: 99 }),
        (e) => e.code === ErrorCode.GameConfig,
    )
    assert.throws(
        () =>
            soulLevelLimit(
                altered((row) => ({ ...row, condition: '2007|12345' })),
                state,
                item,
            ),
        (e) => e.code === ErrorCode.FunctionClosed,
    )
})
