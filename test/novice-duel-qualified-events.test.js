import test from 'node:test'
import assert from 'node:assert/strict'
import { noviceEventFixture } from './novice-duel-event-fixture.js'
import { noviceNpcEventValue } from '../src/novice-duel-events.js'

const skillId = 19999901
const tag = 101
const run = (f) => f.state().combat.npcDuel
const castCount = (f) => Object.keys(run(f).noviceEventFacts?.casts ?? {}).length
const skillWins = (f) => noviceNpcEventValue(f.state(), 13056, skillId, 2)
const tagWins = (f) => noviceNpcEventValue(f.state(), 13055, tag, 1)
const gameNumber = (f, title) => Number(f.tables.get('game').find((row) => row.title === title).value)

function fixture(name) {
    const f = noviceEventFixture('qualified-' + name)
    try {
        f.selectTagged(tag)
        f.enterWithSkill(skillId)
        assert.equal(f.state().multiCampaign.arena_status, 4)
        return f
    } catch (error) {
        f.close()
        throw error
    }
}
function cooldown(f) {
    const logic = f.tables.get('skillsub_logic').find((row) => row.skillId === skillId)
    assert.equal(logic.kiBoCoolDownDefault, 0)
    assert.equal(logic.kiBoVersusCoolDown, 60000)
    assert.equal(Math.min(logic.coolDownCount, logic.coolDownCountDefault), 3)
    return logic.kiBoVersusCoolDown / 1000
}
function firstCast(f) {
    f.cast(skillId, '601')
    assert.equal(castCount(f), 1)
    assert.equal(run(f).trainer_cast_serial, 1)
    assert.equal(run(f).trainer_skills[skillId].charges, 2)
}
function secondCast(f) {
    f.cast(skillId, '602')
    // Qualification cannot silently change the established raw acceptance/fee.
    assert.equal(castCount(f), 2)
    assert.equal(run(f).trainer_cast_serial, 2)
    assert.equal(run(f).trainer_skills[skillId].charges, 1)
}
function defeatFirstEnemy(f) {
    const current = run(f),
        first = Object.values(current.actors).find((actor) => actor.camp === 1 && current.in_fight[actor.uuid]),
        enemy = Object.values(current.actors).find((actor) => actor.camp === 2 && current.in_fight[actor.uuid])
    assert(first && enemy)
    assert.equal(Object.keys(current.in_fight).filter((id) => current.actors[id].camp === 2).length, 1)
    f.call('BattleInfoReduce', {
        base_time: String(Math.round(f.now() * 1000)),
        uint64_dic: [first.uuid, enemy.uuid],
        battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -enemy.max_hp, dmg_inc_id: 1 } }],
    })
    assert.equal(f.state().combat.entities[enemy.uuid].hp, 0)
    assert.equal(run(f).in_fight[enemy.uuid], undefined)
}
function settleVictory(f) {
    f.tick()
    assert.equal(run(f).result.result, 1)
    assert.equal(f.state().multiCampaign.arena_status, 5)
}
function passiveSecondsRemaining(f) {
    const rates = String(f.tables.get('game').find((row) => row.title === 'KIBO_DUEL_ARENA_MODE_SCORE_VELOCITY').value)
        .split('|')
        .map((text) => text.split('#').map(Number))
        .sort((a, b) => a[0] - b[0])
    assert.equal(rates[0][0], 0)
    const current = run(f),
        fromMs = Math.round(f.now() * 1000),
        originMs = Math.round(current.regular_started_at * 1000),
        endMs = Math.round(current.end_at * 1000)
    let required = BigInt(current.scores[2]) * 1000n - BigInt(current.score_remainders?.[2] ?? 0)
    assert(required > 0n)
    // Independent table integration: the rate changes with battle age, not
    // with the time the field became empty. Carry is already earned loss.
    for (let i = 0; i < rates.length; i++) {
        const [at, rate] = rates[i]
        assert(Number.isInteger(at) && at >= 0 && Number.isInteger(rate) && rate >= 0)
        assert(i === 0 || at > rates[i - 1][0])
        const start = Math.max(fromMs, originMs + at * 1000),
            end = Math.min(endMs, originMs + (rates[i + 1]?.[0] ?? Infinity) * 1000)
        if (end <= start || rate === 0) continue
        const loss = BigInt(end - start) * BigInt(rate)
        if (required <= loss) {
            const untilZero = (required + BigInt(rate) - 1n) / BigInt(rate)
            return Number(BigInt(start - fromMs) + untilZero) / 1000
        }
        required -= loss
    }
    assert.fail('The actual score schedule cannot prove zero before timeout')
}
// Explicit nonterminal old-save precondition, not a claimed gameplay history.
// Scores stay positive; real10705 or the real timeout must prove the outcome.
function nonterminalOldScores(f, enemyScore) {
    assert(Number.isInteger(enemyScore) && enemyScore > 0)
    f.edit((state) => {
        const previous = state.combat.npcDuel
        assert.equal(previous.result, undefined)
        assert.equal(previous.scoreOutcome, undefined)
        state.combat.npcDuel = { ...previous, scores: { 1: 1000, 2: enemyScore } }
    })
}
function restartRegular(f) {
    f.call('MultiCampaignRestart')
    f.call('MultiCampaignPlayerLoadFinish')
    f.call('KiboDuelArenaFirstConfirmReq')
    f.finishPresentation()
    assert.equal(f.state().multiCampaign.arena_status, 4)
}

test('direct late11100 before any score-advance request is accepted raw but cannot qualify a35s victory', () => {
    const f = fixture('direct-late')
    try {
        cooldown(f)
        firstCast(f)
        defeatFirstEnemy(f)
        const zeroAfter = passiveSecondsRemaining(f)
        assert.equal(zeroAfter, 35)
        assert.equal(run(f).scoreOutcome, undefined)
        f.advance(run(f).regular_started_at + 130 - f.now())
        secondCast(f)
        assert.equal(run(f).scoreOutcome, undefined, 'No11810/tick/explicit score advance before this cast')
        settleVictory(f)
        assert.equal(run(f).scoreOutcome.atMs, Math.round((run(f).regular_started_at + zeroAfter) * 1000))
        assert.equal(skillWins(f), 0)
        assert.equal(tagWins(f), 1)
    } finally {
        f.close()
    }
})

for (const order of ['cast-before-death', 'cast-after-death']) {
    test(`same-millisecond accepted skill follows real HP-death ordering: ${order}`, () => {
        const f = fixture(order)
        try {
            firstCast(f)
            f.advance(cooldown(f))
            nonterminalOldScores(f, gameNumber(f, 'KIBO_DUEL_ARENA_MODE_DEAD_SCORE'))
            const atMs = Math.round(f.now() * 1000)
            if (order === 'cast-before-death') secondCast(f)
            defeatFirstEnemy(f)
            assert.equal(run(f).scoreOutcome.atMs, atMs)
            assert.equal(run(f).scoreOutcome.source, 'death')
            if (order === 'cast-after-death') secondCast(f)
            settleVictory(f)
            assert.equal(skillWins(f), order === 'cast-before-death' ? 1 : 0)
        } finally {
            f.close()
        }
    })
}

for (const terminal of ['passive', 'timeout']) {
    test(`a real ${terminal} terminal boundary precedes an accepted skill at the same millisecond`, () => {
        const f = fixture('equal-' + terminal)
        try {
            if (terminal === 'passive') {
                // Main systems use integer seconds; arena acceptance retains
                // the actual62.5s millisecond through Game's supported clock.
                f.game.clock = () => Math.floor(f.now())
                f.game.arenaClockMs = () => Math.round(f.now() * 1000)
            }
            firstCast(f)
            const readyAfter = cooldown(f)
            if (terminal === 'passive') {
                // Delay empty-field onset so the second cast really clears60s CD.
                f.advance(30)
                defeatFirstEnemy(f)
                const remaining = passiveSecondsRemaining(f)
                assert(30 + remaining >= readyAfter)
                f.advance(remaining)
            } else {
                nonterminalOldScores(f, 900)
                f.advance(run(f).end_at - f.now())
            }
            const actionAtMs = Math.round(f.now() * 1000)
            assert.equal(run(f).scoreOutcome, undefined)
            secondCast(f)
            settleVictory(f)
            assert.equal(run(f).result.reason, terminal === 'passive' ? 1 : 2)
            if (terminal === 'passive') assert.equal(run(f).scoreOutcome.atMs, actionAtMs)
            else assert.equal(Math.round(run(f).end_at * 1000), actionAtMs)
            assert.equal(skillWins(f), 0, 'A blanket <= outcomeAt rule would incorrectly admit this cast')
        } finally {
            f.close()
        }
    })
}

test('pre-pause accepted facts survive clock shifts while unfinished cold login/new generations cannot inherit casts', () => {
    const f = fixture('pause-generation')
    try {
        firstCast(f)
        f.advance(cooldown(f))
        secondCast(f)
        const beforePause = structuredClone(run(f).noviceEventFacts),
            pauseAt = f.now()
        f.call('GamePause', { operate: true, game_time: String(Math.round(pauseAt * 1000)) })
        f.advance(120)
        f.call('GamePause', { operate: false, game_time: String(Math.round(f.now() * 1000)) })
        assert.deepEqual(run(f).noviceEventFacts, beforePause)
        nonterminalOldScores(f, gameNumber(f, 'KIBO_DUEL_ARENA_MODE_DEAD_SCORE'))
        defeatFirstEnemy(f)
        settleVictory(f)
        assert.equal(skillWins(f), 1)
        assert.equal(tagWins(f), 1)
        restartRegular(f)
        assert.equal(castCount(f), 0)
        firstCast(f)
        const interruptedGeneration = run(f).generation
        f.relogin()
        f.enterWithSkill(skillId)
        assert(run(f).generation > interruptedGeneration)
        assert.equal(castCount(f), 0)
        nonterminalOldScores(f, gameNumber(f, 'KIBO_DUEL_ARENA_MODE_DEAD_SCORE'))
        defeatFirstEnemy(f)
        settleVictory(f)
        assert.equal(skillWins(f), 1, 'Unfinished old cast and prior generation cannot mint a second qualified win')
    } finally {
        f.close()
    }
})

test('untimed legacy facts stay readable without new qualification and preserve genuinely earned wins and10762 receipts', () => {
    const f = fixture('legacy-receipt')
    try {
        firstCast(f)
        f.advance(cooldown(f))
        secondCast(f)
        nonterminalOldScores(f, gameNumber(f, 'KIBO_DUEL_ARENA_MODE_DEAD_SCORE'))
        defeatFirstEnemy(f)
        settleVictory(f)
        assert.equal(skillWins(f), 1)
        const claimed = f.call('NoviceTaskFinish', { u32: 5101 }).find((packet) => packet.id === 10762)
        assert(
            claimed.data.rewards.length > 0,
            'Existing enabled area-victory task is claimed through the real protocol',
        )
        assert.equal(f.state().noviceTasks.completedTasks[5101], true)
        assert.equal(f.state().noviceTasks.claimedTasks[5101], true)
        const oldSkillWins = skillWins(f),
            oldTagWins = tagWins(f)
        restartRegular(f)
        firstCast(f)
        f.advance(cooldown(f))
        secondCast(f)
        // Only remove new fields from actual accepted records to model an old
        // schema. Never manufacture an accepted fact, completion or win ledger.
        f.edit((state) => {
            const facts = structuredClone(state.combat.npcDuel.noviceEventFacts)
            for (const row of [...Object.values(facts.deployments), ...Object.values(facts.casts)]) {
                delete row.acceptedAtMs
                delete row.terminalAlreadyKnown
            }
            state.combat.npcDuel = { ...state.combat.npcDuel, noviceEventFacts: facts }
        })
        nonterminalOldScores(f, gameNumber(f, 'KIBO_DUEL_ARENA_MODE_DEAD_SCORE'))
        defeatFirstEnemy(f)
        settleVictory(f)
        assert.equal(skillWins(f), oldSkillWins)
        assert.equal(tagWins(f), oldTagWins)
        assert.equal(f.state().noviceTasks.completedTasks[5101], true)
        assert.equal(f.state().noviceTasks.claimedTasks[5101], true)
        const duplicate = f.call('NoviceTaskFinish', { u32: 5101 }).find((packet) => packet.id === 10762)
        assert.deepEqual(duplicate.data.rewards, [])
    } finally {
        f.close()
    }
})
