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
import { grantRewards } from '../src/rewards.js'
import { ErrorCode } from '../src/error-codes.js'

function fixture(file = ':memory:') {
    const config = configuration(),
        tables = new Tables(config.tables),
        protocol = new Protocol(config.base)
    const store = new Store(file),
        game = new Game(protocol, store, tables),
        session = {}
    let seq = 1
    const call = (name, request, target = session) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(target, {
            id: entry.id,
            seq: seq++,
            pushSeq: 0,
            payload: protocol.encode(entry.req, request),
        })
    }
    const login = () => call('EnterGame', { open_id: 'technology-ledger-b335' }, session.id ? {} : session)
    login()
    const state = () => store.load(session.id).state
    const edit = (fn) => store.transact(session.id, 0, fn)
    const home = (packets) => {
        const entry = protocol.byName.get('CSProtoHomeSync'),
            packet = packets.find((p) => p.id === entry.id)
        assert(packet)
        return protocol.decode(entry.rsp, packet.payload).technology
    }
    return { tables, protocol, store, game, session, call, login, state, edit, home }
}
const balance = (s) => Number(s.player.attr_infos.attrs.find((a) => a.attr_id === 205).attr_val)
function oldSave(f, { level = 6, credit = 3, spent = 1 } = {}) {
    // Controlled genuine pre-migration schema: old205 was independent credit;
    // the old study path only updated spent. No manufactured completion facts.
    f.edit((s) => {
        s.player.basic_info.lv = level
        s.home.technology.spent = spent
        delete s.home.technology.pointLedger
        delete s.technologyPointVersion
        s.player.attr_infos.attrs = s.player.attr_infos.attrs.filter((a) => a.attr_id !== 205)
        s.player.attr_infos.attrs.push({ attr_id: 205, attr_val: String(credit) })
    })
}

test('6206 spends the same migrated and shared-granted205 balance while preserving earned total and real node progression', () => {
    const f = fixture()
    try {
        oldSave(f)
        let tech = f.home(f.login())
        assert.equal(tech.totalPoint, 4)
        assert.equal(tech.point, 3)
        assert.equal(balance(f.state()), 3)
        f.edit((s) => grantRewards(f.tables, s, [{ itemtype: 10, itemid: 205, itemnum: 2 }]))
        tech = f.home(f.login())
        assert.equal(tech.totalPoint, 6)
        assert.equal(tech.point, 5)
        const packets = f.call('HomeTechnologyLevelUp', { type: 1, subType: 10020 })
        tech = f.home(packets)
        assert.equal(tech.totalPoint, 6, 'Study consumes availability, never lifetime earned points')
        assert.equal(tech.point, 4)
        const state = f.state()
        assert.equal(balance(state), 4)
        assert.equal(state.home.technology.spent, 2)
        assert.equal(state.home.technology.levels[10020].level, 1)
        const sync = packets.find((p) => p.id === f.protocol.byName.get('CSProtoSyncPlayerData').id)
        assert(sync)
        const player = f.protocol.decode(f.protocol.byName.get('CSProtoSyncPlayerData').rsp, sync.payload)
        assert.equal(player.attr_infos.attrs.find((a) => a.attr_id === 205).attr_val, '4')
        assert.equal(f.home(f.login()).point, 4, 'Repeated login does not import the mirror again')
    } finally {
        f.store.close()
    }
})

test('real SQLite reopen and shared XP preserve old credit and spend; overspent and downgraded saves stay zero without reinflation', () => {
    const parent = path.resolve(os.tmpdir()),
        dir = fs.mkdtempSync(path.join(parent, 'technology-ledger-b335-'))
    let f
    try {
        const file = path.join(dir, 'state.sqlite')
        f = fixture(file)
        oldSave(f)
        f.login()
        f.call('HomeTechnologyLevelUp', { type: 1, subType: 10020 })
        f.store.close()
        f = fixture(file)
        assert.equal(balance(f.state()), 2)
        f.edit((s) =>
            grantRewards(f.tables, s, [{ itemtype: 10, itemid: 10, itemnum: f.tables.find('player_level', 6).exp }]),
        )
        const tech = f.home(f.login())
        assert.equal(tech.totalPoint, 5)
        assert.equal(tech.point, 3)
        assert.equal(balance(f.state()), 3)
        assert.equal(f.state().home.technology.pointLedger.extraTotal, 3)
        assert.equal(f.state().home.technology.spent, 2)
        f.edit((s) => {
            s.player.basic_info.lv = 1
        })
        assert.equal(f.home(f.login()).point, 1)
        oldSave(f, { level: 1, credit: 2, spent: 7 })
        const overspent = f.home(f.login())
        assert.equal(overspent.totalPoint, 2)
        assert.equal(overspent.point, 0)
        assert.equal(f.state().home.technology.spent, 7)
        f.edit((s) => {
            delete s.home.technology.pointLedger
        })
        const before = f.store.load(f.session.id)
        assert.throws(f.login, (e) => e.code === ErrorCode.GameConfig)
        assert.deepEqual(f.store.load(f.session.id), before, 'Missing managed ledger cannot reimport the mirror')
    } finally {
        f?.store.close()
        const resolved = path.resolve(dir)
        assert.equal(path.dirname(resolved), parent)
        assert(path.basename(resolved).startsWith('technology-ledger-b335-'))
        fs.rmSync(resolved, { recursive: true, force: true })
    }
})

test('real6206 Home Player ACK codec failures and late SQL failure roll back level spend mirror and the saved revision together', () => {
    const f = fixture(),
        encode = f.protocol.encode
    try {
        oldSave(f)
        f.login()
        const saved = () =>
            f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id)
        const before = f.store.load(f.session.id),
            sql = saved()
        const unchanged = () => {
            assert.deepEqual(f.store.load(f.session.id), before)
            assert.deepEqual(saved(), sql)
        }
        for (const type of ['HomeSync', 'SyncPlayerData', 'HomeTechnologyLevelUp'].map(
            (n) => f.protocol.byName.get('CSProto' + n).rsp,
        )) {
            f.protocol.encode = function (name, ...args) {
                if (name === type) throw Error('ledger-codec-' + type)
                return encode.call(this, name, ...args)
            }
            assert.throws(() => f.call('HomeTechnologyLevelUp', { type: 1, subType: 10020 }), /ledger-codec/)
            unchanged()
            f.protocol.encode = encode
        }
        f.store.db.exec(
            "CREATE TEMP TRIGGER ledger_fail BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'ledger-sql'); END",
        )
        assert.throws(() => f.call('HomeTechnologyLevelUp', { type: 1, subType: 10020 }), /ledger-sql/)
        unchanged()
        f.store.db.exec('DROP TRIGGER ledger_fail')
        const tech = f.home(f.call('HomeTechnologyLevelUp', { type: 1, subType: 10020 }))
        assert.equal(tech.totalPoint, 4)
        assert.equal(tech.point, 2)
        assert.equal(balance(f.state()), 2)
    } finally {
        f.protocol.encode = encode
        f.store.close()
    }
})
