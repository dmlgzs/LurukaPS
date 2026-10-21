import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables, seedPlayer } from '../src/player.js'
import { NoviceTasks } from '../src/novice-tasks.js'
import { noviceCounters, recordNoviceCounter } from '../src/novice-counters.js'
import { spendCurrency } from '../src/inventory.js'
import { ErrorCode } from '../src/error-codes.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
const cfg = configuration(),
    tables = new Tables(cfg.tables)
const system = new NoviceTasks(tables)
const fresh = () => seedPlayer(tables, 1, 'novice')
const task = (s, id) =>
    system
        .snapshot(s)
        .groups.flatMap((g) => g.tasks)
        .find((t) => t.task_id === id)

test('current novice tables expose 48 tasks and keep prefilled pets out of capture history', () => {
    const s = fresh()
    assert.equal(system.snapshot(s).groups.length, 9)
    assert.equal(system.tasks.size, 48)
    assert(s.pets.length > 20)
    assert.equal(task(s, 105).task_value, 0)
    assert.equal(task(s, 106).task_value, 1)
    s.petCaptureResults = { a: { guid: '1', pet_id: 102056 } }
    delete s.noviceCounters
    assert.equal(noviceCounters(s).captures, 1)
    recordNoviceCounter(s, 'captures', 1)
    assert.equal(task(s, 105).task_value, 2)
})
test('all 30 guide tasks use current thresholds and completed results survive consuming an entity', () => {
    const s = fresh()
    s.player.basic_info.lv = 30
    s.player.heros_info.heros.forEach((h) => (h.hero_lv = 80))
    s.player.soulessence_infos.soulessences.forEach((e) => (e.lv = 80))
    s.pets.forEach((p) => (p.lv = 80))
    s.noviceCounters = { captures: 20, staminaSpent: 500 }
    const guide = system
        .snapshot(s)
        .groups.filter((g) => g.group_id < 200)
        .flatMap((g) => g.tasks)
    assert.equal(guide.length, 30)
    assert(guide.every((t) => t.task_status === 1))
    s.pets = []
    assert.equal(task(s, 103).task_status, 1)
})
test('temporary heroes and pets do not satisfy owned level requirements', () => {
    const s = fresh()
    s.player.heros_info.heros = [{ hero_lv: 80, trail: true }]
    s.pets = [{ guid: '1', lv: 80 }]
    s.trialGroup = { pets: [{ guid: '1' }] }
    assert.equal(task(s, 101).task_value, 0)
    assert.equal(task(s, 103).task_value, 0)
})
test('stamina counts only successful currency-3 spending, never balances or other currencies', () => {
    const s = fresh()
    s.player.attr_infos.attrs.push({ attr_id: 3, attr_val: '100' })
    spendCurrency(s, 3, 50)
    assert.equal(task(s, 104).task_status, 1)
    assert.equal(noviceCounters(s).staminaSpent, 50)
    assert.throws(
        () => spendCurrency(s, 3, 51),
        (e) => e.code === ErrorCode.ItemNotEnough,
    )
    assert.equal(noviceCounters(s).staminaSpent, 50)
    s.player.basic_info.gold = 1
    spendCurrency(s, 2, 1)
    assert.equal(noviceCounters(s).staminaSpent, 50)
})
test('duel task thresholds are not fabricated from clear records; successor unlock checks actual task records', () => {
    const s = fresh()
    s.kiboDuelRecords = { 501: { star: 7, success_time: 1 } }
    assert.equal(system.value(s, system.tasks.get(5101)), null)
    system.ledger(s).claimedGroups[201] = true
    assert.equal(system.unlocked(s, system.groups.get(202)), false)
    s.taskRecords = [{ task_id: 991002, count: 1 }]
    assert.equal(system.unlocked(s, system.groups.get(202)), true)
})
test('10762 persists a single receipt, synchronizes statuses, rolls back invalid rewards and survives relogin', () => {
    const protocol = new Protocol(cfg.base),
        store = new Store(':memory:'),
        game = new Game(protocol, store, tables),
        session = {}
    let seq = 1
    const call = (name, data = {}, who = session) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(who, { id: e.id, seq: seq++, payload: protocol.encode(e.req, data) })
    }
    const result = (packets) => protocol.decode(protocol.byId.get(10762).rsp, packets.at(-1).payload)
    const state = () => store.load(session.id).state
    try {
        const login = call('EnterGame', { open_id: 'novice' })
        assert(login.some((p) => p.id === 10761))
        assert.throws(
            () => call('NoviceTaskFinish', { u32: 106 }),
            (e) => e.code === ErrorCode.NoviceTaskNotFinished,
        )
        assert.throws(
            () => call('NoviceTaskFinish', { u32: 206 }),
            (e) => e.code === ErrorCode.NoviceTaskLock,
        )
        assert.throws(
            () => call('NoviceTaskFinish', { u32: 999 }),
            (e) => e.code === ErrorCode.NoviceTaskNotExists,
        )
        assert.throws(
            () => call('NoviceTaskFinish', { u32: 5101 }),
            (e) => e.code === ErrorCode.FunctionClosed,
        )
        store.transact(session.id, 0, (s) => (s.player.basic_info.lv = 10))
        const row = tables.find('novice_task', 106),
            original = row.reward
        const before = structuredClone(state())
        try {
            row.reward = '3#4294967295#1'
            assert.throws(
                () => call('NoviceTaskFinish', { u32: 106 }),
                (e) => e.code === ErrorCode.GameConfig,
            )
            assert.deepEqual(state(), before)
        } finally {
            row.reward = original
        }
        const packets = call('NoviceTaskFinish', { u32: 106 })
        assert(result(packets).rewards.length > 0)
        assert.equal(result(packets).src, 93)
        const sync = packets.find((p) => p.id === 10761)
        assert.equal(
            protocol.decode(protocol.byId.get(10761).rsp, sync.payload).groups[0].tasks.find((t) => t.task_id === 106)
                .task_status,
            2,
        )
        assert.deepEqual(result(call('NoviceTaskFinish', { u32: 106 })).rewards, [])
        call('EnterGame', { open_id: 'novice' }, {})
        assert.deepEqual(result(call('NoviceTaskFinish', { u32: 106 })).rewards, [])
    } finally {
        store.close()
    }
})
