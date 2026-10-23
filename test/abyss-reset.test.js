import test from 'node:test'
import assert from 'node:assert/strict'
import { abyssFixture } from './abyss-fixture.js'
import { ErrorCode } from '../src/error-codes.js'

test('11459 removes saved half-clear and locked teams without erasing historical best stars or either reward receipt', () => {
    const f = abyssFixture('abyss-reset')
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.abyss = {
                modes: {
                    1: {
                        levels: {
                            10001: {
                                passed: true,
                                star_num: 3,
                                pass_level_reward_flag: true,
                                challenge_list: [{ win: true }],
                                resume: { version: 1, completed_parts: 1 },
                            },
                        },
                        starClaims: [3],
                    },
                },
            }
        })
        f.call('AbyssChallengeReset', { mode: 1, abyss_level: 10001 })
        const record = f.state().abyss.modes[1].levels[10001]
        assert.equal(record.resume, undefined)
        assert.deepEqual(record.challenge_list, [])
        assert(record.passed && record.pass_level_reward_flag)
        assert.equal(record.star_num, 3)
        assert.deepEqual(f.state().abyss.modes[1].starClaims, [3])
        f.call('AbyssChallengeReset', { mode: 1, abyss_level: 10001 })
        assert.deepEqual(f.state().abyss.modes[1].levels[10001], record)
        assert.throws(
            () => f.call('AbyssChallengeReset', { mode: 1, abyss_level: 20001 }),
            (e) => e.code === ErrorCode.AbyssInvalidLevel,
        )
    } finally {
        f.store.close()
    }
})
test('11459 explicitly abandons an active challenge to its saved entrance, retires copied actors and allows a fresh first-room entry', () => {
    const f = abyssFixture('abyss-reset-active')
    try {
        const original = f.state().world
        f.call('AbyssChallenge', f.request())
        f.call('AbyssChallengeRealStart')
        f.call('AbyssChallengeReset', { mode: 1, abyss_level: 10001 })
        const state = f.state()
        assert.equal(state.abyssRun, undefined)
        assert.equal(state.world.map_id, original.map_id)
        assert.deepEqual(state.world.pos, original.pos)
        assert.equal(state.abyss.modes[1].levels[10001].resume, undefined)
        assert.deepEqual(state.abyss.modes[1].levels[10001].challenge_list, [])
        f.call('AbyssChallenge', f.request())
        assert.equal(f.state().abyssRun.part_index, 0)
        assert.equal(f.state().abyssRun.phase, 'ready')
    } finally {
        f.store.close()
    }
})
test('11459 encoding failure rolls back the active scene, copied actors and durable half-clear record together', () => {
    const f = abyssFixture('abyss-reset-codec')
    try {
        f.call('AbyssChallenge', f.request())
        const before = f.state(),
            encode = f.p.encode.bind(f.p)
        f.p.encode = (type, value) => {
            if (type === 'cs.SCAbyssLevelInfoUpdate') throw Error('abyss reset codec')
            return encode(type, value)
        }
        assert.throws(() => f.call('AbyssChallengeReset', { mode: 1, abyss_level: 10001 }), /abyss reset codec/)
        f.p.encode = encode
        assert.deepEqual(f.state(), before)
        assert.throws(
            () => f.call('AbyssChallengeReset', { mode: 1, abyss_level: 10002 }),
            (e) => e.code === ErrorCode.AbyssInvalidChallengeLevel,
        )
    } finally {
        f.store.close()
    }
})
