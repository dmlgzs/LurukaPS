import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables, seedPlayer } from '../src/player.js'
import { ActivityCatalog } from '../src/activities.js'
import { activityGuideIssues, activityValid } from '../src/activity-access.js'
import { permanentModel, permanentPayload } from '../src/growup-permanent.js'
import { GrowupSystem } from '../src/growup.js'
import { preparePamiMail, pamiMailSnapshot, pamiCoverage } from '../src/pami-mail.js'
import { ErrorCode } from '../src/error-codes.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'

const tables = new Tables(configuration().tables)
const now = 1800000000
const unlocked = () => {
    const state = seedPlayer(tables, 1, 'activity-current')
    state.player.basic_info.lv = 99
    state.taskRecords = tables
        .get('task')
        .filter((x) => x.id !== 404002)
        .map((x) => ({ task_id: x.id, count: 1 }))
    return state
}

test('current dangling guide is diagnosed without replacing its ID or blocking the valid cultivation guide', () => {
    const catalog = new ActivityCatalog(tables),
        state = unlocked()
    assert.deepEqual(catalog.guideIssues.get(60002), [
        { table: 'task', id: 900001 },
        { table: 'dungeon', id: 230 },
    ])
    assert.deepEqual(activityGuideIssues(tables, tables.find('game_events', 60001)), [])
    assert.deepEqual(catalog.ensureGuideTasks(state, now), [404002])
    assert(state.tasks.some((x) => x.task_id === 404002))
    assert(!state.tasks.some((x) => x.task_id === 900001))
    assert(!catalog.taskDone(state, 900001))
    assert.deepEqual(catalog.ensureGuideTasks(state, now), [])
    const saved = { privateHistory: { score: 77 } }
    state.activities = { 60002: structuredClone(saved) }
    assert.throws(
        () => catalog.require(state, now, 60002, [60]),
        (e) => e.code === ErrorCode.TaskConfFail,
    )
    assert.deepEqual(state.activities[60002], saved)
    const snapshot = catalog.snapshot(state, now)
    assert(!snapshot.confs.some((x) => x.activity_id === 60002))
    assert(snapshot.del_activitys.includes(60002))
    assert(!snapshot.del_activitys.includes(60001))
    assert(snapshot.confs.some((x) => x.activity_id === 60001))
    assert.deepEqual(state.activities[60002], saved)
    assert(!snapshot.activitys.some((x) => x.id === 60002))
    assert(snapshot.activitys.some((x) => x.id === 60001 && x.data.grow_up))
})

test('declared task data read failures propagate instead of turning into unavailable capabilities', () => {
    const bad = {
        get: tables.get.bind(tables),
        find(name, id) {
            if (name === 'task') throw Error('broken task JSON')
            return tables.find(name, id)
        },
    }
    assert.throws(() => activityGuideIssues(bad, tables.find('game_events', 60002)), /broken task JSON/)
})

test('current zero-level cultivation rows remain presentation only while all paid levels compile', () => {
    const system = new GrowupSystem(tables),
        model = permanentModel(system, 60001)
    assert.equal(
        tables.get('game_events_cul_excultivation').filter((x) => x.eventsid === 60001 && x.lvl === 0).length,
        18,
    )
    assert.equal(model.groups.size, 18)
    assert.equal(
        [...model.groups.values()].reduce((sum, g) => sum + g.rows.size, 0),
        72,
    )
    assert([...model.groups.values()].every((g) => !g.rows.has(0) && g.rows.has(1)))
    const entry = {}
    assert(permanentPayload(system, entry, 60001, 1).levels.datas.every((x) => x.level === 1))
    assert.deepEqual(permanentPayload(system, entry, 60001, 1).roster.excultivation_assist_chars, [])
    assert.deepEqual(entry, {})
    const bad = {
        get(name) {
            return name === 'game_events_cul_excultivation'
                ? tables.get(name).map((r) => (r.eventsid === 60001 && r.lvl === 0 ? { ...r, cost: '10#1002#1' } : r))
                : tables.get(name)
        },
    }
    assert.throws(
        () => permanentModel(new GrowupSystem(bad), 60001),
        (e) => e.code === ErrorCode.GameConfig,
    )
})

test('Pami activity-open conditions deliver invitations when current gates change without finishing guide tasks', () => {
    const state = seedPlayer(tables, 1, 'pami-current')
    state.taskRecords = [{ task_id: 106010, count: 1 }]
    preparePamiMail(tables, state, now)
    const letters = () => pamiMailSnapshot(tables, state, now).mail_tab.flatMap((x) => x.contents)
    assert(!letters().some((x) => [30201, 30301].includes(x.mail_id)))
    assert.equal(activityValid(tables, tables.find('game_events', 60001), state, now), false)
    state.taskRecords.push({ task_id: 102025, count: 1 })
    preparePamiMail(tables, state, now)
    assert(letters().some((x) => x.mail_id === 30201))
    assert(!letters().some((x) => x.mail_id === 30301))
    state.taskRecords.push({ task_id: 102035, count: 1 })
    preparePamiMail(tables, state, now)
    assert(!letters().some((x) => x.mail_id === 30301))
    assert.equal(activityValid(tables, tables.find('game_events', 60002), state, now), false)
    const before = structuredClone(state.pamiMail)
    assert.equal(preparePamiMail(tables, state, now), false)
    assert.deepEqual(state.pamiMail, before)
    assert(!state.taskRecords.some((x) => [404002, 900001].includes(x.task_id)))
    assert.deepEqual(
        pamiCoverage(tables).rejected.map((x) => x.id),
        [12385],
    )
    state.pamiMail.letters[30301] = {
        mail_id: 30301,
        hero_id: '0',
        timestamp: now,
        latest_read: false,
        reply: [{ text_id: tables.find('pami_letter_list', 30301).firstId, record: 0, timestamp: now }],
        reward: [],
        args: [],
    }
    state.pamiMail.revision++
    const saved = structuredClone(state.pamiMail.letters[30301])
    preparePamiMail(tables, state, now)
    assert.deepEqual(state.pamiMail.letters[30301], saved)
    assert(letters().some((x) => x.mail_id === 30301))
})

test('current 10437 restores a selected cultivation cycle and republishes real caches without rerolling on reentry', () => {
    const protocol = new Protocol(configuration().base),
        store = new Store(':memory:'),
        session = {},
        game = new Game(protocol, store, tables, { clock: () => now, rng: () => 0 })
    let seq = 1
    const call = (name, request = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        assert(entry, 'test uses a current registered protocol')
        return game.dispatch(session, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, request) })
    }
    try {
        call('EnterGame', { open_id: 'cultivation-current-entry' })
        store.transact(session.id, 0, (state) => {
            state.taskRecords = tables.get('task').map((x) => ({ task_id: x.id, count: 1 }))
            state.tasks = []
        })
        assert.throws(
            () => call('ActivityGrowUpEnterReq', { activity_id: 60001 }),
            (e) => e.code === ErrorCode.ActivityGrowUpInvalidStage,
        )
        call('ActivityGrowUpStartSelectReq', { activity_id: 60001, starting_id: 101, select_assist_char_ids: [] })
        const before = store.load(session.id).state.activities[60001].growup,
            packets = call('ActivityGrowUpEnterReq', { activity_id: 60001 }),
            activity = protocol.byName.get('CSProtoActivitySync'),
            sync = protocol.decode(activity.rsp, packets.find((x) => x.id === activity.id).payload)
        assert(sync.activitys.find((x) => x.id === 60001)?.data.grow_up)
        assert(packets.some((x) => x.id === protocol.byName.get('CSProtoSyncGrowupTrainAssistCharData').id))
        assert.deepEqual(store.load(session.id).state.activities[60001].growup, before)
        call('ActivityGrowUpEnterReq', { activity_id: 60001 })
        assert.deepEqual(store.load(session.id).state.activities[60001].growup, before)
        assert.throws(
            () => call('ActivityGrowUpEnterReq', { activity_id: 60002 }),
            (e) => e.code === ErrorCode.TaskConfFail,
        )
    } finally {
        store.close()
    }
})

test('current 10431 validates quick-unlock gates, persists its own flag, and supports a real cultivation run without forging the main task', () => {
    const protocol = new Protocol(configuration().base),
        store = new Store(':memory:'),
        session = {},
        game = new Game(protocol, store, tables, { clock: () => now, rng: () => 0 })
    let seq = 1
    const call = (name, request = {}, who = session) => {
        const entry = protocol.byName.get('CSProto' + name)
        assert(entry)
        return game.dispatch(who, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, request) })
    }
    try {
        call('EnterGame', { open_id: 'activity-quick-current' })
        store.transact(session.id, 0, (state) => {
            state.taskRecords = [{ task_id: 106010, count: 1 }]
            state.tasks = []
        })
        const player = structuredClone(store.load(session.id).state.player)
        assert.throws(
            () => call('ActivityConditionOpen', { u32: 60001 }),
            (e) => e.code === ErrorCode.ActivityQuickUnlockNotAllow,
        )
        store.transact(session.id, 0, (state) =>
            state.taskRecords.push({ task_id: 106015, count: 1 }, { task_id: 404002, count: 1 }),
        )
        const packets = call('ActivityConditionOpen', { u32: 60001 }),
            syncType = protocol.byName.get('CSProtoActivitySync'),
            snapshot = protocol.decode(syncType.rsp, packets.find((x) => x.id === syncType.id).payload)
        assert.equal(snapshot.activitys.find((x) => x.id === 60001).quick_unlock_status, 1)
        const state = () => store.load(session.id).state
        assert.deepEqual(state().player, player)
        assert(!state().taskRecords.some((x) => x.task_id === 102025))
        assert.equal(game.activities.active(tables.find('game_events', 60001), state(), now), true)
        assert(state().pamiMail.letters[30201])
        call('ActivityConditionOpen', { u32: 60001 })
        assert.deepEqual(state().player, player)
        call('ActivityGrowUpStartSelectReq', { activity_id: 60001, starting_id: 101 })
        const run = structuredClone(state().activities[60001].growup)
        call('ActivityGrowUpEnterReq', { activity_id: 60001 })
        call('EnterGame', { open_id: 'activity-quick-current' }, {})
        assert.equal(state().activities[60001].quick_unlock_status, 1)
        assert.deepEqual(state().activities[60001].growup, run)
        assert(!state().taskRecords.some((x) => x.task_id === 102025))
        assert.throws(
            () => call('ActivityConditionOpen', { u32: 60002 }),
            (e) => e.code === ErrorCode.TaskConfFail,
        )
    } finally {
        store.close()
    }
})
