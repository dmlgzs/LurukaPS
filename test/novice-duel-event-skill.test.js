import test from 'node:test'
import assert from 'node:assert/strict'
import { noviceEventFixture } from './novice-duel-event-fixture.js'
import { noviceNpcEventValue } from '../src/novice-duel-events.js'

for (const skillId of [19999901, 19999902, 19999903, 19999904]) {
    test(`accepted trainer skill ${skillId} counts twice only after real cooldown and wins once`, () => {
        const f = noviceEventFixture('novice-skill-' + skillId)
        try {
            f.enterWithSkill(skillId)
            assert.equal(Object.keys(f.state().combat.npcDuel.noviceEventFacts.casts).length, 0)
            f.cast(skillId, '101')
            assert.equal(Object.keys(f.state().combat.npcDuel.noviceEventFacts.casts).length, 1)
            const accepted = structuredClone(f.state().combat.npcDuel.noviceEventFacts)
            f.cast(skillId, '101')
            f.cast(skillId, '102', 5)
            assert.deepEqual(f.state().combat.npcDuel.noviceEventFacts, accepted)
            const before = structuredClone(f.state())
            assert.throws(() => f.cast(skillId, '102'), /cooling down/)
            assert.deepEqual(f.state(), before)
            f.call('SkillStop', {
                unit_id: f.state().combat.npcDuel.trainer_guid,
                skill_id: String(skillId),
                op_time: String(f.now() * 1000 + 100),
                verify_info: { related_index: '101', source_type: 1 },
            })
            assert.deepEqual(
                f.state().combat.npcDuel.noviceEventFacts,
                accepted,
                'Stopping does not undo an accepted cast',
            )
            const logic = f.tables.get('skillsub_logic').find((r) => r.skillId === skillId)
            f.advance(Math.ceil(logic.kiBoVersusCoolDown / 1000) + 1)
            f.cast(skillId, '102')
            assert.equal(Object.keys(f.state().combat.npcDuel.noviceEventFacts.casts).length, 2)
            assert.equal(noviceNpcEventValue(f.state(), 13056, skillId, 2), 0)
            f.win()
            assert.equal(noviceNpcEventValue(f.state(), 13056, skillId, 2), 1)
            const receipt = structuredClone(f.state().combat.npcDuel.noviceEventVictoryReceipt)
            f.call('KiboDuelBattleFinish', { status: 1 })
            assert.deepEqual(f.state().combat.npcDuel.noviceEventVictoryReceipt, receipt)
        } finally {
            f.close()
        }
    })
}

test('an accepted cast can be lost without minting a win; internal cast serial is a safe integer, not wire uint32', () => {
    const f = noviceEventFixture('novice-skill-serial')
    try {
        f.enterWithSkill(19999901)
        f.edit((s) => {
            s.combat.npcDuel = { ...s.combat.npcDuel, trainer_cast_serial: 0xffffffff }
        })
        f.cast(19999901, '201')
        assert(f.state().combat.npcDuel.noviceEventFacts.casts['4294967296'])
        f.call('KiboDuelSurrender')
        assert.equal(f.state().noviceDuelEventWins, undefined)
        f.call('MultiCampaignQuit')
        f.enterWithSkill(19999901)
        assert.equal(Object.keys(f.state().combat.npcDuel.noviceEventFacts.casts).length, 0)
    } finally {
        f.close()
    }
})
