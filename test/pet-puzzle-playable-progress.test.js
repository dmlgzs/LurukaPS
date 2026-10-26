import test from 'node:test'
import assert from 'node:assert/strict'
import {
    puzzleFixture,
    puzzlePolicy,
    puzzleProtocol,
    puzzleTables,
    puzzleWorld,
    playableRows,
} from './pet-puzzle-progress-fixture.js'
import { petPuzzleContextActor } from '../src/pet-puzzle-progress.js'
import { populateParty } from './party-fixture.js'

function located(id) {
    for (const map of [100, 101, 102, 200, 610, 6155, 921, 922, 924, 944]) {
        if (puzzleWorld.get('worldmap_' + map).some((row) => row.expandId === id)) return map
    }
    throw Error('No current playable entry ' + id)
}
function start(f, id) {
    f.edit((s) => {
        s.world.map_id = located(id)
    })
    f.call('PlayableStart', { u32: id })
    f.call('PlayableStep', {
        playId: id,
        is_step: true,
        finish_step: Math.max(1, playableRows.find((r) => r.id === id).stepMax),
    })
}
test('9404 real start/step/finish counts once; component status and ordinary root context cannot claim puzzle credit', () => {
    const f = puzzleFixture('puzzle-playable-lifecycle')
    try {
        const entry = puzzlePolicy.playables.find((r) => r.id === 10011)
        assert.ok(entry)
        f.edit((s) => {
            s.world.map_id = located(entry.id)
        })
        f.call('PlayableStart', { u32: entry.id })
        const request = { playId: entry.id, ext_context: f.context(1) }
        assert.throws(() => f.call('PlayableFinish', request), /completed its steps/)
        assert.equal(f.state().petPuzzleProgress, undefined)
        f.call('PlayableStep', {
            playId: entry.id,
            is_step: false,
            sub_datas: [{ sub_id: 1, finish_step: 4, complete: true }],
        })
        assert.equal(f.state().petPuzzleProgress, undefined)
        f.call('PlayableStep', { playId: entry.id, is_step: true, finish_step: 1 })
        f.call('PlayableFinish', request)
        assert.equal(f.state().petPuzzleProgress.revision, 1)
        const ledger = f.state().petPuzzleProgress
        f.call('PlayableFinish', request)
        assert.deepEqual(f.state().petPuzzleProgress, ledger)
        start(f, 11028)
        f.call('PlayableFinish', { playId: 11028, ext_context: f.context(1) })
        assert.deepEqual(f.state().petPuzzleProgress, ledger)
        const next = puzzlePolicy.playables.find((r) => r.id === 10021)
        start(f, next.id)
        f.call('PlayableFinish', { playId: next.id })
        assert.deepEqual(f.state().petPuzzleProgress, ledger)
    } finally {
        f.close()
    }
})

test('9404 ACK and SQL failure preserve running state, original finish receipt and shared facts atomically', () => {
    const f = puzzleFixture('puzzle-playable-rollback'),
        encode = puzzleProtocol.encode
    try {
        start(f, 10011)
        const request = { playId: 10011, ext_context: f.context(1) }
        let before = f.state()
        puzzleProtocol.encode = function (type, data) {
            if (type === puzzleProtocol.byId.get(9404).rsp) throw Error('puzzle-playable-ACK')
            return encode.call(this, type, data)
        }
        assert.throws(() => f.call('PlayableFinish', request), /puzzle-playable-ACK/)
        assert.deepEqual(f.state(), before)
        puzzleProtocol.encode = encode
        f.store.flushPending()
        before = f.state()
        f.store.db.exec(
            "CREATE TRIGGER reject_puzzle_playable BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT, 'puzzle-playable-SQL'); END",
        )
        assert.throws(() => f.call('PlayableFinish', request), /puzzle-playable-SQL/)
        assert.deepEqual(f.state(), before)
        f.store.db.exec('DROP TRIGGER reject_puzzle_playable')
        f.call('PlayableFinish', request)
        assert.equal(f.state().petPuzzleProgress.revision, 1)
        assert.equal(f.state().petPuzzleProgress.facts['playable:10011'].kind, 'playable')
    } finally {
        puzzleProtocol.encode = encode
        f.close()
    }
})

test('actual TrialGroupChange registers a nonempty pet accepted by context authority; scope/owner and copy checks stay separate from physical completion', () => {
    const f = puzzleFixture('puzzle-trial-authority')
    try {
        f.edit((s) => {
            populateParty(s)
            s.world.map_id = 104
            s.world.point_id = 10401
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
        const actual = f.state(),
            pet = actual.trialGroup.pets[0]
        assert.ok(pet)
        const attribute = Number(String(puzzleTables.find('pet', pet.config_id).element).split('|')[0])
        const context = { ext_type: 1, ext_uint32_1: attribute, ext_uint64_1: pet.guid }
        assert.equal(petPuzzleContextActor(puzzleTables, actual, context).scope, 'registered-temporary')
        const wrongOwner = structuredClone(actual)
        wrongOwner.trialGroup.pets[0].hero_id = '18446744073709551615'
        assert.equal(petPuzzleContextActor(puzzleTables, wrongOwner, context), null)
        // Synthetic copy-registration guard vector, not a claimed Abyss entry
        // or real puzzle completion in a dungeon without a marked root.
        const copy = structuredClone(actual),
            original = copy.pets.find((p) => p.config_id === pet.config_id) ?? copy.pets[0]
        const copied = {
            ...original,
            guid: String((31n << 56n) | (BigInt(original.guid) & ((1n << 56n) - 1n))),
            hero_id: copy.player.heros_info.heros[0].guid,
            abyss: true,
        }
        copy.abyssRun = { map_id: copy.world.map_id, pets: [copied], heroes: [] }
        copy.player.group_mgrs.push({
            type: 7,
            cur_group: 1,
            groups: [{ id: 1, heros: [{ hero_id: copied.hero_id, pet_id: copied.guid }] }],
        })
        const copiedContext = {
            ext_type: 1,
            ext_uint32_1: Number(String(puzzleTables.find('pet', copied.config_id).element).split('|')[0]),
            ext_uint64_1: copied.guid,
        }
        assert.ok(petPuzzleContextActor(puzzleTables, copy, copiedContext))
        copy.abyssRun.map_id++
        assert.equal(petPuzzleContextActor(puzzleTables, copy, copiedContext), null)
        f.call('TrialGroupChange', { open: false, force: true })
        assert.equal(petPuzzleContextActor(puzzleTables, f.state(), context), null)
        assert.equal(f.state().petPuzzleProgress, undefined)
    } finally {
        f.close()
    }
})
