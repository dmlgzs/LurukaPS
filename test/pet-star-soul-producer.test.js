import test from 'node:test'
import assert from 'node:assert/strict'
import { soulProgressFixture } from './pet-star-soul-progress-fixture.js'
import { achievementCatalogue } from '../src/achievements.js'
import { journeyModel } from '../src/journey.js'
import { petStarSoulProgressValue } from '../src/pet-star-soul-progress.js'

test('11912 producer records real attainments independently of the separately introduced15045 consumers', () => {
    const f = soulProgressFixture('soul-producer-only')
    try {
        const achievementEnabled = achievementCatalogue(f.tables).rules.get(4020033).supported,
            journeyEnabled = journeyModel(f.tables)
                .byKind.get(15045)
                .every((row) => row.supported)
        const id = f.ids[0]
        assert.equal(f.target(id).satiety_val, 60, '241 initial satiety policy survives the allocator change')
        f.advance(id, 6, 1)
        assert.equal(petStarSoulProgressValue(f.tables, f.state(), [15045, 6, 1, 100]), 1)
        if (achievementEnabled) assert(f.state().achievements.entries[4020033]?.finishTime > 0)
        else assert.equal(f.state().achievements.entries[4020033], undefined)
        assert.equal(f.state().journey.targets[4060201]?.complete ?? false, journeyEnabled)
        f.call('DelPet', { pet_list: [id] })
        assert.equal(f.target(id), undefined)
        assert.equal(petStarSoulProgressValue(f.tables, f.state(), [15045, 6, 1, 100]), 1)
    } finally {
        f.store.close()
    }
})

test('11912 producer facts, payments, soul level and skills roll back with real SQL save and upgrade ACK failures', () => {
    const f = soulProgressFixture('soul-producer-atomic')
    try {
        const id = f.ids[0]
        f.advance(id, 5, 6)
        const before = structuredClone(f.state())
        f.store.db.exec(
            "CREATE TEMP TRIGGER fail_soul_producer BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT, 'soul producer SQL'); END",
        )
        try {
            assert.throws(() => f.call('KiboStarLinkSoulUpdate', { u64: id }), /soul producer SQL/)
            assert.deepEqual(f.state(), before)
        } finally {
            f.store.db.exec('DROP TRIGGER fail_soul_producer')
        }
        const encode = f.protocol.encode,
            reply = f.protocol.byName.get('CSProtoKiboStarLinkSoulUpdate').rsp
        f.protocol.encode = function (name, ...args) {
            if (name === reply) throw Error('soul producer ACK')
            return encode.call(this, name, ...args)
        }
        try {
            assert.throws(() => f.call('KiboStarLinkSoulUpdate', { u64: id }), /soul producer ACK/)
            assert.deepEqual(f.state(), before)
        } finally {
            f.protocol.encode = encode
        }
        f.advance(id, 6, 1)
        assert.equal(petStarSoulProgressValue(f.tables, f.state(), [15045, 6, 1, 1]), 1)
    } finally {
        f.store.close()
    }
})
