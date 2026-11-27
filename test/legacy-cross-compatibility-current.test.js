import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Tables, seedPlayer } from '../src/player.js'
import { Store } from '../src/store.js'
import { Protocol } from '../src/protocol.js'
import { Game } from '../src/game.js'
import { TaskGraphs } from '../src/tasks.js'
import { grantRewards } from '../src/rewards.js'
import { preparedSystemAccess } from '../src/system-access.js'
import { ErrorCode } from '../src/error-codes.js'
import policy from '../configs/item-shortcut-compatibility.json' with { type: 'json' }

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base),
    graphs = new TaskGraphs(tables)
const quick = tables.get('common_item').filter((r) => r.isQuickBar === 1)
const recharge = tables.get('mall_recharge_diamond').find((r) => r.rechargeDiamondNum === 6480)
const oldTask = () => ({
    task_id: 206022,
    nodes: [{ node_id: 3, node_values: [0], client_before: false, client_cond_after: [false] }],
    finish_nodes: [1],
    reward_nodes: [],
    client_trace: true,
    start_time: 1700000000,
})
const decode = (p) => protocol.decode(protocol.byId.get(p.id).rsp, p.payload)
const shortcutRows = (ps) => ps.filter((p) => p.id === 6568).map((p) => decode(p).item_infos ?? [])
function validPackets(ps) {
    for (const p of ps) {
        if (p.id === protocol.byName.get('CSProtoTaskSync').id) {
            for (const task of decode(p).tasks ?? []) {
                const g = graphs.get(task.task_id)
                for (const n of task.nodes ?? []) assert(g.nodes.has(n.node_id))
                for (const n of [...(task.finish_nodes ?? []), ...(task.reward_nodes ?? [])]) assert(g.nodes.has(n))
            }
        }
        if (p.id === 6568)
            for (const row of decode(p).item_infos ?? [])
                assert(tables.find('common_item', row.item_id)?.isQuickBar === 1)
        if (p.id === 9970)
            for (const tab of decode(p).mail_tab ?? [])
                for (const letter of tab.contents ?? []) {
                    const row = tables.find('pami_letter_list', letter.mail_id),
                        group = tables.find('pami_letter_group', row?.groupId)
                    assert.equal(group?.categoryId, tab.mail_type)
                    assert.equal(tables.find('pami_letter_text', row.firstId)?.letterId, row.id)
                }
    }
}
let accountNumber = 0
function fixture(offset = 0) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-combined-legacy-')),
        file = path.join(directory, 'synthetic.sqlite'),
        account = 'combined-legacy-' + ++accountNumber
    let store = new Store(file),
        game,
        session = {},
        seq = 1,
        now = 1800000000
    store.login(account, (id, openId) => {
        const s = seedPlayer(tables, id, openId)
        delete s.starterProfile
        delete s.normalStarterAvatar
        s.characterCustomized = true
        s.player.basic_info.lock_system = []
        return s
    })
    const start = () => {
        game = new Game(protocol, store, tables, { clock: () => now, offlinePayments: true, rng: () => 0 })
        session = {}
    }
    const call = (name, request = {}) => {
        const e = protocol.byName.get('CSProto' + name),
            ps = game.dispatch(session, {
                id: e.id,
                seq: seq++,
                payload: e.req ? protocol.encode(e.req, request) : Buffer.alloc(0),
            })
        validPackets(ps)
        return ps
    }
    const state = () => store.load(session.id).state
    const enter = () => call('EnterGame', { open_id: account, reconnect: true })
    start()
    enter()
    // A real public producer supplies a real pre-existing paid receipt. This is
    // local simulation only, not SDK or real money, and will not be replayed on
    // each login. The following database is an explicitly composed old-save test.
    const payRequest = {
        purchase_sdk_id: recharge.purchaseSdkID,
        buy_count: 1,
        product_id: `lurukaps-offline:combo-receipt-${accountNumber}:local`,
        amount: '0',
    }
    call('NonMallCreatePayOrder', payRequest)
    const paidReceipt = structuredClone(state().mall.localOrders),
        paidRecords = structuredClone(state().mall.recharges)
    const currentTasks = structuredClone(state().tasks)
    assert(currentTasks.some((t) => t.task_id === 106001 && t.nodes.some((n) => n.node_id === 5)))
    assert(!currentTasks.some((t) => t.task_id === 206022))
    const identities = policy.retiredIds.slice(offset, offset + 6),
        legacyRows = identities.map((item_id, i) => ({ slot_id: i + 1, item_id }))
    assert.equal(legacyRows.length, 6)
    store.transact(session.id, 0, (s) => {
        // Explicit pre-SystemUnlocks legacy serialization: retain its prior open
        // bitmap, not a hidden second open set. No paid/task/claim fact is removed.
        delete s.systemUnlockProgress
        assert.deepEqual(s.player.basic_info.lock_system, [])
        grantRewards(tables, s, [{ itemtype: 1, itemid: 112002, itemnum: 1 }])
        s.player.heros_info.heros.find((h) => h.conf_id === 112002 && !h.trail).favorability_lv = 9
        s.tasks.push(oldTask())
        s.taskEpochs ??= {}
        s.taskEpochs[206022] = 1
        s.taskTraceChoices ??= {}
        s.taskTraceChoices['206022:1'] = true
        s.taskRecords ??= []
        s.taskRecords.push({ task_id: 996002, count: 1, time: 1699999999 })
        // Only identity/stock/layout with the owner's verified old writer source.
        // No useFunction/old table is made available to the current runtime.
        let next = BigInt(s.nextItemGuid ?? '1')
        for (const id of identities) {
            s.player.sbag_infos.items.push({
                guid: String(next++),
                itemtype: 3,
                itemid: id,
                itemnum: 1,
                deadtime: id === identities[0] ? now + 1 : 0,
            })
        }
        s.nextItemGuid = String(next)
        s.itemShortcuts = structuredClone(legacyRows)
    })
    const original = structuredClone(state()),
        accountId = session.id
    assert.equal(original.systemUnlockProgress, undefined)
    assert.equal(original.itemShortcutCompatibility, undefined)
    assert.equal(original.compatibilityDiagnostics?.suspendedTasks?.['206022:1'], undefined)
    store.close()
    store = new Store(file)
    start()
    return {
        directory,
        file,
        account,
        accountId,
        original,
        currentTasks,
        identities,
        legacyRows,
        paidReceipt,
        paidRecords,
        payRequest,
        call,
        enter,
        state,
        get store() {
            return store
        },
        get game() {
            return game
        },
        get session() {
            return session
        },
        raw: () => structuredClone(store.load(accountId)),
        sql: () => store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(accountId),
        reopen: () => {
            store.close()
            store = new Store(file)
            start()
            return enter()
        },
        advance: (n) => {
            now += n
        },
        close: () => {
            store.close()
            assert(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep))
            fs.rmSync(directory, { recursive: true, force: true })
        },
    }
}
const taskArchive = (f) => f.state().compatibilityDiagnostics.suspendedTasks['206022:1']
const oldStock = (f) => f.state().player.sbag_infos.items.filter((r) => f.identities.includes(r.itemid))
function assertPreserved(f) {
    assert.deepEqual(taskArchive(f).task, oldTask())
    assert.deepEqual(f.state().tasks, f.currentTasks)
    assert.equal(f.state().taskEpochs[206022], 1)
    assert.equal(f.state().taskTraceChoices['206022:1'], true)
    assert(f.state().taskRecords.some((r) => r.task_id === 996002 && r.count === 1))
    assert.deepEqual(f.state().mall.localOrders, f.paidReceipt)
    assert.deepEqual(f.state().mall.recharges, f.paidRecords)
    assert.deepEqual(
        oldStock(f),
        f.original.player.sbag_infos.items.filter((r) => f.identities.includes(r.itemid)),
    )
    assert.equal(f.state().world.map_id, f.original.world.map_id)
}
function shortcut(f, from, id, to, target = 0) {
    return f.call('ShortcutKeySet', {
        type: 1,
        item: {
            src_item: { slot_id: from, item_id: id },
            ...(to == null ? {} : { tar_item: { slot_id: to, item_id: target } }),
        },
    })
}

const observations = []
test('two legal six-slot legacy cohorts combine206022 suspension, Pami61, real payment receipt and current shortcut replacement through cold/Loaded/tick', () => {
    assert.equal(policy.retiredIds.length, 12)
    for (const offset of [0, 6]) {
        const f = fixture(offset)
        try {
            const ps = f.enter()
            assertPreserved(f)
            const basic = decode(ps.find((p) => p.id === 5001)).data.basic_info
            assert(!(basic.lock_system ?? []).includes(61))
            assert.equal(preparedSystemAccess(tables, f.state(), 61), true)
            assert(
                ps
                    .filter((p) => p.id === 9970)
                    .flatMap((p) => decode(p).mail_tab.flatMap((t) => t.contents ?? []))
                    .some((l) => l.mail_id === 12881),
            )
            assert.deepEqual(f.state().itemShortcuts, f.legacyRows)
            assert.deepEqual(
                f.state().itemShortcutCompatibility.entries.map((e) => e.original),
                f.legacyRows,
            )
            assert(shortcutRows(ps).length > 0)
            for (const rows of shortcutRows(ps)) assert.deepEqual(rows, [])
            const archivedTask = structuredClone(taskArchive(f)),
                archivedItems = structuredClone(f.state().itemShortcutCompatibility)
            validPackets(f.call('MultiCampaignPlayerLoaded'))
            f.advance(86400)
            validPackets(f.game.tick(f.accountId, f.session))
            assertPreserved(f)
            assert.deepEqual(taskArchive(f), archivedTask)
            assert.deepEqual(f.state().itemShortcutCompatibility, archivedItems)
            f.call('PamiMailRead', { u32: 12881 })
            const text = tables.find('pami_letter_text', tables.find('pami_letter_list', 12881).firstId),
                reply = tables.get('pami_letter_reply').find((r) => r.teamId === text.teamId && r.textId === 0)
            assert(reply)
            f.call('PamiMailChoose', { text_id: text.id, reply_id: reply.id })
            const pami = structuredClone(f.state().pamiMail)
            const a = quick[0].id,
                b = quick[1].id
            for (const id of [a, b]) f.call('GMCommand', { command: Buffer.from(`give 3 ${id} 2`).toString('base64') })
            shortcut(f, 0, a, 1)
            shortcut(f, 0, b, 2)
            const swapped = shortcut(f, 1, a, 2, b),
                wire = shortcutRows(swapped).at(-1)
            assert.deepEqual(wire, [
                { slot_id: 1, item_id: b },
                { slot_id: 2, item_id: a },
            ])
            assert.deepEqual(
                f.state().itemShortcuts.filter((r) => r.slot_id >= 3),
                f.legacyRows.slice(2),
            )
            assert.deepEqual(f.state().itemShortcutCompatibility, archivedItems)
            assert.deepEqual(taskArchive(f), archivedTask)
            const before = structuredClone(f.state().mall)
            f.call('NonMallCreatePayOrder', f.payRequest)
            assert.deepEqual(f.state().mall, before)
            const reopened = f.reopen()
            validPackets(reopened)
            assertPreserved(f)
            assert.deepEqual(f.state().pamiMail, pami)
            assert.deepEqual(f.state().itemShortcutCompatibility, archivedItems)
            assert.deepEqual(taskArchive(f), archivedTask)
            assert.deepEqual(shortcutRows(reopened).at(-1), wire)
            observations.push({
                offset,
                retired: f.identities,
                taskEpoch: 1,
                originalTaskPreserved: true,
                paidReceiptIds: Object.keys(f.paidReceipt),
                pami12881Read: true,
                normalSwap: wire,
            })
        } finally {
            f.close()
        }
    }
    const evidenceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-legacy-combination-evidence-'))
    const evidenceFile = path.join(evidenceDirectory, 'COMPOSITE-RESULT.json')
    fs.writeFileSync(evidenceFile, JSON.stringify(observations, null, 2) + '\n')
    console.log('Legacy combination evidence: ' + evidenceFile)
})

test('combined first-login9970 codec and SQLite failure roll back both archives, Pami and the real receipt together before retry', () => {
    const f = fixture(),
        encode = protocol.encode.bind(protocol)
    try {
        const before = f.raw(),
            sql = f.sql(),
            token = f.store.readCacheToken(f.accountId),
            sequences = f.store.db.prepare('SELECT * FROM sequences ORDER BY name').all()
        protocol.encode = (name, data) => {
            if (name === protocol.byId.get(9970).rsp) throw Error('combined Pami codec')
            return encode(name, data)
        }
        assert.throws(() => f.enter(), /combined Pami codec/)
        protocol.encode = encode
        assert.deepEqual(f.raw(), before)
        assert.deepEqual(f.sql(), sql)
        assert.equal(f.store.readCacheToken(f.accountId), token)
        assert.deepEqual(f.store.db.prepare('SELECT * FROM sequences ORDER BY name').all(), sequences)
        f.store.db.exec(
            "CREATE TEMP TRIGGER reject_combined BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'combined SQL failure'); END",
        )
        assert.throws(() => f.enter(), /combined SQL failure/)
        f.store.db.exec('DROP TRIGGER reject_combined')
        assert.deepEqual(f.raw(), before)
        assert.deepEqual(f.sql(), sql)
        assert.deepEqual(f.store.db.prepare('SELECT * FROM sequences ORDER BY name').all(), sequences)
        f.enter()
        assertPreserved(f)
        assert.equal(Object.keys(f.state().compatibilityDiagnostics.suspendedTasks).length, 1)
        assert.equal(f.state().itemShortcutCompatibility.entries.length, 6)
        assert(f.state().pamiMail.letters[12881])
    } finally {
        protocol.encode = encode
        f.close()
    }
})
