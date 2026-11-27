import test from 'node:test'
import assert from 'node:assert/strict'
import { resetPlayableEntries, resetCampaignPlayableEntry } from '../src/campaign-playable-ledger.js'

test('entry cleanup replays only the supplied runs while retaining permanent score/stage claims and unrelated state', () => {
    // Explicit saved-receipt unit model,not proof of a real reward claim.
    const state = {
        playableRuns: {
            1: { play_id: 1, finish_step: 4 },
            2: { play_id: 2, finish_step: 8 },
            3: { play_id: 3, finish_step: 9 },
        },
        playableFinishes: {
            1: { play_id: 1, reward_info: 2 },
            2: { play_id: 2, reward_info: 8 },
            3: { play_id: 3, reward_info: 16 },
        },
        playableScoreClaims: { 1: 4, 3: 16 },
        playableStageClaims: { 1: { map_id: 6250, flag: '8' } },
        inventory: { held: 10 },
    }
    resetPlayableEntries(state, new Set([1, 2]))
    assert.deepEqual(state.playableRuns, { 3: { play_id: 3, finish_step: 9 } })
    assert.deepEqual(state.playableFinishes, { 3: { play_id: 3, reward_info: 16 } })
    assert.deepEqual(state.playableScoreClaims, { 1: 6, 2: 8, 3: 16 })
    assert.deepEqual(state.playableStageClaims, { 1: { map_id: 6250, flag: '8' } })
    assert.deepEqual(state.inventory, { held: 10 })
    const after = structuredClone(state)
    resetPlayableEntries(state, [1, 2])
    assert.deepEqual(state, after)
})

test('the existing local-campaign entry guard still controls cleanup and delegates the same permanent-claim preservation', () => {
    const state = { playableRuns: { 7: { play_id: 7 } }, playableFinishes: { 7: { play_id: 7, reward_info: 2 } } }
    const before = structuredClone(state)
    resetCampaignPlayableEntry(state, { playable_ids: [7] })
    assert.deepEqual(state, before)
    resetCampaignPlayableEntry(state, { local_playable_condition: true, playable_ids: [7] })
    assert.deepEqual(state.playableRuns, {})
    assert.deepEqual(state.playableFinishes, {})
    assert.deepEqual(state.playableScoreClaims, { 7: 2 })
})
