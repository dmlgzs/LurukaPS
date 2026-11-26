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
import { TaskGraphs, makeNode } from '../src/tasks.js'
import { battleMessageCount, recordBattleMessage } from '../src/battle-message-events.js'
import { ErrorCode } from '../src/error-codes.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    graph = new TaskGraphs(tables).get(106002),
    boss = ((3n << 56n) | 600003n).toString()
function fixture(name, file = ':memory:') {
    const protocol = new Protocol(cfg.base)
    let store = new Store(file),
        session = {},
        game,
        seq = 1
    const start = () => {
        game = new Game(protocol, store, tables, { clock: () => 1800000000 })
    }
    start()
    const frame = (name, r = {}) => {
            const entry = protocol.byName.get('CSProto' + name)
            return { id: entry.id, seq: seq++, payload: entry.req ? protocol.encode(entry.req, r) : Buffer.alloc(0) }
        },
        call = (name, r) => game.dispatch(session, frame(name, r)),
        account = 'battle-message-candidate-' + name
    call('EnterGame', { open_id: account })
    store.transact(session.id, 0, (state) => {
        Object.assign(state.world, tables.position(tables.find('world_borthpos', 10201)))
        state.tasks = [
            {
                task_id: 106002,
                nodes: [makeNode(graph, 59, state)],
                finish_nodes: [1, 56, 65, 61, 58, 63, 62, 57],
                reward_nodes: [],
                client_trace: true,
            },
        ]
        state.taskRecords = [{ task_id: 106001, count: 1, time: 1799999999 }]
        state.taskEpochs[106002] = 1
        // Use the existing already-open account policy. The integrated system
        // owner now maintains the public bitmap; this fixture must not replace it.
    })
    call('TrialGroupChange', { open: true, trial_id: 2 })
    call('EnterWorldMap', { map_id: 104, point_id: 10401, task_id: 106002, node_id: 59, client_trans_data: 2 })
    call('MultiCampaignPlayerLoaded')
    return {
        protocol,
        frame,
        call,
        get store() {
            return store
        },
        get session() {
            return session
        },
        get game() {
            return game
        },
        state: () => store.load(session.id).state,
        edit: (fn) => store.transact(session.id, 0, fn),
        spawn: () => call('TryCreateWorldObj', { objs: [boss] }),
        record: (id) => call('ClientBehaviourRecord', { key: 61009, args: [id, 1] }),
        reopen: () => {
            store.close()
            store = new Store(file)
            start()
            session = {}
            return call('EnterGame', { open_id: account, reconnect: true })
        },
        close: () => store.close(),
    }
}
function unchanged(f, run, check) {
    const before = f.store.load(f.session.id)
    assert.throws(run, check)
    assert.deepEqual(f.store.load(f.session.id), before)
}
const assets = (s) =>
    structuredClone({
        pets: s.pets,
        heroes: s.player.heros_info.heros,
        bag: s.player.sbag_infos,
        attrs: s.player.attr_infos,
        next: s.nextPetSequence,
    })

test('actual9904 records scoped permanent61009 flags without creating another open set, rewards or10600 sender', () => {
    const f = fixture('records')
    try {
        assert.equal(battleMessageCount(f.state(), 3002), 0)
        unchanged(
            f,
            () => f.record(3002),
            (e) => e.code === ErrorCode.InvalidTarget,
        )
        f.spawn()
        const locks = structuredClone(f.state().player.basic_info.lock_system)
        const isolated = structuredClone(f.state())
        isolated.player.basic_info.lock_system = [3002, 3003]
        const emitted = []
        assert.equal(
            recordBattleMessage(
                {
                    state: isolated,
                    tables,
                    now: 1800000000,
                    combatSessionId: f.session.token,
                    push: (name) => emitted.push(name),
                    pushBefore: (name) => emitted.push(name),
                },
                { key: 61009, args: [3002, 1] },
            ),
            true,
        )
        assert.deepEqual(isolated.player.basic_info.lock_system, [3002, 3003])
        assert.deepEqual(emitted, [], 'the isolated facts leaf leaves notification delivery to its caller')
        const before = assets(f.state()),
            packets = f.record(3002)
        assert(packets.some((p) => p.id === 9904))
        assert(!packets.some((p) => p.id === 10600), 'system notifier has a separate single owner')
        assert.equal(battleMessageCount(f.state(), 3002), 1)
        assert.equal(battleMessageCount(f.state(), 3003), 0)
        assert.deepEqual(
            f.state().player.basic_info.lock_system,
            locks,
            'a previously open account retains the system owner bitmap',
        )
        assert.deepEqual(assets(f.state()), before)
        f.record(3003)
        const receipts = structuredClone(f.state().battleMessageProgress)
        f.record(3003)
        assert.deepEqual(f.state().battleMessageProgress, receipts, 'nodes10/12 are one persistent flag, not count2')
        for (let n = 0; n < 36; n++) f.call('ClientBehaviourRecord', { key: 999999, args: [n] })
        assert.equal(f.state().clientBehaviour.length, 32)
        assert.equal(battleMessageCount(f.state(), 3002), 1)
        assert.equal(battleMessageCount(f.state(), 3003), 1)
        for (const args of [[3002], [3002, 0], [3002, 2], [3004, 1], [3002, 1, 1]])
            unchanged(
                f,
                () => f.call('ClientBehaviourRecord', { key: 61009, args }),
                (e) => e.code === ErrorCode.InvalidArgument,
            )
    } finally {
        f.close()
    }
})

test('message authority rejects wrong map, connection, generation, unpublished/revoked source and missing task instead of trusting telemetry', () => {
    const f = fixture('scope')
    try {
        f.spawn()
        const baseline = f.state()
        for (const alter of [
            (s) => {
                s.world.map_id = 102
            },
            (s) => {
                s.worldObjectAoi.connection_hash = 'a'.repeat(64)
            },
            (s) => {
                s.worldObjectAoi.scene.runtime_epoch++
            },
            (s) => {
                s.combat.enemyActivations[boss].generation++
            },
            (s) => {
                s.combat.enemyActivations[boss].active = false
            },
            (s) => {
                delete s.worldObjectAoi.agents[boss]
            },
            (s) => {
                delete s.combatEnemyPresentations[104][boss]
            },
            (s) => {
                s.tasks = []
            },
        ]) {
            const state = structuredClone(baseline)
            alter(state)
            const before = structuredClone(state)
            assert.throws(
                () =>
                    recordBattleMessage(
                        { state, tables, now: 1800000000, combatSessionId: f.session.token },
                        { key: 61009, args: [3002, 1] },
                    ),
                (e) => e.code === ErrorCode.InvalidTarget,
            )
            assert.deepEqual(state, before)
        }
        const bad = { battleMessageProgress: { version: 1, values: { 3002: 2 }, sources: {} } }
        assert.throws(
            () => battleMessageCount(bad, 3002),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.equal(recordBattleMessage({ state: baseline }, { key: 123, args: [] }), false)
    } finally {
        f.close()
    }
})

test('real9904 ACK codec and SQL failures roll back typed facts; retry and cold reopen retain one permanent fact', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'battle-message-current-')),
        f = fixture('rollback', path.join(dir, 'validation-only.sqlite')),
        encode = f.protocol.encode.bind(f.protocol)
    try {
        f.spawn()
        const packet = f.frame('ClientBehaviourRecord', { key: 61009, args: [3003, 1] }),
            entry = f.protocol.byId.get(9904)
        f.protocol.encode = (name, value) => {
            if (name === entry.rsp) throw Error('battle-message ACK codec')
            return encode(name, value)
        }
        unchanged(f, () => f.game.dispatch(f.session, packet), /battle-message ACK codec/)
        f.protocol.encode = encode
        f.store.db.exec(
            "CREATE TEMP TRIGGER fail_battle_message BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'battle-message SQL'); END",
        )
        unchanged(f, () => f.game.dispatch(f.session, packet), /battle-message SQL/)
        f.store.db.exec('DROP TRIGGER fail_battle_message')
        f.game.dispatch(f.session, packet)
        assert.equal(battleMessageCount(f.state(), 3003), 1)
        const fact = structuredClone(f.state().battleMessageProgress)
        f.game.dispatch(f.session, packet)
        assert.deepEqual(f.state().battleMessageProgress, fact)
        f.reopen()
        assert.deepEqual(f.state().battleMessageProgress, fact)
        assert.equal(battleMessageCount(f.state(), 3003), 1)
        f.edit((s) => {
            s.world.map_id = 102
        })
        f.record(3003)
        assert.deepEqual(
            f.state().battleMessageProgress,
            fact,
            'already earned correct replay is harmless outside its old scene',
        )
    } finally {
        f.protocol.encode = encode
        f.close()
        assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
