import test from 'node:test'
import assert from 'node:assert/strict'
import { abyssFixture } from './abyss-fixture.js'
import { abyssBuffPlan } from '../src/abyss-buffs.js'
import { abyssTables } from '../src/abyss-catalog.js'

test('abyss buffs resolve actual selected table hero and monster element IDs', () => {
    const f = abyssFixture('abyss-buff-catalog')
    try {
        const tables = abyssTables(f.tables)
        for (const level of tables.get('abbys_level')) {
            const plan = abyssBuffPlan(f.tables, {
                level_id: level.id,
                part_index: 0,
                challenges: [{ buff_id: level.mode === 3 ? 2030001 : 0 }],
            })
            assert.deepEqual(plan.monster, level.id === 20002 ? [17001102] : [])
            if (level.mode === 3) assert.deepEqual(plan.hero, [17001204])
            else if (level.id === 20002) assert.deepEqual(plan.hero, [])
            else assert.deepEqual(plan.hero, [tables.find('abbys_buff', level.buffId).buffid])
        }
    } finally {
        f.store.close()
    }
})
test('11465 monster effects arrive after abyss manager data but before scene actors and are explicitly cleared on exit and an ordinary room', () => {
    const f = abyssFixture('abyss-buff-wire')
    try {
        f.store.transact(f.session.id, 0, (s) => {
            s.abyss = {
                modes: {
                    1: { levels: { 10007: { passed: true, star_num: 3 } } },
                    2: { levels: { 20001: { passed: true, star_num: 3 } } },
                },
            }
        })
        const entered = f.call('AbyssChallenge', f.request(2, 20002))
        assert.deepEqual(f.decode(entered, 'SCProtoAbyssDungeonMonsterBuffSync').buff_ids, [17001102])
        assert(entered.findIndex((x) => x.id === 11464) < entered.findIndex((x) => x.id === 11465))
        const scenePacketIndex = entered.findIndex(
            (x) => x.id === 9103 && f.p.decode(f.p.byName.get('CSProtoWorldMapSync').rsp, x.payload).cmd === 256,
        )
        assert(entered.findIndex((x) => x.id === 11465) < scenePacketIndex)
        const quit = f.call('AbyssChallengeQuit')
        assert.deepEqual(f.decode(quit, 'SCProtoAbyssDungeonMonsterBuffSync').buff_ids, [])
        const ordinary = f.call('AbyssChallenge', f.request())
        assert.deepEqual(f.decode(ordinary, 'SCProtoAbyssDungeonMonsterBuffSync').buff_ids, [])
    } finally {
        f.store.close()
    }
})
test('11465 encoding failure does not install an abyss run, consume an instance ID or alter the real party', () => {
    const f = abyssFixture('abyss-buff-codec')
    try {
        const before = f.state(),
            encode = f.p.encode.bind(f.p),
            buffType = f.p.byName.get('SCProtoAbyssDungeonMonsterBuffSync').rsp
        f.p.encode = (type, value) => {
            if (type === buffType) throw Error('abyss buff codec')
            return encode(type, value)
        }
        assert.throws(() => f.call('AbyssChallenge', f.request()), /abyss buff codec/)
        f.p.encode = encode
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})
