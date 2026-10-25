import test from 'node:test'
import assert from 'node:assert/strict'
import { abyssFixture } from './abyss-fixture.js'
import { prepareBattlePass } from '../src/battle-pass.js'
import { taskId, current, enterTarget, clearRoom } from './battle-pass-abyss-fixture.js'

test('18003 batch includes the genuinely cleared abyss task at weekly XP cap and rolls back its receipt with the batch', () => {
    const f = abyssFixture('pass-abyss-batch')
    try {
        enterTarget(f)
        clearRoom(f)
        f.call('AbyssChallengeNext')
        f.call('AbyssChallengeRealStart')
        clearRoom(f)
        f.call('AbyssChallengeQuit')
        f.store.transact(f.session.id, 0, (state) => {
            prepareBattlePass(f.tables, state, f.time.now).ledger.curr_week_exp = 10000
        })
        const before = structuredClone(f.state()),
            encode = f.p.encode
        f.p.encode = function (name, ...args) {
            if (name.replace(/^cs\./, '') === 'Rewards') throw Error('abyss pass batch codec')
            return encode.call(this, name, ...args)
        }
        try {
            assert.throws(() => f.call('BattlePassGetAllTaskReward'), /abyss pass batch codec/)
            assert.deepEqual(f.state(), before)
        } finally {
            f.p.encode = encode
        }
        const reply = f.call('BattlePassGetAllTaskReward').find((packet) => packet.id === 18003)
        assert(f.p.decode('Rewards', reply.payload).rewards.some((row) => row.itemid === 50 && row.itemnum >= 2000))
        assert.equal(current(f).state, 2)
        assert.equal(prepareBattlePass(f.tables, f.state(), f.time.now).ledger.curr_week_exp, 10000)
        assert.deepEqual(
            f.p.decode('Rewards', f.call('BattlePassGetAllTaskReward').find((packet) => packet.id === 18003).payload)
                .rewards,
            [],
        )
    } finally {
        f.store.close()
    }
})
