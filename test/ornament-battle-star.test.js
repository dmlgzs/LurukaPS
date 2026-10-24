import test from 'node:test'
import assert from 'node:assert/strict'
import { ornamentFixture } from './helpers/ornament-fixture.js'
import { createCustomOrnaments } from '../src/ornaments.js'
import { ornamentStarPlan } from '../src/ornament-star.js'
import { grantRewards } from '../src/rewards.js'
import { ErrorCode } from '../src/error-codes.js'

const enemy = ((3n << 56n) | 12346n).toString()
function fixture(name) {
    const f = ornamentFixture(name)
    f.store.transact(f.session.id, 0, (state) => {
        state.ornaments = []
        createCustomOrnaments(f.tables, state, 50052, 17, () => 0)
    })
    const [target, ...materials] = f.state().ornaments,
        config = f.tables.find('accessory', target.id),
        row = f.tables.get('accessory_upgrade').find((entry) => entry.rarity === config.rarity && entry.grade === 1),
        request = { target_guid: target.guid, material_guids: materials.slice(0, row.count).map((item) => item.guid) },
        plan = ornamentStarPlan(f.tables, f.state(), request)
    f.store.transact(f.session.id, 0, (state) => grantRewards(f.tables, state, plan.costs))
    return { ...f, request }
}

test('6034 blocks a real player hatred relation before consuming donors, currency or granting material refunds', () => {
    const f = fixture('ornament-star-battle-lock')
    try {
        f.call('ObjHatredIncSync', {
            inc: true,
            info: { id: enemy, target_obj_ids: [], player_obj_ids: [f.session.id] },
        })
        const before = structuredClone(f.state())
        assert.throws(
            () => f.call('OrnamentGradeUp', f.request),
            (error) => error.code === ErrorCode.PlayerInFight,
        )
        assert.deepEqual(f.state(), before)
        f.call('HatredResetToHomeSync', { obj_id: enemy })
        f.call('OrnamentGradeUp', f.request)
        assert.equal(f.state().ornaments.find((item) => item.guid === f.request.target_guid).grade, 1)
        assert(f.request.material_guids.every((guid) => !f.state().ornaments.some((item) => item.guid === guid)))
    } finally {
        f.store.close()
    }
})

test('6034 remains available when only an unrelated player has an enemy relation', () => {
    const f = fixture('ornament-star-unrelated-battle')
    try {
        f.call('ObjHatredIncSync', {
            inc: true,
            info: { id: enemy, target_obj_ids: [], player_obj_ids: [f.session.id + 1] },
        })
        f.call('OrnamentGradeUp', f.request)
        assert.equal(f.state().ornaments.find((item) => item.guid === f.request.target_guid).grade, 1)
    } finally {
        f.store.close()
    }
})
