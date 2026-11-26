import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables, seedPlayer } from '../src/player.js'
import { Store } from '../src/store.js'
import { Protocol } from '../src/protocol.js'
import { Game } from '../src/game.js'
import { TaskGraphs, makeNode } from '../src/tasks.js'
import { activeFormationManager } from '../src/trial-actors.js'
import { enemyDefinition } from '../src/enemy-state.js'
import { SystemUnlocks, parseSystemUnlockCondition, systemUnlockPlayerPacket } from '../src/system-unlocks.js'
import { newStarterProfile } from '../src/starter-profile.js'
import { battleMessageCount } from '../src/battle-message-events.js'
import { ErrorCode } from '../src/error-codes.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
const minimal = (mode, locks = []) => ({
    ...(mode ? { starterProfile: newStarterProfile(mode) } : {}),
    player: { basic_info: { lv: 1, lock_system: locks } },
    tasks: [],
    taskRecords: [],
})
class Consumer {
    locks = new Set()
    events = []
    level = 1
    finished = new Set()
    consume(packets) {
        for (const frame of packets) {
            if ([5001, 5008].includes(frame.id)) {
                const decoded = protocol.decode(protocol.byId.get(frame.id).rsp, frame.payload),
                    player = frame.id === 5001 ? decoded.data : decoded,
                    basic = player?.basic_info
                if (basic?.lv !== undefined) this.level = basic.lv
                if (basic?.lock_system !== undefined) this.locks = new Set(basic.lock_system)
                else if (frame.id === 5001) this.locks.clear()
            }
            if (frame.id === 9853) {
                const data = protocol.decode(protocol.byId.get(frame.id).rsp, frame.payload)
                for (const task of data.tasks ?? [])
                    for (const node of task.finish_nodes ?? []) this.finished.add(task.task_id + ':' + node)
            }
            if (frame.id === 10600) {
                const data = protocol.decode(protocol.byId.get(frame.id).rsp, frame.payload)
                for (const id of data.unlock_id ?? [])
                    if (this.locks.has(id)) {
                        this.locks.delete(id)
                        this.events.push({ id, level: this.level, finished: [...this.finished] })
                    }
            }
        }
    }
    count(id) {
        return this.events.filter((event) => event.id === id).length
    }
}
function fixture(name, mode = 'normal', entry = 'EnterGame') {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => 1800000000 }),
        client = new Consumer()
    let session = {}
    store.login('sys-candidate-' + name, (id, account) => {
        // Marker is assigned by a trusted new-profile factory. This system
        // test does not claim to replace the separately reviewed asset factory.
        const state = seedPlayer(tables, id, account)
        if (mode === 'legacy') delete state.starterProfile
        else state.starterProfile = newStarterProfile(mode)
        return state
    })
    let sequence = 1,
        millis = 1800000000000
    const call = (name, request = {}, peer = session) => {
        const row = protocol.byName.get('CSProto' + name),
            packets = game.dispatch(peer, {
                id: row.id,
                seq: sequence++,
                payload: row.req ? protocol.encode(row.req, request) : Buffer.alloc(0),
            })
        client.consume(packets)
        return packets
    }
    const initial = call(entry, { open_id: 'sys-candidate-' + name })
    const state = () => store.load(session.id).state
    return {
        store,
        game,
        get session() {
            return session
        },
        client,
        call,
        initial,
        state,
        edit: (fn) => store.transact(session.id, 0, fn),
        saved: () => store.load(session.id),
        row: () => JSON.parse(store.db.prepare('SELECT state FROM players WHERE account_id=?').get(session.id).state),
        login: () => {
            session = {}
            return call('EnterGame', { open_id: 'sys-candidate-' + name, reconnect: true })
        },
        hurt: (id) => {
            const m = activeFormationManager(state()),
                g = m.groups.find((row) => row.id === m.cur_group),
                d = enemyDefinition(tables, state(), id)
            return call('BattleInfoReduce', {
                base_time: String(++millis),
                uint64_dic: [g.control, id],
                battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -d.max_hp } }],
            })
        },
    }
}

test('all244 current boolean rules compile; explicit normal/sandbox and marker-absent legacy preserve their own lock policy', () => {
    const service = new SystemUnlocks(tables),
        normal = minimal('normal'),
        sandbox = minimal('sandbox'),
        legacy = minimal(undefined, [3002, 3003])
    service.prepare(normal)
    assert(normal.player.basic_info.lock_system.includes(3003))
    assert(normal.player.basic_info.lock_system.includes(164))
    assert(normal.systemUnlockProgress.unlocked.length >= 89)
    service.prepare(sandbox)
    assert.deepEqual(sandbox.player.basic_info.lock_system, [])
    service.prepare(legacy)
    assert.deepEqual(legacy.player.basic_info.lock_system, [3002, 3003])
    const existing = minimal()
    service.prepare(existing)
    assert.deepEqual(existing.player.basic_info.lock_system, [])
    assert.equal(existing.systemUnlockProgress.profileMode, 'legacy')
    normal.player.basic_info.lv = 10
    normal.taskRecords.push({ task_id: 106010, count: 1 })
    const plan = service.observe(normal)
    assert(plan.ids.includes(53), 'current parenthesized task AND level expression opens dorms')
    service.deliver(normal, [], plan, (name, body) => ({ name, body }))
    normal.player.basic_info.lv = 1
    normal.taskRecords = []
    assert.equal(service.observe(normal), null, 'earned systems never re-lock when facts rewind')
    assert(!normal.player.basic_info.lock_system.includes(53))
    assert.equal(parseSystemUnlockCondition('2004#10||2004#2&&2004#3').right.type, 'and')
    assert.throws(() => service.prepare({ ...minimal(), starterProfile: null }), { code: ErrorCode.GameConfig })
    assert.throws(() => parseSystemUnlockCondition('2004#2|2004#3'), { code: ErrorCode.GameConfig })
})

test('actual normal cold bitmap and level20 deliver old-lock5008 before10600, then later fullbasic preserves the open state', () => {
    const f = fixture('level')
    try {
        assert(f.client.locks.has(510))
        assert(!f.initial.some((frame) => frame.id === 10600), 'cold data is not a replay of unlock events')
        const initial = structuredClone(f.initial),
            packets = f.call('GMCommand', { command: Buffer.from('level 20').toString('base64') }),
            sync = packets.findIndex((frame) => frame.id === 5008),
            event = packets.findIndex((frame) => frame.id === 10600)
        assert(sync >= 0 && event > sync)
        assert(
            packets
                .filter((frame) => frame.id === 5008)
                .every((frame) => {
                    const data = protocol.decode(protocol.byId.get(5008).rsp, frame.payload)
                    return !data.basic_info || data.basic_info.lock_system.includes(510)
                }),
            'the transition cannot be consumed by an automatically encoded final bitmap',
        )
        assert.equal(f.client.count(510), 1)
        assert.equal(f.client.events.find((entry) => entry.id === 510).level, 20)
        assert(!f.state().player.basic_info.lock_system.includes(510))
        const wrong = new Consumer()
        wrong.consume(initial)
        wrong.consume(
            packets.map((frame) => {
                if (frame.id !== 5008) return frame
                const data = protocol.decode(protocol.byId.get(5008).rsp, frame.payload)
                if (data.basic_info) data.basic_info.lock_system = f.state().player.basic_info.lock_system
                return { ...frame, payload: protocol.encode(protocol.byId.get(5008).rsp, data) }
            }),
        )
        assert.equal(wrong.count(510), 0, 'negative control: full final bitmap before10600 loses the real Native event')
        const more = f.call('SkipGuide', { u32: 0 })
        assert(!more.some((frame) => frame.id === 10600))
        const finalSync = more.find((frame) => frame.id === 5008)
        assert(finalSync)
        assert.deepEqual(
            protocol.decode(protocol.byId.get(5008).rsp, finalSync.payload).basic_info.lock_system,
            f.state().player.basic_info.lock_system,
            'later fullbasic and optimizer cache publish final locks',
        )
        assert(!f.client.locks.has(510))
        f.login()
        assert(!f.client.locks.has(510))
        assert.equal(f.client.count(510), 1)
    } finally {
        f.store.close()
    }
})

test('real first-battle HP0 then CondAfter/After opens3000 after TaskSync facts and commits its permanent state even on the deferred task route', () => {
    const f = fixture('node')
    try {
        assert(f.client.locks.has(3000))
        f.call('TaskClientBefore', { task_id: 106001, node_id: 5 })
        const ids = [0n, 1n].map((slot) => ((4n << 56n) | (slot << 32n) | 10600101n).toString())
        f.call('TryCreateWorldObj', { objs: ids })
        for (const id of ids) f.hurt(id)
        f.call('TaskClientCondAfter', { task_id: 106001, node_id: 5, indexes: [0] })
        const packets = f.call('TaskClientAfter', { task_id: 106001, node_id: 5 })
        assert(packets.findIndex((frame) => frame.id === 9853) < packets.findIndex((frame) => frame.id === 10600))
        assert.equal(f.client.count(3000), 1)
        assert(f.client.events.find((event) => event.id === 3000).finished.includes('106001:5'))
        assert(
            f.row().systemUnlockProgress.unlocked.includes(3000),
            'unlock revision forces this one atomic durable task commit',
        )
        const revision = f.state().systemUnlockProgress.revision
        f.edit((state) => {
            state.tasks[0].finish_nodes = [1]
        })
        f.call('GetRechargePopupData')
        assert(!f.state().player.basic_info.lock_system.includes(3000))
        assert.equal(f.state().systemUnlockProgress.revision, revision)
    } finally {
        f.store.close()
    }
})

test('current published boss actual9904 flags unlock3002/3 through the single notifier, survive fullbasic/relogin, and never repeat events', () => {
    const f = fixture('battle')
    try {
        const g = new TaskGraphs(tables).get(106002),
            boss = ((3n << 56n) | 600003n).toString()
        f.edit((state) => {
            Object.assign(state.world, tables.position(tables.find('world_borthpos', 10201)))
            state.taskRecords = [{ task_id: 106001, count: 1 }]
            state.tasks = [
                {
                    task_id: 106002,
                    nodes: [makeNode(g, 59, state)],
                    finish_nodes: [1, 56, 65, 61, 58, 63, 62, 57],
                    reward_nodes: [],
                },
            ]
            state.taskEpochs[106002] = 1
        })
        f.login()
        assert(f.client.locks.has(3002) && f.client.locks.has(3003))
        f.call('TrialGroupChange', { open: true, trial_id: 2 })
        f.call('EnterWorldMap', { map_id: 104, point_id: 10401, task_id: 106002, node_id: 59, client_trans_data: 2 })
        f.call('MultiCampaignPlayerLoaded')
        assert.throws(() => f.call('ClientBehaviourRecord', { key: 61009, args: [3003, 1] }), {
            code: ErrorCode.InvalidTarget,
        })
        f.call('TryCreateWorldObj', { objs: [boss] })
        for (const id of [3003, 3002]) {
            const packets = f.call('ClientBehaviourRecord', { key: 61009, args: [id, 1] })
            assert(packets.some((frame) => frame.id === 10600))
            assert.equal(battleMessageCount(f.state(), id), 1)
            assert.equal(f.client.count(id), 1)
            assert(!f.client.locks.has(id))
            const repeated = f.call('ClientBehaviourRecord', { key: 61009, args: [id, 1] })
            assert(!repeated.some((frame) => frame.id === 10600))
        }
        f.call('SkipGuide', { u32: 0 })
        f.login()
        assert(!f.client.locks.has(3002) && !f.client.locks.has(3003))
        assert.equal(f.client.count(3002), 1)
        assert.equal(f.client.count(3003), 1)
    } finally {
        f.store.close()
    }
})

test('notification codec and SQL failures roll back level/open/bitmap; shallow draft projection never mutates its shared base', () => {
    const f = fixture('rollback'),
        encode = protocol.encode
    try {
        const before = f.saved()
        protocol.encode = function (name, data) {
            if (name === protocol.byId.get(10600).rsp) throw Error('unlock-codec')
            return encode.call(this, name, data)
        }
        assert.throws(
            () => f.call('GMCommand', { command: Buffer.from('level 20').toString('base64') }),
            /unlock-codec/,
        )
        assert.deepEqual(f.saved(), before)
        protocol.encode = encode
        f.store.db.exec(
            "CREATE TEMP TRIGGER fail_unlock BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'unlock-SQL'); END",
        )
        assert.throws(() => f.call('GMCommand', { command: Buffer.from('level 20').toString('base64') }), /unlock-SQL/)
        assert.deepEqual(f.saved(), before)
        f.store.db.exec('DROP TRIGGER fail_unlock')
        f.call('GMCommand', { command: Buffer.from('level 20').toString('base64') })
        assert.equal(f.client.count(510), 1)
        const service = new SystemUnlocks(tables),
            base = minimal('normal')
        service.prepare(base)
        const saved = structuredClone(base),
            draft = { ...base, player: { ...base.player, basic_info: { ...base.player.basic_info, lv: 20 } } },
            plan = service.observe(draft)
        assert(plan.ids.includes(510))
        assert.throws(
            () =>
                service.deliver(draft, [], plan, () => {
                    throw Error('shallow-codec')
                }),
            /shallow-codec/,
        )
        assert.deepEqual(base, saved)
    } finally {
        protocol.encode = encode
        f.store.close()
    }
})

test('real deferred BattleInfoReduce keeps the exact pending/base references through failed10600 codec and SQL, then commits once', () => {
    const f = fixture('pending-battle'),
        encode = protocol.encode
    try {
        f.call('TaskClientBefore', { task_id: 106001, node_id: 5 })
        const ids = [0n, 1n].map((slot) => ((4n << 56n) | (slot << 32n) | 10600101n).toString())
        f.call('TryCreateWorldObj', { objs: ids })
        f.hurt(ids[0])
        assert(f.store.pending.has(f.session.id), 'first genuine battle report uses the deferred/pending route')
        // Explicit latent-eligibility integrity vector. This is not claimed as
        // a natural level producer; the real level producer is tested above.
        f.store.transact(
            f.session.id,
            0,
            (state) => {
                state.player.basic_info.lv = 20
            },
            { defer: true },
        )
        const pending = f.store.pending.get(f.session.id),
            saved = f.saved(),
            sql = f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
            profile = pending.state.systemUnlockProgress,
            basic = pending.state.player.basic_info
        protocol.encode = function (name, data) {
            if (name === protocol.byId.get(10600).rsp) throw Error('pending-unlock-codec')
            return encode.call(this, name, data)
        }
        assert.throws(() => f.hurt(ids[1]), /pending-unlock-codec/)
        assert.equal(f.store.pending.get(f.session.id), pending)
        assert.equal(pending.state.systemUnlockProgress, profile)
        assert.equal(pending.state.player.basic_info, basic)
        assert.deepEqual(f.saved(), saved)
        assert.deepEqual(
            f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
            sql,
        )
        protocol.encode = encode
        f.store.db.exec(
            "CREATE TEMP TRIGGER fail_pending_unlock BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'pending-unlock-SQL'); END",
        )
        assert.throws(() => f.hurt(ids[1]), /pending-unlock-SQL/)
        assert.equal(f.store.pending.get(f.session.id), pending)
        assert.deepEqual(f.saved(), saved)
        f.store.db.exec('DROP TRIGGER fail_pending_unlock')
        f.hurt(ids[1])
        assert(f.row().systemUnlockProgress.unlocked.includes(510))
        assert.equal(f.client.count(510), 1)
    } finally {
        protocol.encode = encode
        f.store.close()
    }
})

test('real SetLanguage partial5008 preserves current locks; own-player projection does not change foreign profiles, payloads, or state', () => {
    const f = fixture('partial-basic')
    try {
        const before = structuredClone(f.state()),
            locks = [...f.client.locks].sort((a, b) => a - b),
            packets = f.call('SetLanguage', { u32: 2 }),
            sync = packets.find((frame) => frame.id === 5008),
            data = protocol.decode(protocol.byId.get(5008).rsp, sync.payload)
        assert.equal(data.basic_info.language, 2)
        assert.deepEqual(data.basic_info.lock_system, locks)
        assert.deepEqual(
            [...f.client.locks].sort((a, b) => a - b),
            locks,
        )
        assert(!packets.some((frame) => frame.id === 10600))
        assert(
            !f.call('SetLanguage', { u32: 2 }).some((frame) => frame.id === 5008),
            'pure duplicate basic remains suppressed',
        )
        assert.deepEqual(f.state().systemUnlockProgress, before.systemUnlockProgress)
        const state = f.state(),
            image = structuredClone(state),
            partial = { basic_info: { language: 3 } },
            foreign = { basic_info: { id: String(BigInt(state.player.basic_info.id) + 1n), language: 3 } },
            attrs = { attr_infos: { attrs: [] } },
            out = systemUnlockPlayerPacket(state, partial)
        assert.notEqual(out, partial)
        assert.equal(partial.basic_info.lock_system, undefined)
        assert.deepEqual(out.basic_info.lock_system, locks)
        assert.equal(systemUnlockPlayerPacket(state, foreign), foreign)
        assert.equal(systemUnlockPlayerPacket(state, attrs), attrs)
        assert.deepEqual(state, image)
        const next = f.call('GMCommand', { command: Buffer.from('level 20').toString('base64') })
        assert(next.some((frame) => frame.id === 10600))
        assert.equal(f.client.count(510), 1)
    } finally {
        f.store.close()
    }
})
