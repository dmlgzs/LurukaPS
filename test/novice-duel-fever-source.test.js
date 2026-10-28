import test from 'node:test'
import assert from 'node:assert/strict'
import { noviceDuelFixture } from './novice-duel-victory-fixture.js'
import { advanceArenaScores } from '../src/npc-kibo-clock.js'
import { npcArenaOutcome } from '../src/npc-kibo-result.js'
import { recordNpcArenaDeaths } from '../src/npc-kibo-battle.js'
import { noviceDuelFeverValue } from '../src/novice-duel-fever.js'

const run = (f) => f.state().combat.npcDuel
function firstActors(f) {
    const current = run(f)
    return {
        self: Object.values(current.actors).find((actor) => actor.camp === 1 && current.in_fight[actor.uuid]),
        enemy: Object.values(current.actors).find((actor) => actor.camp === 2 && current.in_fight[actor.uuid]),
    }
}
function kill(f, source, target) {
    return f.call('BattleInfoReduce', {
        uint64_dic: [source.uuid, target.uuid],
        battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -target.max_hp } }],
    })
}
function emptyEnemy(f) {
    f.call('ControlMapAI', { control_type: 1, status: 1 })
    const actors = firstActors(f)
    kill(f, actors.self, actors.enemy)
    return actors
}

test('real early passive zero at35s stays non-fever on a250s tick and uses that instant for mask, clearance and wire clock', () => {
    const f = noviceDuelFixture('fever-early-passive')
    try {
        f.enter(2001)
        const start = run(f).regular_started_at
        emptyEnemy(f)
        f.advance(250)
        const packets = f.tick(),
            current = run(f)
        assert.equal(current.scoreOutcome.atMs, Math.round((start + 35) * 1000))
        assert.equal(current.result.clearance_time, '265')
        assert.equal(current.result.star, 7)
        assert.equal(current.noviceFeverReceipt.fever, false)
        assert.equal(noviceDuelFeverValue(f.state()), 0)
        const fighting = packets.find((packet) => packet.id === 10743)?.data
        if (fighting) assert.equal(fighting.end_time, Math.floor(start + 35))
        const saved = structuredClone(current.noviceFeverReceipt)
        f.call('KiboDuelBattleFinish', { status: 2 })
        f.call('KiboDuelSurrender')
        f.relogin()
        assert.deepEqual(run(f).noviceFeverReceipt, saved)
        assert.equal(run(f).result.result, 1)
    } finally {
        f.close()
    }
})

test('existing rate segments and fractional carry locate the first zero millisecond, without later opposite death rewriting it', () => {
    const f = noviceDuelFixture('fever-rate-tables')
    try {
        // Pure clock boundary vector with actual current rate table; not a Game-earned victory.
        const state = {
            world: { map_id: 1 },
            multiCampaign: { arena_status: 4 },
            combat: {
                entities: { a: { hp: 0 } },
                npcDuel: {
                    map_id: 1,
                    regular_started_at: 0,
                    end_at: 300,
                    score_at: 59.995,
                    scores: { 1: 1000, 2: 2 },
                    score_remainders: { 2: 900 },
                    in_fight: { a: {} },
                    actors: { a: { camp: 1 } },
                    dead: {},
                },
            },
        }
        const c = { state, tables: f.tables, now: 70, push: () => {} }
        advanceArenaScores(c)
        assert.equal(state.combat.npcDuel.scoreOutcome.atMs, 60020)
        assert.deepEqual(npcArenaOutcome(state, 70), { result: 1, reason: 1 })
        const saved = structuredClone(state.combat.npcDuel.scoreOutcome)
        recordNpcArenaDeaths(c)
        assert.deepEqual(state.combat.npcDuel.scoreOutcome, saved)
        assert.equal(state.combat.npcDuel.scores[1], 1000)
    } finally {
        f.close()
    }
})

test('real paused gameplay clocks and real timeout wins use frozen active time, never wall-time pause or late processing', () => {
    for (const variant of ['pause', 'timeout']) {
        const f = noviceDuelFixture('fever-' + variant)
        try {
            f.enter(2001)
            f.call('ControlMapAI', { control_type: 1, status: 1 })
            if (variant === 'pause') {
                f.advance(110)
                f.call('GamePause', { operate: true })
                f.advance(500)
                assert.deepEqual(f.tick(), [])
                f.call('GamePause', { operate: false })
                const start = run(f).regular_started_at
                emptyEnemy(f)
                f.advance(100)
                f.tick()
                assert.equal(run(f).noviceFeverReceipt.elapsedMs, 127500)
                assert.equal(run(f).scoreOutcome.atMs, Math.round((start + 127.5) * 1000))
                assert.equal(run(f).result.clearance_time, '173')
            } else {
                const { self, enemy } = firstActors(f)
                kill(f, self, enemy)
                f.advance(4)
                const replacement = Object.values(run(f).actors).find(
                    (actor) => actor.camp === 2 && actor.uuid !== enemy.uuid,
                )
                f.call('PVEEnemySummonReq', {
                    pet_guid: replacement.uuid,
                    pos: run(f).positions.enemySummon.pos,
                    angle: replacement.angle,
                })
                f.advance(400)
                f.tick()
                assert.equal(run(f).result.reason, 2)
                assert.equal(run(f).noviceFeverReceipt.atMs, Math.round(run(f).end_at * 1000))
                assert.equal(run(f).result.clearance_time, '0')
            }
            assert.equal(run(f).result.result, 1)
            assert.equal(run(f).noviceFeverReceipt.fever, true)
            assert.equal(noviceDuelFeverValue(f.state()), 1)
        } finally {
            f.close()
        }
    }
})

test('real same-batch double-zero remains draw; later opposite HP report cannot replace an already accepted first winner', () => {
    for (const simultaneous of [true, false]) {
        const f = noviceDuelFixture('fever-death-order-' + simultaneous)
        try {
            f.enter(2001)
            f.call('ControlMapAI', { control_type: 1, status: 1 })
            const { self, enemy } = firstActors(f)
            f.store.transact(f.session.id, 0, (state) => {
                state.combat.npcDuel.scores = { 1: 125, 2: 125 }
            })
            // Scores are a controlled pre-terminal fixture; the deaths themselves are actual accepted BIR.
            if (simultaneous)
                f.call('BattleInfoReduce', {
                    uint64_dic: [self.uuid, enemy.uuid],
                    battle_info: [
                        { hurt_info: { from_id: '1', tar_id: '2', hp_change: -enemy.max_hp } },
                        { hurt_info: { from_id: '2', tar_id: '1', hp_change: -self.max_hp } },
                    ],
                })
            else {
                kill(f, self, enemy)
                f.call('KiboDuelSurrender')
            }
            f.tick()
            assert.equal(run(f).result.result, simultaneous ? 3 : 1)
            assert.equal(run(f).scoreOutcome.source, 'death')
            assert.equal(noviceDuelFeverValue(f.state()), 0)
        } finally {
            f.close()
        }
    }
})

test('legacy already-zero score without a terminal event keeps the original reward but cannot mint a fever fact', () => {
    const f = noviceDuelFixture('fever-legacy-no-time')
    try {
        f.enter(2001)
        f.store.transact(f.session.id, 0, (state) => {
            state.combat.npcDuel.scores[2] = 0
        })
        f.advance(150)
        f.tick()
        assert.equal(run(f).result.result, 1)
        assert.equal(run(f).noviceFeverReceipt.known, false)
        assert.equal(noviceDuelFeverValue(f.state()), 0)
    } finally {
        f.close()
    }
})

for (const failure of ['codec', 'sql']) {
    test(`actual fever settlement ${failure} failure preserves pending, SQL, source and completion then commits only once`, () => {
        const f = noviceDuelFixture('fever-rollback-' + failure)
        let packet
        try {
            f.enter(2001)
            f.prepareWin()()
            const pending = f.store.pending.get(f.session.id),
                before = structuredClone(f.state()),
                sql = () =>
                    f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
                saved = sql()
            if (failure === 'codec') {
                packet = f.game.packet
                f.game.packet = function (name, ...args) {
                    if (name === 'SCProtoKiboDuelArenaResultInfoSync') throw Error('fever-codec')
                    return packet.call(this, name, ...args)
                }
            } else
                f.store.db.exec(
                    "CREATE TRIGGER fever_fail BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT, 'fever-sql'); END",
                )
            assert.throws(() => f.tick(), /fever-(codec|sql)/)
            assert.equal(f.store.pending.get(f.session.id), pending)
            assert.deepEqual(f.state(), before)
            assert.deepEqual(sql(), saved)
            if (packet) f.game.packet = packet
            else f.store.db.exec('DROP TRIGGER fever_fail')
            f.tick()
            assert.equal(noviceDuelFeverValue(f.state()), 1)
            f.call('KiboDuelBattleFinish', { status: 1 })
            assert.equal(noviceDuelFeverValue(f.state()), 1)
        } finally {
            if (packet) f.game.packet = packet
            f.close()
        }
    })
}
