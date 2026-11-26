import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Protocol } from '../src/protocol.js'
import { Game } from '../src/game.js'
import { TaskGraphs, makeNode } from '../src/tasks.js'
import { enemyDefinition } from '../src/enemy-state.js'
import { registerPetCatch } from '../src/handlers/pet-catch.js'
import { catchCardDefinition, petCatchOutcome } from '../src/pet-catch-policy.js'
import { ErrorCode } from '../src/error-codes.js'

const config = configuration(),
    targetId = '288230376151813800',
    cardId = 1000001
class CurrentTables extends Tables {
    constructor(modify = {}) {
        super(config.tables)
        this.modify = modify
        this.forbidSpecimen = false
    }
    get(name) {
        if (this.forbidSpecimen) assert.notEqual(name, 'pet_builder_rule', 'probability must not roll a specimen')
        const rows = super.get(name)
        return this.modify[name] ? this.modify[name](rows) : rows
    }
    find(name, id) {
        if (this.modify[name]) return this.get(name).find((row) => row.id === Number(id))
        return super.find(name, id)
    }
}
function fixture(name, modify) {
    const tables = new CurrentTables(modify),
        protocol = new Protocol(config.base),
        store = new Store(':memory:'),
        session = {},
        game = new Game(protocol, store, tables, { clock: () => 1800000000 })
    let seq = 1
    const call = (name, body = {}, peer = session) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(peer, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, body) })
    }
    call('EnterGame', { open_id: 'catch-probability-' + name })
    const graph = new TaskGraphs(tables).get(106002)
    store.transact(session.id, 0, (state) => {
        state.world.map_id = 102
        state.world.point_id = 102001
        state.tasks = [
            {
                task_id: 106002,
                nodes: [{ ...makeNode(graph, 56, state), client_before: true }],
                finish_nodes: [1],
                reward_nodes: [],
            },
        ]
        state.taskRecords = [{ task_id: 106001, count: 1, time: 1 }]
        state.player.sbag_infos.items = []
    })
    const decode = (name, packets) => {
        const entry = protocol.byName.get('CSProto' + name),
            packet = packets.find((packet) => packet.id === entry.id)
        assert(packet, name)
        return protocol.decode(entry.rsp, packet.payload)
    }
    const query = (request = { cardId, objId: targetId }) =>
        decode('KiboCatchProbability', call('KiboCatchProbability', request))
    const snapshot = () => ({
        saved: store.load(session.id),
        changes: store.db.prepare('SELECT total_changes() AS n').get().n,
        player: store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(session.id),
        logs: store.db.prepare('SELECT count(*) AS n FROM request_log').get().n,
        pending: structuredClone([...store.pending]),
    })
    return {
        tables,
        protocol,
        store,
        game,
        session,
        call,
        decode,
        query,
        snapshot,
        state: () => store.load(session.id).state,
    }
}

// Current Native0600efb2/b3 uses (target,card) as its cache key and /100 for UI.
class ProbabilityConsumer {
    constructor(target, card) {
        this.target = target
        this.card = card
        this.cache = new Map()
        this.refresh = false
    }
    receive(value) {
        assert(Number.isInteger(value.probability) && value.probability >= 0 && value.probability <= 10000)
        this.cache.set(value.objId + ':' + value.cardId, value.probability)
        this.refresh = value.objId === this.target && value.cardId === this.card
    }
    percent() {
        return this.cache.get(this.target + ':' + this.card) / 100
    }
}

test('real account12 request11914 resolves task106002/56 customized enemy and returns a read-only 100% current-client cache value', () => {
    const f = fixture('exact-request')
    try {
        assert.equal(((4n << 56n) | 102056n).toString(), targetId)
        const enemy = enemyDefinition(f.tables, f.state(), targetId)
        assert.equal(enemy.config_id, 310369)
        assert.equal(enemy.pack_id, 310369)
        assert.equal(f.tables.find('enemy', enemy.config_id).petCategory, 30)
        assert.equal(f.tables.find('enemy', enemy.config_id).petId, 5002971)
        assert.equal(f.tables.find('pet_customized', 5002971).petId, 500297)
        let randomCalls = 0
        f.game.rng = () => {
            randomCalls++
            throw Error('probability must not call RNG')
        }
        f.tables.forbidSpecimen = true
        const before = f.snapshot(),
            consumer = new ProbabilityConsumer(targetId, cardId)
        for (let index = 0; index < 5; index++) {
            const response = f.query()
            assert.deepEqual(response, { cardId, objId: targetId, probability: 10000 })
            consumer.receive(response)
            assert.equal(consumer.percent(), 100)
            assert.equal(consumer.refresh, true)
        }
        assert.equal(randomCalls, 0)
        assert.deepEqual(
            f.snapshot(),
            before,
            'no card/profile/queue/revision/request-log/SQL writes on repeated aim queries',
        )
        consumer.receive({ cardId: cardId + 1, objId: targetId, probability: 0 })
        assert.equal(consumer.refresh, false)
        assert.equal(consumer.percent(), 100)
        consumer.receive({ cardId, objId: '1', probability: 0 })
        assert.equal(consumer.refresh, false)
        assert.equal(consumer.percent(), 100)
        assert.throws(() => consumer.receive({ cardId, objId: targetId, probability: 10001 }))
    } finally {
        f.store.close()
    }
})

test('query, preview, reservation and actual catch share the local success policy, and retries/relogin never grant twice', () => {
    const f = fixture('settlement')
    try {
        assert.equal(f.query().probability, petCatchOutcome().probability)
        f.store.transact(f.session.id, 0, (state) =>
            state.player.sbag_infos.items.push({ itemid: cardId, itemnum: 1, itemtype: 3, guid: '600001' }),
        )
        const preview = f.decode(
                'SyncCatchPetInfo',
                f.call('GetCatchPetInfo', { tar_id: [targetId], day_weather: 1, reason: 1 }),
            ).pets[0],
            card = f.decode(
                'CatchPetCard',
                f.call('CatchPetCard', { item_id: cardId, is_create: true, client_param: '1' }),
            )
        const before = f.snapshot()
        assert.equal(f.query().probability, 10000)
        assert.deepEqual(f.snapshot(), before)
        const request = { tar_id: targetId, item_id: cardId, catch_key: card.catch_key, day_weather: 1 },
            result = f.decode('CatchPet', f.call('CatchPet', request)),
            pet = f.state().pets.find((row) => row.guid === result.guid)
        assert.equal(result.success, petCatchOutcome().success)
        assert.equal(result.rand_rate, petCatchOutcome().randRate)
        assert.equal(pet.config_id, 500297)
        assert.equal(pet.customized_id, 5002971)
        assert.deepEqual(pet.gene_infos, preview.gene_infos)
        assert.deepEqual(pet.comprehension, preview.comprehension)
        const count = f.state().pets.length,
            replay = f.decode('CatchPet', f.call('CatchPet', request))
        assert.equal(replay.guid, result.guid)
        assert.deepEqual(replay.rewards.rewards, [])
        assert.equal(f.state().pets.length, count)
        f.call('EnterGame', { open_id: 'catch-probability-settlement', reconnect: true }, {})
        assert.equal(f.state().pets.length, count)
        assert.equal(f.state().petCatchCards[card.catch_key].state, 'used')
    } finally {
        f.store.close()
    }
})

test('known forbidden targets return zero; unknown, cross-map and malformed targets fail without state changes', () => {
    const f = fixture('forbidden', {
        enemy_pack: (rows) => rows.map((row) => (row.id === 310369 ? { ...row, uncatchableType: 1 } : row)),
    })
    try {
        const before = f.snapshot()
        assert.deepEqual(f.query(), { cardId, objId: targetId, probability: 0 })
        assert.deepEqual(f.snapshot(), before)
        for (const objId of ['1', ((3n << 56n) | 4500137n).toString()])
            assert.throws(
                () => f.query({ cardId, objId }),
                (error) => error.code === ErrorCode.InvalidTarget,
            )
        assert.throws(
            () => f.query({ cardId, objId: '0' }),
            (error) => error.code === ErrorCode.CatchParamErr,
        )
        assert.throws(
            () => f.query({ cardId: 0, objId: targetId }),
            (error) => error.code === ErrorCode.CatchParamErr,
        )
        assert.deepEqual(f.snapshot(), before)
    } finally {
        f.store.close()
    }
})

test('card validation uses current common_item.subId to pet_catchitem.type, rejecting wrong items and missing or ambiguous data', () => {
    for (const [name, modify, expected] of [
        [
            'wrong-type',
            { common_item: (rows) => rows.map((row) => (row.id === cardId ? { ...row, type: 1 } : row)) },
            ErrorCode.CatchParamErr,
        ],
        ['missing-item', { common_item: (rows) => rows.filter((row) => row.id !== cardId) }, ErrorCode.GameConfig],
        ['missing-type', { pet_catchitem: (rows) => rows.filter((row) => row.type !== 1) }, ErrorCode.GameConfig],
        [
            'duplicate-type',
            { pet_catchitem: (rows) => [...rows, rows.find((row) => row.type === 1)] },
            ErrorCode.GameConfig,
        ],
        [
            'bad-reference',
            { common_item: (rows) => rows.map((row) => (row.id === cardId ? { ...row, subId: 0 } : row)) },
            ErrorCode.GameConfig,
        ],
    ]) {
        const f = fixture(name, modify)
        try {
            const before = f.snapshot()
            assert.throws(f.query, (error) => error.code === expected)
            assert.deepEqual(f.snapshot(), before)
        } finally {
            f.store.close()
        }
    }
    const tables = new Tables(config.tables),
        definition = catchCardDefinition(tables, cardId)
    assert.equal(definition.item.subId, definition.config.type)
    assert.equal(definition.config.id, undefined)
})

test('pure probability handler cannot mutate context or allocate a specimen, and response codec failure preserves SQL and pending work', () => {
    const f = fixture('atomic'),
        handlers = new Map()
    registerPetCatch((name, handler) => handlers.set(name, handler))
    try {
        const state = f.state(),
            beforeState = structuredClone(state)
        const context = {
            state,
            tables: f.tables,
            randomInt: () => {
                throw Error('RNG forbidden')
            },
            push: () => {
                throw Error('No notification expected')
            },
            pushBefore: () => {
                throw Error('No notification expected')
            },
        }
        assert.deepEqual(handlers.get('KiboCatchProbability')(context, { cardId, objId: targetId }), {
            cardId,
            objId: targetId,
            probability: 10000,
        })
        assert.deepEqual(state, beforeState)
        for (const objId of ['-1', '18446744073709551616', 'bad'])
            assert.throws(
                () => handlers.get('KiboCatchProbability')(context, { cardId, objId }),
                (error) => error.code === ErrorCode.CatchParamErr,
            )
        const before = f.snapshot(),
            encode = f.protocol.encode
        f.protocol.encode = function (name, value) {
            if (name === f.protocol.byName.get('CSProtoKiboCatchProbability').rsp)
                throw Error('injected-probability-codec')
            return encode.call(this, name, value)
        }
        assert.throws(f.query, /injected-probability-codec/)
        assert.deepEqual(f.snapshot(), before)
        f.protocol.encode = encode
        const base = {
            version: 1,
            origin: 'LOCAL',
            notOfficial: true,
            probabilityUnit: 'basis-points',
            strategy: 'guaranteed-success',
            probability: 10000,
        }
        assert.throws(
            () => petCatchOutcome({ ...base, probability: 5000 }),
            (error) => error.code === ErrorCode.FunctionClosed,
        )
        assert.throws(
            () => petCatchOutcome({ ...base, probability: -1 }),
            (error) => error.code === ErrorCode.GameConfig,
        )
    } finally {
        f.store.close()
    }
})
