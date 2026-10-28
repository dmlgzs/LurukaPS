import test from 'node:test'
import assert from 'node:assert/strict'
import { noviceSpeciesFixture } from './novice-duel-species-fixture.js'
import { noviceEventFile } from './novice-duel-event-fixture.js'
import { noviceDuelSpeciesValue } from '../src/novice-duel-species.js'

const run = (f) => f.state().combat.npcDuel
const value = (f) => noviceDuelSpeciesValue(f.state(), 8)

test('seven species/eight real owned actors do not qualify; recall/redeploy and repeated settlement preserve one receipt', () => {
    const f = noviceSpeciesFixture('species-seven-eight')
    try {
        f.choose(7)
        f.enter(2001)
        assert.equal(f.actors().length, 8)
        assert.equal(new Set(f.actors().map((actor) => actor.config_id)).size, 7)
        const { first, current } = f.deploy()
        f.advance(20)
        f.summon(first, current)
        assert.equal(Object.keys(run(f).noviceEventFacts.deployments).length, 8)
        f.win()
        assert.equal(run(f).result.result, 1)
        assert.equal(run(f).noviceSpeciesVictoryReceipt.configIds.length, 7)
        assert.equal(f.state().noviceDuelSpeciesWins.counts[7], 1)
        assert.equal(value(f), 0)
        const before = structuredClone(f.state().noviceDuelSpeciesWins)
        f.call('KiboDuelBattleFinish', { status: 1 })
        f.relogin()
        assert.deepEqual(f.state().noviceDuelSpeciesWins, before)
    } finally {
        f.close()
    }
})

test('eight distinct owned species only count after all real accepted deployments and a real victory', () => {
    const f = noviceSpeciesFixture('species-eight-eight')
    try {
        f.choose()
        f.enter(2001)
        assert.equal(new Set(f.actors().map((actor) => actor.config_id)).size, 8)
        assert.equal(Object.keys(run(f).noviceEventFacts.deployments).length, 1)
        assert.equal(value(f), 0, 'A full roster is not an earned win')
        f.deploy()
        assert.equal(value(f), 0, 'Deployments without a victory are not a win')
        f.win()
        assert.equal(run(f).result.result, 1)
        assert.equal(value(f), 1)
        assert.equal(f.state().noviceDuelSpeciesWins.counts[8], 1)
        assert.equal(run(f).noviceSpeciesVictoryReceipt.configIds.length, 8)
        assert(
            Object.values(run(f).noviceEventFacts.deployments).every((row) => Number.isSafeInteger(row.acceptedAtMs)),
        )
    } finally {
        f.close()
    }
})

test('actual legal trial and owned deployments of the same species merge; surrender never mints a species win', () => {
    const f = noviceSpeciesFixture('species-trial-owned')
    try {
        f.edit((state) => {
            const trialSpecies = new Set(
                String(f.tables.find('kibo_duel', 1001).kiboList)
                    .split('|')
                    .map((id) => f.tables.find('trial_pet', Number(id)).trialPet),
            )
            const matching = state.pets.find((pet) => trialSpecies.has(pet.config_id)),
                different = state.pets.find((pet) => !trialSpecies.has(pet.config_id))
            assert(matching && different)
            state.pets = [matching, different, ...state.pets.filter((pet) => pet !== matching && pet !== different)]
        })
        f.enter(1001)
        assert.equal(f.actors().length, 8)
        assert.equal(new Set(f.actors().map((actor) => actor.config_id)).size, 7)
        f.deploy()
        f.win()
        assert.equal(run(f).result.result, 1)
        assert.equal(run(f).noviceSpeciesVictoryReceipt.configIds.length, 7)
        assert.equal(value(f), 0)
        f.call('MultiCampaignRestart')
        f.call('MultiCampaignPlayerLoadFinish')
        f.call('KiboDuelArenaFirstConfirmReq')
        f.finishPresentation()
        f.call('KiboDuelSurrender')
        assert.equal(run(f).result.result, 2)
        assert.equal(run(f).noviceSpeciesVictoryReceipt, undefined)
        assert.equal(value(f), 0)
    } finally {
        f.close()
    }
})

test('a late eighth request after the first real death outcome and untimed legacy deployments cannot qualify', () => {
    for (const legacy of [false, true]) {
        const f = noviceSpeciesFixture('species-ineligible-' + legacy)
        try {
            f.choose()
            f.enter(2001)
            const { current } = f.deploy(legacy ? 8 : 7)
            if (legacy)
                f.edit((state) => {
                    for (const fact of Object.values(state.combat.npcDuel.noviceEventFacts.deployments)) {
                        delete fact.acceptedAtMs
                        delete fact.terminalAlreadyKnown
                    }
                })
            f.prepareWin()()
            assert.equal(run(f).scoreOutcome.result, 1)
            if (!legacy) {
                const eighth = f.actors().find((actor) => !run(f).noviceEventFacts.deployments[actor.uuid])
                assert(eighth)
                f.advance(1)
                f.summon(eighth, current)
                assert.equal(run(f).noviceEventFacts.deployments[eighth.uuid], undefined)
            }
            f.tick()
            assert.equal(value(f), 0)
            assert.equal(run(f).noviceSpeciesVictoryReceipt.configIds.length, legacy ? 0 : 7)
        } finally {
            f.close()
        }
    }
})

for (const failure of ['codec', 'sql'])
    test(`eight-species final settlement ${failure} failure rolls back facts, receipts, pending and SQLite then retries once`, () => {
        const temp = noviceEventFile(),
            f = noviceSpeciesFixture('species-atomic-' + failure, { file: temp.file })
        let original
        try {
            f.choose()
            f.enter(2001)
            f.deploy()
            f.prepareWin()()
            const before = structuredClone(f.state()),
                pending = f.store.pending.get(f.session.id),
                sql = f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id)
            if (failure === 'codec') {
                original = f.protocol.encode
                f.protocol.encode = function (type, ...args) {
                    if (type === f.protocol.byName.get('CSProtoNoviceTaskInfoSync').rsp) throw Error('species-codec')
                    return original.call(this, type, ...args)
                }
            } else
                f.store.db.exec(
                    "CREATE TRIGGER species_fail BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'species-sql'); END",
                )
            assert.throws(() => f.tick(), /species-(codec|sql)/)
            assert.equal(f.store.pending.get(f.session.id), pending)
            assert.deepEqual(f.state(), before)
            assert.deepEqual(
                f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
                sql,
            )
            if (failure === 'codec') f.protocol.encode = original
            else f.store.db.exec('DROP TRIGGER species_fail')
            f.tick()
            assert.equal(value(f), 1)
            const earned = structuredClone(f.state().noviceDuelSpeciesWins)
            f.tick()
            f.relogin()
            assert.deepEqual(f.state().noviceDuelSpeciesWins, earned)
        } finally {
            if (original) f.protocol.encode = original
            f.store.db.exec('DROP TRIGGER IF EXISTS species_fail')
            try {
                f.close()
            } finally {
                temp.close()
            }
        }
    })
