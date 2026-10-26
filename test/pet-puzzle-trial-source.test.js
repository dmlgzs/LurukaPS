import test from 'node:test'
import assert from 'node:assert/strict'
import { puzzleFixture, puzzlePolicy, puzzleTables } from './pet-puzzle-progress-fixture.js'
import { populateParty } from './party-fixture.js'

test('actual map102 trial registration then actual9133 seals a temporary pet puzzle once and retains it after trial exit', () => {
    const f = puzzleFixture('puzzle-real-trial-source')
    try {
        f.edit((s) => {
            populateParty(s)
            s.world.map_id = 102
            s.world.point_id = 10201
            // Isolated legitimate quest/controller prerequisites. The actual
            // controller declares stateScene=[104,102], not an invented map.
            s.tasks = [
                {
                    task_id: 106002,
                    nodes: [{ node_id: 59, node_values: [0], client_before: true, client_cond_after: [false] }],
                    finish_nodes: [1, 56, 65, 61, 58, 63, 62, 57],
                    reward_nodes: [],
                },
            ]
            s.taskRecords = [{ task_id: 106001, count: 1, time: 1 }]
            s.player.group_mgrs[0].groups.find((g) => g.id === 1).heros[1].pet_id = s.pets[0].guid
        })
        f.call('TrialGroupChange', { open: true, force: false, trial_heros: [{ id: 107001, pos: -1 }] })
        f.call('TrialGroupChange', { open: true, force: false, trial_pets: [{ id: 102, pos: 1 }] })
        const pet = f.state().trialGroup.pets[0]
        const entries = puzzlePolicy.worlds.filter((r) => r.map === 102)
        assert.equal(entries.length, 2)
        const context = { ext_type: 1, ext_uint32_1: entries[0].attribute, ext_uint64_1: pet.guid }
        assert.ok(
            String(puzzleTables.find('pet', pet.config_id).element)
                .split('|')
                .map(Number)
                .includes(context.ext_uint32_1),
        )
        f.finishWorld(entries[0], context)
        assert.equal(f.state().petPuzzleProgress.revision, 1)
        assert.equal(f.state().petPuzzleProgress.facts[`world:102:${entries[0].id}`].scope, 'registered-temporary')
        f.call('TrialGroupChange', { open: false, force: true })
        const ledger = f.state().petPuzzleProgress
        f.finishWorld(entries[1], context)
        assert.deepEqual(f.state().petPuzzleProgress, ledger)
        assert.equal(f.state().worldObjects[`102:${entries[1].id}`].complete, true)
    } finally {
        f.close()
    }
})
