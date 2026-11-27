import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { grantRewards } from '../src/rewards.js'
import { preparedSystemAccess } from '../src/system-access.js'
import { homeCondition } from '../src/home-grid.js'
import { activeFormationManager } from '../src/trial-actors.js'
import { enemyDefinition } from '../src/enemy-state.js'
import { seedPlayer, Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { pamiCoverage } from '../src/pami-mail.js'
import { ErrorCode } from '../src/error-codes.js'

const config = configuration(),
    tables = new Tables(config.tables),
    protocol = new Protocol(config.base)
class PamiConsumer {
    constructor() {
        this.letters = new Map()
    }
    consume(packets, name, request) {
        for (const packet of packets) {
            if (packet.id === 9970) {
                const data = protocol.decode(protocol.byId.get(9970).rsp, packet.payload)
                for (const tab of data.mail_tab ?? [])
                    for (const letter of tab.contents ?? []) {
                        // Current PamiLetter.Populate0601c434 reads groupId
                        // from the list table. MergeData0601c45f then resolves
                        // that group's category; the wire ID is not a hero ID.
                        const row = tables.find('pami_letter_list', letter.mail_id),
                            group = row && tables.find('pami_letter_group', row.groupId)
                        assert(group, 'Pami payload cannot resolve current group')
                        assert.equal(group.categoryId, tab.mail_type)
                        assert(tables.find('pami_letter_category', group.categoryId))
                        assert.equal(tables.find('pami_letter_text', row.firstId)?.letterId, row.id)
                        for (const reply of letter.reply ?? []) {
                            const text = tables.find('pami_letter_text', reply.text_id)
                            assert.equal(text?.letterId, row.id)
                            if (reply.record)
                                assert.equal(tables.find('pami_letter_reply', reply.record)?.teamId, text.teamId)
                        }
                        this.letters.set(letter.mail_id, structuredClone(letter))
                    }
            } else if (packet.id === 9971 && name === 'PamiMailRead') {
                this.letters.get(request.u32).latest_read = true
            } else if (packet.id === 9972 && name === 'PamiMailChoose') {
                // Successful native callback calls ApplyReply0601c462,
                // changing the existing text's reply, never adding a letter.
                for (const letter of this.letters.values()) {
                    const text = letter.reply.find((text) => text.text_id === request.text_id)
                    if (text) {
                        text.record = request.reply_id
                        letter.latest_read = true
                        break
                    }
                }
            }
        }
    }
}

let number = 0
function fixture({ mode = 'normal', qualified = false, file = ':memory:', account = 'pami-access-' + ++number } = {}) {
    let now = 1800000000
    const store = new Store(file),
        game = new Game(protocol, store, tables, { clock: () => now }),
        client = new PamiConsumer()
    store.login(account, (id, openId) => {
        const s = seedPlayer(tables, id, openId)
        if (mode === 'legacy') delete s.starterProfile
        grantRewards(tables, s, [{ itemtype: 1, itemid: 112002, itemnum: 1 }])
        s.player.heros_info.heros.find((h) => h.conf_id === 112002 && !h.trail).favorability_lv = 9
        if (qualified) (s.taskRecords ??= []).push({ task_id: 106010, count: 1, time: 1 })
        return s
    })
    let session = {},
        seq = 1,
        millis = 1800000000000
    const call = (name, request = {}) => {
        const e = protocol.byName.get('CSProto' + name),
            packets = game.dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, request) })
        client.consume(packets, name, request)
        return packets
    }
    const initial = call('EnterGame', { open_id: account })
    const state = () => store.load(session.id).state
    return {
        store,
        game,
        client,
        call,
        initial,
        state,
        account,
        id: () => session.id,
        get session() {
            return session
        },
        advance: (seconds) => {
            now += seconds
        },
        edit: (fn, options) => store.transact(session.id, 0, fn, options),
        raw: () => structuredClone(store.load(session.id)),
        login: () => {
            session = {}
            return call('EnterGame', { open_id: account, reconnect: true })
        },
        hurt: (target) => {
            const m = activeFormationManager(state()),
                g = m.groups.find((g) => g.id === m.cur_group)
            assert(enemyDefinition(tables, state(), target))
            return call('BattleInfoReduce', {
                base_time: String(++millis),
                uint64_dic: [g.control, target],
                battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -1 } }],
            })
        },
    }
}
const decoded = (packet) => protocol.decode(protocol.byId.get(packet.id).rsp, packet.payload)
const contents = (packets) =>
    packets.filter((p) => p.id === 9970).flatMap((p) => decoded(p).mail_tab.flatMap((t) => t.contents ?? []))
const chain = tables
    .get('pami_letter_list')
    .filter((r) => r.groupId === 128)
    .sort((a, b) => a.id - b.id)
const terminal = (text) => tables.get('pami_letter_reply').find((r) => r.teamId === text.teamId && r.textId === 0)
function assertNoReward(f, text) {
    assert.equal(text.reward, '')
    const before = f.raw()
    assert.throws(
        () => f.call('PamiMailReward', { u32: text.id }),
        (e) => e.code === ErrorCode.InvalidArgument,
    )
    assert.deepEqual(f.raw(), before)
}

test('current known Pami sources retain orphan12385 and no attachments; a normal earned profile receives, reads and replies to its actual128 chain across SQLite reopen', () => {
    assert.deepEqual(
        pamiCoverage(tables).rejected.map((r) => r.id),
        [12385],
    )
    assert(tables.get('pami_letter_text').every((t) => t.reward === ''))
    assert.equal(tables.find('pami_letter_list', 30102), undefined)
    assert.equal(tables.find('pami_letter_group', 123), undefined)
    assert.equal(tables.find('pami_letter_text', 1238501), undefined)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pami-current-chain-')),
        file = path.join(dir, 'state.sqlite'),
        account = 'pami-current-reopen'
    let f = fixture({ file, account, qualified: true })
    try {
        assert.equal(f.state().starterProfile.mode, 'normal')
        assert.equal(preparedSystemAccess(tables, f.state(), 61), true)
        assert.equal(contents(f.initial).filter((l) => chain.some((r) => r.id === l.mail_id)).length, 1)
        for (const row of chain) {
            assert(f.client.letters.has(row.id))
            const text = tables.find('pami_letter_text', row.firstId),
                reply = terminal(text)
            assert(reply)
            const read = f.call('PamiMailRead', { u32: row.id })
            assert(read.findIndex((p) => p.id === 9970) < read.findIndex((p) => p.id === 9971))
            assert(f.client.letters.get(row.id).latest_read)
            assertNoReward(f, text)
            const chosen = f.call('PamiMailChoose', { text_id: text.id, reply_id: reply.id })
            assert(chosen.findIndex((p) => p.id === 9972) < chosen.findIndex((p) => p.id === 9970))
            assert.equal(f.client.letters.get(row.id).reply[0].record, reply.id)
            const before = structuredClone(f.state())
            f.call('PamiMailChoose', { text_id: text.id, reply_id: reply.id })
            assert.deepEqual(f.state(), before)
        }
        const letters = structuredClone(f.state().pamiMail),
            player = structuredClone(f.state().player)
        f.store.close()
        f = fixture({ file, account, qualified: true })
        assert.deepEqual(f.state().pamiMail, letters)
        assert.deepEqual(f.state().player, player)
        for (const row of chain) assert.equal(f.client.letters.get(row.id).reply.length, 1)
    } finally {
        f.store.close()
        assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('legacy UI-open Pami category admits the real favor-qualified letter on cold5001 without rechecking obsolete task progress', () => {
    const f = fixture({ mode: 'legacy' })
    try {
        assert.equal(f.state().player.basic_info.lv, 1)
        const basic = decoded(f.initial.find((p) => p.id === 5001)).data.basic_info
        assert(!(basic.lock_system ?? []).includes(60))
        assert(!(basic.lock_system ?? []).includes(61))
        assert.equal(homeCondition(tables.find('system_unlock', 61).unlockCondi, f.state()), false)
        assert.equal(preparedSystemAccess(tables, f.state(), 61), true)
        assert(contents(f.initial).some((l) => l.mail_id === 12881))
        f.call('PamiMailRead', { u32: 12881 })
        assert(f.client.letters.get(12881).latest_read)
    } finally {
        f.store.close()
    }
})

test('normal unearned category remains locked, genuine system notification precedes its first9970, earned access persists, and corrupt authority never falls back', () => {
    const f = fixture()
    try {
        assert.equal(preparedSystemAccess(tables, f.state(), 61), false)
        assert(!contents(f.initial).some((l) => l.mail_id === 12881))
        let before = f.raw()
        assert.throws(
            () => f.call('PamiMailRead', { u32: 12881 }),
            (e) => e.code === ErrorCode.PamiLetterNotFound,
        )
        assert.deepEqual(f.raw(), before)
        const oldRecords = structuredClone(f.state().taskRecords ?? [])
        // Explicit trusted past-task eligibility; not a claim to play the entire
        // main quest in this communication test, and not a letter/claim forgery.
        f.edit((s) => {
            ;(s.taskRecords ??= []).push({ task_id: 106010, count: 1, time: 1 })
        })
        assert.equal(f.state().mall?.popupQueue?.length ?? 0, 0)
        assert.equal(f.state().mall?.pendingPopup, undefined)
        const earned = f.call('GetRechargePopupData')
        const notice = earned.findIndex((p) => p.id === 10600 && decoded(p).unlock_id.includes(61)),
            mail = earned.findIndex((p) => p.id === 9970 && contents([p]).some((l) => l.mail_id === 12881))
        assert(notice >= 0 && mail > notice)
        assert.equal(preparedSystemAccess(tables, f.state(), 61), true)
        f.edit((s) => {
            s.taskRecords = oldRecords
        })
        assert.equal(homeCondition(tables.find('system_unlock', 61).unlockCondi, f.state()), false)
        f.call('PamiMailRead', { u32: 12881 })
        assert(f.client.letters.get(12881).latest_read)
        const good = structuredClone(f.state())
        for (const damage of [
            (s) => {
                s.systemUnlockProgress = null
            },
            (s) => {
                s.systemUnlockProgress.sourceHash = 'bad'
            },
            (s) => {
                s.player.basic_info.lock_system.push(61)
            },
        ]) {
            f.edit((s) => {
                Object.assign(s, structuredClone(good))
                damage(s)
            })
            before = f.raw()
            assert.throws(
                () => f.call('PamiMailRead', { u32: 12881 }),
                (e) => e.code === ErrorCode.GameConfig,
            )
            assert.deepEqual(f.raw(), before)
        }
    } finally {
        f.store.close()
    }
})

test('real deferred battle unlock keeps pending Pami references unchanged through9970 codec and SQL failure, then delivers only once', () => {
    const f = fixture(),
        encode = protocol.encode.bind(protocol)
    try {
        f.call('TaskClientBefore', { task_id: 106001, node_id: 5 })
        const target = ((4n << 56n) | 10600101n).toString()
        f.call('TryCreateWorldObj', { objs: [target] })
        f.hurt(target)
        assert(f.store.pending.has(f.id()))
        f.edit(
            (s) => {
                ;(s.taskRecords ??= []).push({ task_id: 106010, count: 1, time: 1 })
            },
            { defer: true },
        )
        const pending = f.store.pending.get(f.id()),
            pami = pending.state.pamiMail,
            before = f.raw(),
            sql = f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.id())
        protocol.encode = (name, data) => {
            if (name === protocol.byId.get(9970).rsp) throw Error('Pami post-unlock codec')
            return encode(name, data)
        }
        assert.throws(() => f.hurt(target), /Pami post-unlock codec/)
        protocol.encode = encode
        assert.equal(f.store.pending.get(f.id()), pending)
        assert.equal(pending.state.pamiMail, pami)
        assert.deepEqual(f.raw(), before)
        assert.deepEqual(f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.id()), sql)
        f.store.db.exec(
            "CREATE TEMP TRIGGER reject_pami_unlock BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'Pami post-unlock SQL'); END",
        )
        assert.throws(() => f.hurt(target), /Pami post-unlock SQL/)
        f.store.db.exec('DROP TRIGGER reject_pami_unlock')
        assert.equal(f.store.pending.get(f.id()), pending)
        assert.equal(pending.state.pamiMail, pami)
        assert.deepEqual(f.raw(), before)
        const delivered = f.hurt(target)
        assert(contents(delivered).some((l) => l.mail_id === 12881))
        assert.equal(preparedSystemAccess(tables, f.state(), 61), true)
        const ledger = structuredClone(f.state().pamiMail)
        f.hurt(target)
        assert.deepEqual(f.state().pamiMail, ledger)
    } finally {
        protocol.encode = encode
        f.store.close()
    }
})

test('a real day-boundary tick publishes the newly earned Pami category after10600 and repeated ticks neither redeliver nor reset letters', () => {
    const f = fixture()
    try {
        assert.equal(preparedSystemAccess(tables, f.state(), 61), false)
        f.edit((s) => {
            ;(s.taskRecords ??= []).push({ task_id: 106010, count: 1, time: 1 })
        })
        // The task fact is a trusted fixture as above; an actual day transition
        // supplies the tick scheduler's due work. No tick barrier is forged.
        f.advance(86400)
        const packets = f.game.tick(f.id(), f.session)
        f.client.consume(packets)
        const notice = packets.findIndex((p) => p.id === 10600 && decoded(p).unlock_id.includes(61))
        const mail = packets.findIndex((p) => p.id === 9970 && contents([p]).some((l) => l.mail_id === 12881))
        assert(notice >= 0 && mail > notice)
        const saved = structuredClone(f.state().pamiMail)
        for (let i = 0; i < 3; i++) {
            const repeated = f.game.tick(f.id(), f.session)
            assert(!repeated.some((p) => [10600, 9970].includes(p.id)))
            assert.deepEqual(f.state().pamiMail, saved)
        }
    } finally {
        f.store.close()
    }
})
