import test from 'node:test'
import assert from 'node:assert/strict'
import { ornamentFixture } from './helpers/ornament-fixture.js'
import { createCustomOrnaments } from '../src/ornaments.js'
import { ornamentInheritPlan } from '../src/ornament-inherit.js'
import { ErrorCode } from '../src/error-codes.js'

const enemy = ((3n << 56n) | 12347n).toString()
function fixture(name) {
    const f = ornamentFixture(name)
    f.store.transact(f.session.id, 0, (state) => {
        state.ornaments = []
        createCustomOrnaments(f.tables, state, 50052, 3, () => 0)
        state.ornaments[0].quality = 1
        state.ornaments[1].quality = 4
    })
    const [current, candidate] = f.state().ornaments,
        request = { target_quality_guid: candidate.guid, source_quality_guid: current.guid },
        plan = ornamentInheritPlan(f.tables, f.state(), request)
    f.store.transact(f.session.id, 0, (state) => {
        state.player.basic_info.gold = plan.gold
    })
    return { ...f, request, current: current.guid, candidate: candidate.guid }
}

test('6035 blocks before gold and quality swaps, then preserves both instances and swaps correctly after battle reset', () => {
    const f = fixture('ornament-inherit-battle-lock')
    try {
        f.call('PlayerHatredIncSync', {
            inc: true,
            info: { id: String(f.session.id), target_obj_ids: [enemy], player_obj_ids: [] },
        })
        const before = structuredClone(f.state())
        assert.throws(
            () => f.call('OrnamentInherit', f.request),
            (error) => error.code === ErrorCode.PlayerInFight,
        )
        assert.deepEqual(f.state(), before)
        f.call('HatredResetSync', { is_player: true, obj_id: String(f.session.id) })
        f.call('OrnamentInherit', f.request)
        const state = f.state()
        assert.equal(state.ornaments.length, before.ornaments.length)
        assert.equal(state.ornaments.find((item) => item.guid === f.current).quality, 4)
        assert.equal(state.ornaments.find((item) => item.guid === f.candidate).quality, 1)
        assert.equal(state.player.basic_info.gold, 0)
    } finally {
        f.store.close()
    }
})

test('6035 does not treat another player fighting as a battle of the current player', () => {
    const f = fixture('ornament-inherit-unrelated-fight')
    try {
        f.call('ObjHatredIncSync', {
            inc: true,
            info: { id: enemy, target_obj_ids: [], player_obj_ids: [f.session.id + 1] },
        })
        f.call('OrnamentInherit', f.request)
        assert.equal(f.state().ornaments.find((item) => item.guid === f.current).quality, 4)
    } finally {
        f.store.close()
    }
})
