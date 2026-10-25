import test from 'node:test'
import assert from 'node:assert/strict'
import { soulProgressFixture, packedSoul } from './pet-star-soul-progress-fixture.js'
import { achievementCatalogue, achievementPoints } from '../src/achievements.js'
import { petStarSoulProgressRule, petStarSoulProgressValue } from '../src/pet-star-soul-progress.js'
import { seedPlayer, Tables } from '../src/player.js'
import { petData } from '../src/pets.js'
import { ErrorCode } from '../src/error-codes.js'

test('15045 target shape, ordered successor and permanent-instance identity reject counterfeit packed or short-template states', () => {
    const f = soulProgressFixture('pet-soul-domain')
    try {
        const model = achievementCatalogue(f.tables),
            rows = model.rows.filter((row) => row.finishCondition.startsWith('15045#'))
        assert.equal(rows.length, 3)
        assert(rows.every((row) => model.rules.get(row.id).supported))
        const all = seedPlayer(f.tables, 99, 'pet-soul-untrained')
        assert.equal(petStarSoulProgressValue(f.tables, all, [15045, 1, 2, 1]), 0)
        assert(all.pets.some((pet) => !Number.isInteger(f.tables.find('pet', pet.config_id).starsoulId)))
        const pet = structuredClone(f.target(f.ids[0])),
            state = { pets: [pet] }
        pet.soul_link_level = packedSoul(2, 1)
        assert.equal(petStarSoulProgressValue(f.tables, state, [15045, 1, 2, 1]), 1)
        for (const tokens of [
            [15045, 1, 1, 1],
            [15045, 0, 1, 1],
            [15045, 6, 99, 1],
            [15045, 6, 1, 0],
            [15045, 6, 1, 1, 0],
        ])
            assert.equal(petStarSoulProgressRule(f.tables, tokens), false)
        for (const raw of [packedSoul(2, 0), packedSoul(0, 1), '18446744073709551616', Number.MAX_SAFE_INTEGER + 1]) {
            pet.soul_link_level = raw
            assert.throws(
                () => petStarSoulProgressValue(f.tables, state, [15045, 6, 1, 1]),
                (error) => error.code === ErrorCode.GameConfig,
            )
        }
        pet.soul_link_level = packedSoul(6, 1)
        for (const guid of ['18446744073709551616', Number.MAX_SAFE_INTEGER + 1, '0']) {
            const bad = { pets: [{ ...pet, guid }] }
            assert.throws(
                () => petStarSoulProgressValue(f.tables, bad, [15045, 6, 1, 1]),
                (error) => error.code === ErrorCode.GameConfig,
            )
        }
        assert.throws(
            () =>
                petStarSoulProgressValue(
                    f.tables,
                    {
                        pets: [
                            { ...pet, guid: '1' },
                            { ...pet, guid: '01' },
                        ],
                    },
                    [15045, 6, 1, 1],
                ),
            (error) => error.code === ErrorCode.GameConfig,
        )
        assert.equal(
            petStarSoulProgressValue(
                f.tables,
                {
                    pets: [
                        { ...pet, guid: '1' },
                        { ...pet, guid: '2' },
                    ],
                },
                [15045, 6, 1, 1],
            ),
            2,
            'same species different permanent instances each count',
        )
        for (const mark of ['trial', 'trail', 'is_trial', 'abyss'])
            assert.equal(petStarSoulProgressValue(f.tables, { pets: [{ ...pet, [mark]: true }] }, [15045, 6, 1, 1]), 0)
        assert.equal(petStarSoulProgressValue(f.tables, { pets: [{ ...pet, type: 2 }] }, [15045, 6, 1, 1]), 0)
        const terminal = f.tables
            .get('pet')
            .find((row) => row.starsoulId === 3000 && f.tables.find('template_value', row.id))
        const short = petData(f.tables, terminal.id, '99999', 101)
        assert.equal(petStarSoulProgressValue(f.tables, { pets: [short] }, [15045, 6, 1, 1]), 0)
        short.soul_link_level = packedSoul(6, 1)
        assert.throws(
            () => petStarSoulProgressValue(f.tables, { pets: [short] }, [15045, 6, 1, 1]),
            (error) => error.code === ErrorCode.GameConfig,
        )
    } finally {
        f.store.close()
    }
})

test('100 real permanent pets each complete20 paid11912 successors then6512 release and cumulatively satisfy every achievement threshold', () => {
    const f = soulProgressFixture('pet-soul-hundred', 100)
    try {
        for (const [index, guid] of f.ids.entries()) {
            f.advance(guid, 6, 1)
            f.call('DelPet', { pet_list: [guid] })
            assert.equal(f.target(guid), undefined)
            if ([0, 9, 99].includes(index))
                assert.equal(petStarSoulProgressValue(f.tables, f.state(), [15045, 6, 1, 100]), index + 1)
        }
        assert.equal(f.state().pets.length, 0)
        assert.equal(Object.keys(f.state().petStarSoulProgress.entries).length, 100)
        for (const [id, count] of [
            [4020033, 1],
            [4020034, 10],
            [4020035, 100],
        ]) {
            assert.equal(f.state().achievements.entries[id].value, count)
            assert(f.state().achievements.entries[id].finishTime > 0)
            assert.deepEqual(f.reply(f.call('AchievementReward', { u32: id }), 9902).rewards, [])
            assert.deepEqual(f.reply(f.call('AchievementReward', { u32: id }), 9902).rewards, [])
        }
        assert(achievementPoints(f.tables, f.state()) >= 17)
    } finally {
        f.store.close()
    }
})

test('last real11912 transition and new achievement completion roll back together on sync encoding failure', () => {
    const f = soulProgressFixture('pet-soul-codec'),
        guid = f.ids[0]
    try {
        f.advance(guid, 5, 6)
        const before = structuredClone(f.state()),
            encode = f.protocol.encode
        f.protocol.encode = function (name, ...args) {
            if (name.replace(/^cs\./, '') === 'SCAchievementSync') throw Error('pet soul progress codec')
            return encode.call(this, name, ...args)
        }
        try {
            assert.throws(() => f.call('KiboStarLinkSoulUpdate', { u64: guid }), /pet soul progress codec/)
            assert.deepEqual(f.state(), before)
        } finally {
            f.protocol.encode = encode
        }
        f.advance(guid, 6, 1)
        assert(f.state().achievements.entries[4020033].finishTime > 0)
    } finally {
        f.store.close()
    }
})
