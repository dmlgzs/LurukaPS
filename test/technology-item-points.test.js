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
import { grantRewards } from '../src/rewards.js'
import { technologyPoints } from '../src/technology.js'

function fixture(file = ':memory:') {
    const config = configuration(),
        tables = new Tables(config.tables),
        protocol = new Protocol(config.base)
    const store = new Store(file),
        game = new Game(protocol, store, tables),
        session = {}
    let seq = 1
    const call = (name, request = {}, target = session) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(target, {
            id: entry.id,
            seq: seq++,
            pushSeq: 0,
            payload: protocol.encode(entry.req, request),
        })
    }
    call('EnterGame', { open_id: 'technology-items-b328' })
    const state = () => store.load(session.id).state
    const edit = (fn) => store.transact(session.id, 0, fn)
    const reply = (packets, name) => {
        const entry = protocol.byName.get('CSProto' + name),
            packet = packets.find((p) => p.id === entry.id)
        assert(packet)
        return protocol.decode(entry.rsp, packet.payload)
    }
    const stock = (items) =>
        edit((s) => {
            s.player.sbag_infos.items = items.map(([itemid, itemnum]) => ({ itemid, itemnum }))
        })
    return { tables, protocol, store, game, session, call, state, edit, reply, stock }
}
const points = (s) => Number(s.player.attr_infos.attrs.find((a) => a.attr_id === 205)?.attr_val)
function rejects(f, req, code, name = 'UseItem') {
    const before = f.store.load(f.session.id),
        saved = f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id)
    assert.throws(
        () => f.call(name, req),
        (e) => e.code === code,
    )
    assert.deepEqual(f.store.load(f.session.id), before)
    assert.deepEqual(
        f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
        saved,
    )
}
function legacy(f, { level, credit, spent }) {
    // Explicit pre-0350 saved-state fixture: no managed marker and independent 205 credit.
    f.edit((s) => {
        s.player.basic_info.lv = level
        s.home.technology.spent = spent
        delete s.home.technology.pointLedger
        delete s.technologyPointVersion
        s.player.attr_infos.attrs = s.player.attr_infos.attrs.filter((a) => a.attr_id !== 205)
        s.player.attr_infos.attrs.push({ attr_id: 205, attr_val: String(credit) })
    })
}

test('all actual useType20 denominations use6030 and return one205 reward with Home and attribute sync before ACK', () => {
    const f = fixture()
    try {
        const rows = f.tables.get('common_item').filter((r) => r.useType === 20)
        assert.deepEqual(
            rows.map((r) => Number(r.useFunction)).sort((a, b) => a - b),
            [5, 10, 20],
        )
        f.stock(rows.map((r) => [r.id, 1]))
        let expected = 0
        for (const row of rows) {
            const packets = f.call('UseItem', { itemid: row.id, num: 1 })
            expected += Number(row.useFunction)
            assert.deepEqual(
                f
                    .reply(packets, 'UseItem')
                    .rewards.map(({ itemtype, itemid, itemnum }) => ({ itemtype, itemid, itemnum })),
                [{ itemtype: 10, itemid: 205, itemnum: Number(row.useFunction) }],
            )
            const home = f.reply(packets, 'HomeSync').technology
            assert.equal(home.point, expected)
            assert.equal(home.totalPoint, expected)
            assert.equal(points(f.state()), expected)
            assert(packets.findIndex((p) => p.id === 6102) < packets.findIndex((p) => p.id === 6030))
            assert(packets.findIndex((p) => p.id === 10006) < packets.findIndex((p) => p.id === 6030))
            assert(!packets.some((p) => p.id === 6205), 'No second point-reward presentation push')
        }
    } finally {
        f.store.close()
    }
})

test('shared6038 mixed gifts stamina and points preserves every reward and aggregates duplicate point costs', () => {
    const f = fixture()
    try {
        f.stock([
            [5200001, 3],
            [5200002, 1],
            [1520010, 1],
            [100000, 1],
        ])
        f.edit((s) => {
            s.player.attr_infos.attrs.find((a) => a.attr_id === 3).attr_val = '0'
        })
        const packets = f.call('BatchUseItem', {
            items: [
                { itemid: 1520010, num: 1 },
                { itemid: 5200001, num: 1 },
                { itemid: 100000, num: 1 },
                { itemid: 5200002, num: 1 },
                { itemid: 5200001, num: 2 },
            ],
        })
        const rewards = f.reply(packets, 'BatchUseItem').rewards
        assert.equal(rewards.filter((r) => r.itemid === 205).length, 1)
        assert.equal(rewards.find((r) => r.itemid === 205).itemnum, 25)
        assert(rewards.some((r) => r.itemid === 3 && r.itemnum === 60))
        assert(rewards.some((r) => r.itemid === 2 && r.itemnum === 5000))
        assert(rewards.some((r) => r.itemid === 400001 && r.itemnum === 15))
        assert.equal(points(f.state()), 25)
        assert.equal(f.state().player.sbag_infos.items.find((r) => r.itemid === 5200001).itemnum, 0)
        rejects(
            f,
            {
                items: [
                    { itemid: 5200001, num: 1 },
                    { itemid: 1520010, num: 1 },
                ],
            },
            ErrorCode.ItemNotEnough,
            'BatchUseItem',
        )
    } finally {
        f.store.close()
    }
})

test('legacy L W S migration preserves credit once, spends one balance, and survives actual SQLite reopen and level growth', () => {
    const parent = path.resolve(os.tmpdir()),
        dir = fs.mkdtempSync(path.join(parent, 'technology-b328-'))
    let f
    try {
        const file = path.join(dir, 'state.sqlite')
        f = fixture(file)
        legacy(f, { level: 6, credit: 5, spent: 1 })
        let packets = f.call('EnterGame', { open_id: 'technology-items-b328' }, {})
        assert.equal(f.reply(packets, 'HomeSync').technology.totalPoint, 6)
        assert.equal(points(f.state()), 5)
        f.call('HomeTechnologyLevelUp', { type: 1, subType: 10020 })
        assert.equal(f.state().home.technology.spent, 2)
        assert.equal(points(f.state()), 4)
        assert.equal(f.state().home.technology.pointLedger.extraTotal, 5)
        f.store.close()
        f = fixture(file)
        assert.equal(points(f.state()), 4)
        assert.equal(f.state().home.technology.pointLedger.extraTotal, 5)
        // Actual shared reward producer upgrades level6 ->7; no synthetic point credit.
        f.edit((s) =>
            grantRewards(f.tables, s, [{ itemtype: 10, itemid: 10, itemnum: f.tables.find('player_level', 6).exp }]),
        )
        packets = f.call('EnterGame', { open_id: 'technology-items-b328' }, {})
        assert.equal(f.reply(packets, 'HomeSync').technology.totalPoint, 7)
        assert.equal(points(f.state()), 5)
        assert.equal(f.state().home.technology.pointLedger.extraTotal, 5)
    } finally {
        f?.store.close()
        const resolved = path.resolve(dir)
        assert.equal(path.dirname(resolved), parent)
        assert(path.basename(resolved).startsWith('technology-b328-'))
        fs.rmSync(resolved, { recursive: true, force: true })
    }
})

test('old overspent and level-down records retain S and zero clamp, and new credit does not forgive historical spend', () => {
    const f = fixture()
    try {
        legacy(f, { level: 5, credit: 2, spent: 7 })
        f.call('EnterGame', { open_id: 'technology-items-b328' }, {})
        assert.equal(points(f.state()), 0)
        assert.equal(f.state().home.technology.spent, 7)
        f.stock([[5200001, 1]])
        f.call('UseItem', { itemid: 5200001, num: 1 })
        assert.equal(points(f.state()), 0)
        assert.equal(f.state().home.technology.pointLedger.extraTotal, 7)
        f.edit((s) => {
            s.player.basic_info.lv = 6
        })
        f.call('EnterGame', { open_id: 'technology-items-b328' }, {})
        assert.equal(points(f.state()), 1)
        f.edit((s) => {
            s.player.basic_info.lv = 1
        })
        f.call('EnterGame', { open_id: 'technology-items-b328' }, {})
        assert.equal(points(f.state()), 0)
        assert.equal(f.state().home.technology.spent, 7)
    } finally {
        f.store.close()
    }
})

test('managed missing ledger or tampered mirror never reimports a level mirror as independent credit', () => {
    const f = fixture()
    try {
        f.stock([[5200001, 1]])
        f.edit((s) => {
            s.player.basic_info.lv = 20
        })
        f.call('EnterGame', { open_id: 'technology-items-b328' }, {})
        f.edit((s) => {
            delete s.home.technology.pointLedger
        })
        rejects(f, { itemid: 5200001, num: 1 }, ErrorCode.GameConfig)
        f.edit((s) => {
            s.home.technology.pointLedger = { version: 1, extraTotal: 0, levelTotal: 15 }
            s.player.attr_infos.attrs.find((a) => a.attr_id === 205).attr_val = '999'
        })
        rejects(f, { itemid: 5200001, num: 1 }, ErrorCode.GameConfig)
    } finally {
        f.store.close()
    }
})

test('quantity args unknown type stock corrupt definitions and uint32 overflow are atomic named failures', () => {
    const f = fixture()
    try {
        f.stock([[5200001, 10]])
        for (const [req, code] of [
            [{ itemid: 5200001, num: 0 }, ErrorCode.UseItemSendNumZero],
            [{ itemid: 5200001, num: 1, args: ['1'] }, ErrorCode.UseItemArgFail],
            [{ itemid: 5200001, num: 11 }, ErrorCode.ItemNotEnough],
            [{ itemid: 999999, num: 1 }, ErrorCode.ItemCannotFound],
            [{ itemid: 2020001, num: 1 }, ErrorCode.FunctionClosed],
        ])
            rejects(f, req, code)
        const row = f.tables.find('common_item', 5200001),
            old = row.useFunction
        for (const bad of ['', '0', '1.5', '-1', '4294967296']) {
            row.useFunction = bad
            rejects(f, { itemid: 5200001, num: 1 }, ErrorCode.GameConfig)
        }
        row.useFunction = old
        legacy(f, { level: 1, credit: 0xffffffff, spent: 0 })
        rejects(f, { itemid: 5200001, num: 1 }, ErrorCode.GameConfig)
        f.edit((s) => {
            s.player.attr_infos.attrs.push({ attr_id: 205, attr_val: '1' })
        })
        rejects(f, { itemid: 5200001, num: 1 }, ErrorCode.GameConfig)
    } finally {
        f.store.close()
    }
})

test('actual shared typed205 credit is projected and invalid shared credit cannot partially write its ledger', () => {
    const f = fixture()
    try {
        f.edit((s) => grantRewards(f.tables, s, [{ itemtype: 10, itemid: 205, itemnum: 9 }]))
        assert.deepEqual(technologyPoints(f.tables, f.state()), { total: 9, available: 9 })
        assert.equal(points(f.state()), 9)
        const before = f.store.load(f.session.id)
        assert.throws(
            () => f.edit((s) => grantRewards(f.tables, s, [{ itemtype: 10, itemid: 205, itemnum: 0xffffffff }])),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.store.load(f.session.id), before)
    } finally {
        f.store.close()
    }
})

test('Home Player Rewards codec faults and late SQLite failure roll back inventory credit ledger and saved state together', () => {
    const f = fixture(),
        encode = f.protocol.encode
    try {
        f.stock([
            [5200001, 1],
            [1520010, 1],
        ])
        const before = f.store.load(f.session.id),
            sql = () => f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
            saved = sql()
        for (const type of ['HomeSync', 'SyncPlayerData', 'BatchUseItem'].map(
            (n) => f.protocol.byName.get('CSProto' + n).rsp,
        )) {
            f.protocol.encode = function (name, ...args) {
                if (name === type) throw Error('tech-codec-' + type)
                return encode.call(this, name, ...args)
            }
            assert.throws(
                () =>
                    f.call('BatchUseItem', {
                        items: [
                            { itemid: 5200001, num: 1 },
                            { itemid: 1520010, num: 1 },
                        ],
                    }),
                /tech-codec/,
            )
            assert.deepEqual(f.store.load(f.session.id), before)
            assert.deepEqual(sql(), saved)
            f.protocol.encode = encode
        }
        f.store.db.exec(
            "CREATE TEMP TRIGGER tech_fail BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'tech-sql'); END",
        )
        assert.throws(() => f.call('UseItem', { itemid: 5200001, num: 1 }), /tech-sql/)
        assert.deepEqual(f.store.load(f.session.id), before)
        assert.deepEqual(sql(), saved)
        f.store.db.exec('DROP TRIGGER tech_fail')
        f.call('UseItem', { itemid: 5200001, num: 1 })
        assert.equal(points(f.state()), 5)
    } finally {
        f.protocol.encode = encode
        f.store.close()
    }
})
