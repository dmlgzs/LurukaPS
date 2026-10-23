import test from 'node:test'
import assert from 'node:assert/strict'
import { abyssFixture } from './abyss-fixture.js'
import { ErrorCode } from '../src/error-codes.js'
import { heroBattleLimits } from '../src/battle.js'
test('11457 rebuilds a genuinely failed room from its frozen snapshot and only the retry entry tears down the old client manager', () => {
    const f = abyssFixture('abyss-retry')
    try {
        assert.throws(
            () => f.call('AbyssChallengeRetry'),
            (e) => e.code === ErrorCode.AbyssNoChallengeList,
        )
        const owned = f.state().player.heros_info.heros
        f.call('AbyssChallenge', f.request())
        f.call('AbyssChallengeRealStart')
        const first = f.state().abyssRun,
            hero = first.challenges[0].control
        f.time.now += 45
        f.call('BattleInfoReduce', {
            uint64_dic: [hero],
            battle_info: [{ hurt_info: { tar_id: '1', hp_change: -10000000 } }],
        })
        assert.equal(f.state().abyssRun.phase, 'lost')
        const retry = f.call('AbyssChallengeRetry'),
            run = f.state().abyssRun
        assert.equal(f.decode(retry, 'SCProtoAbyssDungeonInfoSync').is_retry, true)
        assert.equal(run.retry, false)
        assert.equal(run.phase, 'ready')
        assert.equal(run.total_battle_time, 0)
        assert.deepEqual(run.dead_hero_ids, [])
        assert.equal(
            f.state().player.heros_info.battle_infos.find((x) => x.hero_id === hero).hp,
            heroBattleLimits(first.heroAttrs[hero]).hp,
        )
        assert.deepEqual(run.heroAttrs, first.heroAttrs)
        assert.deepEqual(f.state().player.heros_info.heros, owned)
        assert(Object.values(f.state().combat.entities).every((x) => x.hp === x.max_hp))
        const started = f.call('AbyssChallengeRealStart')
        assert.equal(f.decode(started, 'SCProtoAbyssDungeonInfoSync').is_retry, false)
        assert.deepEqual(f.state().abyssRun.wave_objects, [1500006])
        assert.equal(f.state().abyss.modes[1].levels[10001].passed, false)
    } finally {
        f.store.close()
    }
})
test('11457 encoding failure preserves the actual ongoing room damage, time and completed waves', () => {
    const f = abyssFixture('abyss-retry-codec')
    try {
        f.call('AbyssChallenge', f.request())
        f.call('AbyssChallengeRealStart')
        const enemy = Object.values(f.state().combat.entities).find((x) => x.object_id === 1500006),
            hero = f.state().abyssRun.challenges[0].control
        f.call('BattleInfoReduce', {
            uint64_dic: [hero, enemy.uuid],
            battle_info: [{ hurt_info: { from_id: '1', tar_id: '2', hp_change: -1 } }],
        })
        f.time.now += 20
        const before = f.state(),
            encode = f.p.encode.bind(f.p)
        f.p.encode = (type, value) => {
            if (type === 'cs.SCAbyssDungeonInfoSync') throw Error('abyss retry codec')
            return encode(type, value)
        }
        assert.throws(() => f.call('AbyssChallengeRetry'), /abyss retry codec/)
        f.p.encode = encode
        assert.deepEqual(f.state(), before)
        f.call('AbyssChallengeRetry')
        assert.equal(f.state().abyssRun.phase, 'ready')
        assert.equal(f.state().abyssRun.total_battle_time, 0)
    } finally {
        f.store.close()
    }
})
