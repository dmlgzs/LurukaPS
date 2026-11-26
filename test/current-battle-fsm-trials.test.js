import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { TaskGraphs, makeNode } from '../src/tasks.js'
import { activeFormationManager } from '../src/trial-actors.js'
import { enemyDefinition } from '../src/enemy-state.js'
import { currentBattleFsmTrialAdmission, validateBattleFsmTrialIndex } from '../src/current-battle-fsm-trials.js'
import index from '../configs/current-battle-fsm-trials.json' with { type: 'json' }
import { ErrorCode } from '../src/error-codes.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    graph = new TaskGraphs(tables).get(106002),
    boss = ((3n << 56n) | 600003n).toString()
function fixture(name) {
    const protocol = new Protocol(cfg.base),
        store = new Store(':memory:'),
        session = {},
        game = new Game(protocol, store, tables, { clock: () => 1800000000 })
    let seq = 1,
        ms = 1800000000000
    const frame = (name, request = {}) => {
        const entry = protocol.byName.get('CSProto' + name)
        return { id: entry.id, seq: seq++, payload: entry.req ? protocol.encode(entry.req, request) : Buffer.alloc(0) }
    }
    const call = (name, request) => game.dispatch(session, frame(name, request))
    call('EnterGame', { open_id: 'candidate-battle-fsm-' + name })
    store.transact(session.id, 0, (state) => {
        // Trusted real pre-node59 checkpoint. The transfer, trial2, loading,
        // presence request and later template3 are actual current requests.
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
    })
    call('TrialGroupChange', { open: true, trial_id: 2 })
    call('EnterWorldMap', { map_id: 104, point_id: 10401, task_id: 106002, node_id: 59, client_trans_data: 2 })
    call('MultiCampaignPlayerLoaded')
    const state = () => store.load(session.id).state,
        decode = (id, packets) =>
            protocol.decode(protocol.byId.get(id).rsp, packets.find((packet) => packet.id === id).payload)
    return {
        protocol,
        store,
        session,
        game,
        call,
        frame,
        state,
        decode,
        edit: (fn) => store.transact(session.id, 0, fn),
        spawn: () => call('TryCreateWorldObj', { objs: [boss] }),
        hit: (n) => {
            const s = state(),
                m = activeFormationManager(s),
                control = m.groups.find((g) => g.id === m.cur_group).control
            return call('BattleInfoReduce', {
                base_time: String(++ms),
                uint64_dic: [control, boss],
                battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -n } }],
            })
        },
        close: () => store.close(),
    }
}
const owned = (s) =>
    structuredClone({
        pets: s.pets,
        heros: s.player.heros_info.heros.map(({ trial_pet, ...hero }) => hero),
        bag: s.player.sbag_infos,
        next: s.nextPetSequence,
        records: s.taskRecords,
    })
function snapshot(f) {
    return f.store.load(f.session.id)
}
function unchanged(f, fn, predicate) {
    const saved = snapshot(f)
    assert.throws(fn, predicate)
    assert.deepEqual(snapshot(f), saved)
}

test('current global87 FSM bindings preserve84 parsed sources and explicit missing assets instead of invented empty refs', () => {
    const rows = validateBattleFsmTrialIndex()
    assert.equal(rows.size, 87)
    assert.equal([...rows.values()].filter((row) => row.status === 'parsed').length, 84)
    assert.deepEqual(
        [...rows.values()].filter((row) => row.status !== 'parsed').map((row) => row.id),
        [2, 3, 4],
    )
    assert.deepEqual(rows.get(102).trialIds, [2, 3])
    assert(rows.get(102).trialRefs.some((ref) => ref.trialId === 3 && ref.isOn && ref.enabled && ref.nodeId === '14'))
    const broken = structuredClone(index)
    broken.fsms.find((row) => row.id === 102).trialIds.push(4)
    assert.throws(
        () => validateBattleFsmTrialIndex(broken),
        (e) => e.code === ErrorCode.GameConfig,
    )
})

test('actual current5987 opens FSM template3 with Sif, Abi102 and control, ACK-first callback arms then real roster makes ready, and restores2', () => {
    const f = fixture('open')
    try {
        assert.equal(currentBattleFsmTrialAdmission(tables, f.state(), 3), null, 'no published source yet')
        unchanged(
            f,
            () => f.call('TrialGroupChange', { open: true, trial_id: 3 }),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
        f.spawn()
        f.call('TaskClientBefore', { task_id: 106002, node_id: 59 })
        const authority = currentBattleFsmTrialAdmission(tables, f.state(), 3)
        assert.equal(authority.source, 'battle-fsm')
        assert.equal(authority.taskId, 106002)
        assert.equal(authority.battleFsmSource.battleFsmType, 102)
        const before = owned(f.state()),
            packets = f.call('TrialGroupChange', { open: true, trial_id: 3 }),
            s = f.state(),
            trial = s.trialGroup,
            hero = trial.heroes.find((row) => row.conf_id === 107001),
            pet = trial.pets.find((row) => row.config_id === 500264),
            manager = activeFormationManager(s),
            active = manager.groups.find((row) => row.id === manager.cur_group)
        assert.equal(trial.current_group_id, 3)
        assert.equal(trial.current_source, 'battle-fsm')
        assert(hero && pet)
        assert.equal(Number(BigInt(pet.guid) >> 56n), 9)
        assert.equal(Number((BigInt(pet.guid) >> 32n) & 0xffffffn), 102)
        assert.equal(pet.hero_id, hero.guid)
        assert.equal(hero.trial_pet, pet.guid)
        assert.equal(active.control, hero.guid)
        assert(active.heros.some((slot) => slot.hero_id === hero.guid && slot.pet_id === pet.guid))
        assert.deepEqual(
            new Map(pet.comprehension.map((row) => [row.attr_id, row.value])),
            new Map([
                [1, 120],
                [3, 130],
                [5, 130],
                [230, 120],
                [229, 120],
                [7, 400],
            ]),
        )
        assert.deepEqual(owned(s), before, 'temporary actors do not replace owned assets')
        const ack = packets.findIndex((p) => p.id === 5987),
            trialId = f.protocol.byName.get('CSProtoTrialDatas').id,
            attrs = packets.findIndex((p) => p.id === 10006),
            data = packets.findIndex((p) => p.id === trialId)
        assert(
            ack >= 0 && attrs > ack && data > attrs,
            'existing non-scene publisher is ACK-first, attrs-before-actors',
        )
        let requested = false,
            ready = false,
            ended = false
        const definitions = new Map()
        for (const packet of packets) {
            if (packet.id === 5987) requested = true
            if (packet.id === trialId) {
                const payload = f.protocol.decode(f.protocol.byId.get(trialId).rsp, packet.payload)
                for (const actor of [...payload.trial_heros, ...payload.trial_pets]) definitions.set(actor.guid, actor)
                assert(definitions.has(hero.guid) && definitions.has(pet.guid))
            }
            if (packet.id === f.protocol.byName.get('CSProtoSyncPlayerData').id) {
                const payload = f.protocol.decode(f.protocol.byId.get(packet.id).rsp, packet.payload)
                for (const m of payload.group_mgrs ?? [])
                    for (const g of m.groups ?? [])
                        if (
                            g.id === 0 &&
                            g.control === hero.guid &&
                            definitions.has(g.control) &&
                            g.heros.some((slot) => slot.pet_id === pet.guid)
                        ) {
                            assert(requested, 'OnMainControlSet consumes ready only after TrueCall')
                            ready = true
                        }
            }
            ended = requested && ready
        }
        assert(ended, 'current callback/frame consumption model reaches EndAction; this is not Unity execution')
        const wireAttrs = f.decode(10006, packets).heros
        assert(wireAttrs.some((row) => row.hero_guid === pet.guid && row.type === 9))
        f.call('TrialGroupChange', { open: false })
        f.call('TrialGroupChange', { open: true, trial_id: 2 })
        assert.equal(f.state().trialGroup.current_group_id, 2)
        assert(!f.state().trialGroup.pets.some((row) => row.guid === pet.guid))
        assert.deepEqual(owned(f.state()), before)
    } finally {
        f.close()
    }
})

test('wrong map, old runtime/generation, absent presentation/source and nonreferenced templates cannot borrow the battle authority', () => {
    const f = fixture('scope')
    try {
        f.spawn()
        const base = f.state()
        assert(currentBattleFsmTrialAdmission(tables, base, 3))
        for (const alter of [
            (s) => {
                s.world.map_id = 102
            },
            (s) => {
                s.worldObjectAoi.scene.runtime_epoch++
            },
            (s) => {
                s.combat.enemyActivations[boss].generation++
            },
            (s) => {
                delete s.worldObjectAoi.agents[boss]
            },
            (s) => {
                delete s.combatEnemyPresentations[104][boss]
            },
            (s) => {
                s.worldObjects['104:600003'] = { active: false }
            },
            (s) => {
                s.tasks[0].nodes = []
            },
            (s) => {
                s.tasks[0].finish_nodes.push(59)
            },
        ]) {
            const s = structuredClone(base)
            s.worldObjects ??= {}
            alter(s)
            assert.equal(currentBattleFsmTrialAdmission(tables, s, 3), null)
        }
        assert.equal(
            currentBattleFsmTrialAdmission(tables, base, 4),
            null,
            'same hero audit template is not a referenced FSM roster',
        )
        assert.equal(
            currentBattleFsmTrialAdmission(tables, base, 621402),
            null,
            'another current FSM reference cannot be borrowed',
        )
        const foreign = Object.create(tables)
        foreign.find = (name, id) => {
            const row = tables.find(name, id)
            return name === 'world_enemy_group' && id === 409 ? { ...row, battleFsmType: 2 } : row
        }
        assert.throws(
            () => currentBattleFsmTrialAdmission(foreign, base, 3),
            (e) => e.code === ErrorCode.GameConfig,
        )
    } finally {
        f.close()
    }
})

test('same-generation issued terminal survives real task59 After to64 for late FSM restoration, while revocation and history remain closed', () => {
    const f = fixture('terminal')
    try {
        f.spawn()
        f.call('TaskClientBefore', { task_id: 106002, node_id: 59 })
        f.call('TrialGroupChange', { open: true, trial_id: 3 })
        const hp = enemyDefinition(tables, f.state(), boss).max_hp
        f.hit(hp)
        assert.equal(f.state().combat.entities[boss].hp, 0)
        assert.equal(f.state().tasks[0].nodes[0].node_values[0], 1)
        f.call('TryDeleteWorldObj', { u64s: [boss] })
        const permit = currentBattleFsmTrialAdmission(tables, f.state(), 3)
        assert(permit?.battleFsmSource.terminalCleanup)
        const old = structuredClone(f.state())
        old.combat.enemyTerminals[boss].generation++
        assert.equal(currentBattleFsmTrialAdmission(tables, old, 3), null)
        f.call('TaskClientCondAfter', { task_id: 106002, node_id: 59, indexes: [0] })
        f.call('TaskClientAfter', { task_id: 106002, node_id: 59 })
        assert(f.state().tasks[0].nodes.some((node) => node.node_id === 64))
        const successor = currentBattleFsmTrialAdmission(tables, f.state(), 3)
        assert(successor?.battleFsmSource.terminalCleanup)
        assert.deepEqual(successor.battleFsmSource.successorNodeIds, [64])
        const assets = owned(f.state())
        f.call('TrialGroupChange', { open: false })
        f.call('TrialGroupChange', { open: true, trial_id: 2 })
        assert.equal(f.state().trialGroup.current_group_id, 2)
        f.call('TrialGroupChange', { open: true, trial_id: 3 })
        assert.equal(
            f.state().trialGroup.current_group_id,
            3,
            'late current FSM stack restoration remains legal after task-level59 completion',
        )
        assert.deepEqual(owned(f.state()), assets, 'late cleanup restoration grants no permanent assets')
        const terminal = f.state()
        for (const alter of [
            (s) => {
                s.world.map_id = 102
            },
            (s) => {
                s.combat.enemyActivations[boss].generation++
            },
            (s) => {
                s.combat.enemyActivations[boss].active = false
            },
            (s) => {
                s.worldObjects ??= {}
                s.worldObjects['104:600003'] = { active: false }
            },
            (s) => {
                s.tasks = []
            },
            (s) => {
                s.tasks[0].nodes = [makeNode(graph, 60, s)]
            },
        ]) {
            const s = structuredClone(terminal)
            alter(s)
            assert.equal(currentBattleFsmTrialAdmission(tables, s, 3), null)
        }
    } finally {
        f.close()
    }
})

test('template3 actor/attribute codec and SQL failures roll back full trial/control state before safe retry', () => {
    const f = fixture('rollback'),
        encode = f.protocol.encode.bind(f.protocol)
    try {
        f.spawn()
        f.call('TaskClientBefore', { task_id: 106002, node_id: 59 })
        const request = f.frame('TrialGroupChange', { open: true, trial_id: 3 }),
            data = f.protocol.byName.get('CSProtoTrialDatas').rsp
        f.protocol.encode = (name, value) => {
            if (name === data) throw Error('battle trial actor codec')
            return encode(name, value)
        }
        unchanged(f, () => f.game.dispatch(f.session, request), /battle trial actor codec/)
        f.protocol.encode = encode
        f.store.db.exec(
            "CREATE TEMP TRIGGER fail_battle_trial BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'battle trial SQL'); END",
        )
        unchanged(f, () => f.game.dispatch(f.session, request), /battle trial SQL/)
        f.store.db.exec('DROP TRIGGER fail_battle_trial')
        f.game.dispatch(f.session, request)
        assert.equal(f.state().trialGroup.current_group_id, 3)
        assert.equal(f.state().trialGroup.pets.filter((pet) => pet.config_id === 500264).length, 1)
    } finally {
        f.protocol.encode = encode
        f.close()
    }
})
