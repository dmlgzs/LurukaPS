import test from 'node:test'
import assert from 'node:assert/strict'
import { abyssFixture } from './abyss-fixture.js'
import { abyssDataSnapshot } from '../src/abyss-data.js'
import { abyssTables } from '../src/abyss-catalog.js'
import { ErrorCode } from '../src/error-codes.js'

test('11449 publishes only cumulative claimed star tiers so the Native suffix algorithm can identify a later claim', () => {
    const f = abyssFixture('abyss-star-contract')
    try {
        const tables = abyssTables(f.tables),
            empty = f.decode(f.call('AbyssData'), 'CSProtoAbyssData')
        assert.deepEqual(empty.newer_star_reward_info.reward_list, [])
        f.store.transact(f.session.id, 0, (s) => {
            s.abyss = { modes: { 1: { levels: {}, starClaims: [6, 3] } } }
        })
        const first = f.decode(f.call('AbyssData'), 'CSProtoAbyssData').newer_star_reward_info.reward_list
        assert.deepEqual(first, [
            { stage_num: 3, reward_flag: true },
            { stage_num: 6, reward_flag: true },
        ])
        f.store.transact(f.session.id, 0, (s) => {
            s.abyss.modes[1].starClaims.push(9)
        })
        const next = abyssDataSnapshot(tables, f.state(), f.time.now).newer_star_reward_info.reward_list
        assert.deepEqual(next.slice(first.length), [{ stage_num: 9, reward_flag: true }])
        assert.equal(tables.get('abbys_reward').filter((x) => x.groupId === 10001).length, 7)
    } finally {
        f.store.close()
    }
})
test('11449 rejects duplicate or foreign star claim tiers while never converting unearned tiers to claims', () => {
    const f = abyssFixture('abyss-star-contract-invalid')
    try {
        const tables = abyssTables(f.tables)
        for (const starClaims of [[3, 3], [4], [-3], [6]])
            assert.throws(
                () => abyssDataSnapshot(tables, { abyss: { modes: { 1: { levels: {}, starClaims } } } }, f.time.now),
                (e) => e.code === ErrorCode.GameConfig,
            )
    } finally {
        f.store.close()
    }
})
