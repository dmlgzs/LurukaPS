import test from 'node:test'
import assert from 'node:assert/strict'
import { noviceEventFixture, noviceEventFile } from './novice-duel-event-fixture.js'
import { noviceNpcEventValue } from '../src/novice-duel-events.js'

for (const tag of [101, 206, 202, 105]) {
    test(`tag ${tag} uses actual initial and accepted deploys; recall/redeploy does not add another actor`, () => {
        const f = noviceEventFixture('novice-tags-' + tag)
        try {
            f.selectTagged(tag)
            f.enter(2001)
            const run = f.state().combat.npcDuel,
                first = f.actors().find((a) => run.in_fight[a.uuid]),
                second = f
                    .actors()
                    .find(
                        (a) =>
                            a.uuid !== first.uuid &&
                            String(f.tables.find('pet', a.config_id).kiboDuelTag).split('|').map(Number).includes(tag),
                    )
            assert(first && second)
            assert.equal(
                Object.keys(run.noviceEventFacts.deployments).length,
                1,
                'Only the actual first deployment counts',
            )
            assert.equal(noviceNpcEventValue(f.state(), 13055, tag, 2), 0)
            f.advance(3)
            f.summon(second, first)
            const firstFacts = structuredClone(f.state().combat.npcDuel.noviceEventFacts)
            assert.equal(Object.keys(firstFacts.deployments).length, 2)
            f.summon(second)
            assert.deepEqual(f.state().combat.npcDuel.noviceEventFacts, firstFacts)
            f.advance(20)
            f.summon(first, second)
            assert.deepEqual(f.state().combat.npcDuel.noviceEventFacts, firstFacts)
            for (const row of Object.values(firstFacts.deployments)) {
                assert.equal(row.sourceGuid, f.state().combat.npcDuel.actors[row.uuid].source_guid)
                assert.equal(typeof row.sourceGuid, 'string')
            }
            f.win()
            assert.equal(noviceNpcEventValue(f.state(), 13055, tag, 2), 1)
            assert.equal(f.state().noviceDuelVictory.counts['1:3'], 1, 'Existing area/star family coexists')
            const saved = structuredClone(f.state().noviceDuelEventWins)
            f.call('KiboDuelBattleFinish', { status: 1 })
            f.relogin()
            assert.deepEqual(f.state().noviceDuelEventWins, saved)
        } finally {
            f.close()
        }
    })
}

test('a legal mixed trial deployment is recorded by runtime identity; enemy and a losing run never add victory counters', () => {
    const f = noviceEventFixture('novice-trial-deploy')
    try {
        f.enter(1001)
        const run = f.state().combat.npcDuel,
            trialIds = new Set(run.formation_snapshot.pet_guids.filter((p) => p.is_trial).map((p) => p.guid)),
            trial = f.actors().find((a) => trialIds.has(a.source_guid))
        assert(trial, 'The real table-locked mixed formation contains a trial source')
        f.advance(3)
        f.summon(trial)
        const facts = f.state().combat.npcDuel.noviceEventFacts
        assert(facts.deployments[trial.uuid])
        assert.equal(facts.deployments[trial.uuid].sourceGuid, trial.source_guid)
        assert(Object.keys(facts.deployments).every((id) => f.state().combat.npcDuel.actors[id].camp === 1))
        f.call('KiboDuelSurrender')
        assert.equal(f.state().noviceDuelEventWins, undefined)
        assert.equal(f.state().combat.npcDuel.noviceEventVictoryReceipt, undefined)
    } finally {
        f.close()
    }
})

for (const failure of ['codec', 'sql']) {
    test(`accepted11810 facts survive ${failure} rollback at their actual acknowledgement or durable victory boundary`, () => {
        const temp = noviceEventFile(),
            f = noviceEventFixture('novice-deploy-' + failure, { file: temp.file })
        let original
        try {
            f.selectTagged(101)
            f.enter(2001)
            f.advance(3)
            const run = f.state().combat.npcDuel,
                first = f.actors().find((a) => run.in_fight[a.uuid]),
                second = f.actors().find((a) => a.uuid !== first.uuid)
            if (failure === 'sql') {
                f.summon(second, first)
                f.prepareWin()()
            }
            const before = structuredClone(f.state()),
                pending = f.store.pending.get(f.session.id),
                saved = f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id)
            if (failure === 'codec') {
                original = f.protocol.encode
                f.protocol.encode = function (type, ...args) {
                    if (type === f.protocol.byName.get('CSProtoKiboDuelArenaSummonReq').rsp) throw Error('deploy-codec')
                    return original.call(this, type, ...args)
                }
            } else
                f.store.db.exec(
                    "CREATE TRIGGER deploy_fail BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT, 'deploy-sql'); END",
                )
            assert.throws(() => (failure === 'codec' ? f.summon(second, first) : f.tick()), /deploy-(codec|sql)/)
            assert.equal(f.store.pending.get(f.session.id), pending)
            assert.deepEqual(f.state(), before)
            assert.deepEqual(
                f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
                saved,
            )
            if (failure === 'codec') {
                f.protocol.encode = original
                f.summon(second, first)
                f.summon(second)
            } else {
                f.store.db.exec('DROP TRIGGER deploy_fail')
                f.tick()
                assert.equal(noviceNpcEventValue(f.state(), 13055, 101, 2), 1)
            }
            assert.equal(Object.keys(f.state().combat.npcDuel.noviceEventFacts.deployments).length, 2)
        } finally {
            if (original) f.protocol.encode = original
            f.store.db.exec('DROP TRIGGER IF EXISTS deploy_fail')
            try {
                f.close()
            } finally {
                temp.close()
            }
        }
    })
}
