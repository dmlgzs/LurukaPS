import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { recordNoviceDuelFeverOutcome } from '../src/novice-duel-fever.js'
import { ErrorCode } from '../src/error-codes.js'

function fixture(name, phase) {
    const config = configuration(),
        tables = new Tables(config.tables),
        protocol = new Protocol(config.base),
        store = new Store(':memory:'),
        session = {},
        game = new Game(protocol, store, tables, { clock: () => 1800000000 })
    let seq = 1
    const call = (suffix, value = {}, target = session) => {
        const entry = protocol.byName.get('CSProto' + suffix)
        return game.dispatch(target, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, value) })
    }
    const state = () => store.load(session.id).state
    try {
        call('EnterGame', { open_id: name })
        const duel = tables.find('kibo_duel', 2001)
        call('KiboDuelGetGroup', { u32: duel.id })
        call('KiboDuelGroupChange', {
            type: 6,
            group: {
                slot: 1,
                duel_id: duel.id,
                hero: state().player.heros_info.heros[0].guid,
                pet_guids: state()
                    .pets.slice(0, 8)
                    .map((pet) => ({ id: pet.guid, is_trial: false })),
            },
        })
        call('SetKiboDuelCurGroup', { type: 6, cur_group: 1 })
        call('MultiCampaignCreate', { dungeon_id: duel.dungeonId })
        if (phase !== 2) {
            call('StartDungeonClientOk')
            call('MultiCampaignPlayerLoadFinish')
        }
        if (phase === 6) call('KiboDuelArenaFirstConfirmReq')
        assert.equal(state().multiCampaign.arena_status, phase)
        return { state, call, game, protocol, store, session, tables, duel, name, close: () => store.close() }
    } catch (error) {
        store.close()
        throw error
    }
}

for (const phase of [3, 6])
    test(`actual phase${phase} surrender preserves its legal loss, repeated result and cold login without novice combat facts`, () => {
        const f = fixture('prebattle-v2-' + phase, phase)
        try {
            assert.equal(f.state().combat.npcDuel.regular_started_at, undefined)
            const packets = f.call('KiboDuelSurrender'),
                result = structuredClone(f.state().combat.npcDuel.result)
            assert(packets.some((packet) => packet.id === 11710))
            assert.equal(result.result, 2)
            assert.equal(result.reason, 3)
            assert.equal(result.clearance_time, '300')
            assert.equal(f.state().multiCampaign.arena_status, 5)
            assert.equal(f.state().combat.npcDuel.noviceFeverReceipt, undefined)
            assert.equal(f.state().noviceDuelFeverWins, undefined)
            assert.equal(f.state().noviceDuelVictory, undefined)
            assert.equal(f.state().noviceDuelEventWins, undefined)
            f.call('KiboDuelSurrender')
            f.call('KiboDuelBattleFinish', { status: 1 })
            assert.deepEqual(f.state().combat.npcDuel.result, result)
            f.call('EnterGame', { open_id: f.name }, {})
            assert.deepEqual(f.state().combat.npcDuel.result, result)
            assert.equal(f.state().noviceDuelFeverWins, undefined)
        } finally {
            f.close()
        }
    })

test('pre-regular fake wins and invalid scene or duel sources remain named integrity errors without facts', () => {
    for (const phase of [3, 6]) {
        const f = fixture('prebattle-v2-invalid-' + phase, phase)
        try {
            for (const variant of ['win', 'scene', 'duel']) {
                const state = structuredClone(f.state()),
                    before = structuredClone(state),
                    duel = variant === 'duel' ? { ...f.duel, id: f.duel.id + 1 } : f.duel
                if (variant === 'scene') {
                    state.world.map_id++
                    before.world.map_id++
                }
                assert.throws(
                    () =>
                        recordNoviceDuelFeverOutcome({ state, tables: f.tables, now: 1800000000 }, duel, {
                            result: variant === 'win' ? 1 : 2,
                            reason: variant === 'win' ? 1 : 3,
                        }),
                    (error) => error.code === ErrorCode.GameConfig,
                )
                assert.deepEqual(state, before)
            }
        } finally {
            f.close()
        }
    }
})

test('both pre-regular loss paths retain full pending and SQLite rollback on result codec or save failure', () => {
    for (const phase of [3, 6])
        for (const failure of ['codec', 'sql']) {
            const f = fixture('prebattle-v2-atomic-' + phase + failure, phase)
            let packet
            try {
                f.store.transact(
                    f.session.id,
                    0,
                    (state) => {
                        state.prebattlePendingMarker = true
                    },
                    { defer: true },
                )
                const before = structuredClone(f.state()),
                    pending = f.store.pending.get(f.session.id),
                    saved = f.store.db
                        .prepare('SELECT state,revision FROM players WHERE account_id=?')
                        .get(f.session.id)
                if (failure === 'codec') {
                    packet = f.game.packet
                    f.game.packet = function (name, ...args) {
                        if (name === 'SCProtoKiboDuelArenaResultInfoSync') throw Error('prebattle-codec')
                        return packet.call(this, name, ...args)
                    }
                } else
                    f.store.db.exec(
                        "CREATE TRIGGER prebattle_fail BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT, 'prebattle-sql'); END",
                    )
                assert.throws(() => f.call('KiboDuelSurrender'), /prebattle-(codec|sql)/)
                assert.deepEqual(f.state(), before)
                assert.equal(f.store.pending.get(f.session.id), pending)
                assert.deepEqual(
                    f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
                    saved,
                )
                if (packet) f.game.packet = packet
                else f.store.db.exec('DROP TRIGGER prebattle_fail')
                f.call('KiboDuelSurrender')
                assert.equal(f.state().combat.npcDuel.result.result, 2)
                assert.equal(f.state().noviceDuelFeverWins, undefined)
            } finally {
                if (packet) f.game.packet = packet
                f.close()
            }
        }
})

test('LOADING2 actual9510 immediately permits explicit loss without fever, and repeats or cold login cannot create events', () => {
    const f = fixture('prebattle-v3-loading', 2)
    try {
        assert.equal(f.state().combat.npcDuel.entities_sent, undefined)
        assert.equal(f.state().combat.npcDuel.regular_started_at, undefined)
        f.call('KiboDuelSurrender')
        const result = structuredClone(f.state().combat.npcDuel.result)
        assert.equal(result.result, 2)
        assert.equal(result.reason, 3)
        assert.equal(f.state().multiCampaign.arena_status, 5)
        f.call('KiboDuelSurrender')
        f.call('KiboDuelBattleFinish', { status: 1 })
        f.call('EnterGame', { open_id: f.name }, {})
        assert.deepEqual(f.state().combat.npcDuel.result, result)
        assert.equal(f.state().combat.npcDuel.noviceFeverReceipt, undefined)
        assert.equal(f.state().noviceDuelFeverWins, undefined)
        assert.equal(f.state().noviceDuelVictory, undefined)
        assert.equal(f.state().noviceDuelEventWins, undefined)
    } finally {
        f.close()
    }
})

test('LOADING2 fake victory/core mismatch still rejects and real surrender codec or SQL errors roll back completely', () => {
    for (const failure of ['codec', 'sql']) {
        const f = fixture('prebattle-v3-loading-' + failure, 2)
        let packet
        try {
            for (const variant of ['win', 'scene']) {
                const state = structuredClone(f.state())
                if (variant === 'scene') state.world.map_id++
                const before = structuredClone(state)
                assert.throws(
                    () =>
                        recordNoviceDuelFeverOutcome({ state, tables: f.tables, now: 1800000000 }, f.duel, {
                            result: variant === 'win' ? 1 : 2,
                            reason: variant === 'win' ? 1 : 3,
                        }),
                    (error) => error.code === ErrorCode.GameConfig,
                )
                assert.deepEqual(state, before)
            }
            f.store.transact(
                f.session.id,
                0,
                (state) => {
                    state.prebattlePendingMarker = true
                },
                { defer: true },
            )
            const before = structuredClone(f.state()),
                pending = f.store.pending.get(f.session.id),
                saved = f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id)
            if (failure === 'codec') {
                packet = f.game.packet
                f.game.packet = function (name, ...args) {
                    if (name === 'SCProtoKiboDuelArenaResultInfoSync') throw Error('loading-codec')
                    return packet.call(this, name, ...args)
                }
            } else
                f.store.db.exec(
                    "CREATE TRIGGER loading_fail BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT, 'loading-sql'); END",
                )
            assert.throws(() => f.call('KiboDuelSurrender'), /loading-(codec|sql)/)
            assert.deepEqual(f.state(), before)
            assert.equal(f.store.pending.get(f.session.id), pending)
            assert.deepEqual(
                f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
                saved,
            )
            if (packet) f.game.packet = packet
            else f.store.db.exec('DROP TRIGGER loading_fail')
            f.call('KiboDuelSurrender')
            assert.equal(f.state().combat.npcDuel.result.result, 2)
            assert.equal(f.state().noviceDuelFeverWins, undefined)
        } finally {
            if (packet) f.game.packet = packet
            f.close()
        }
    }
})
