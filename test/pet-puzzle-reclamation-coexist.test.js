import test from 'node:test'
import assert from 'node:assert/strict'
import { reclamationFixture } from './field-reclamation-fixture.js'
import { WorldObjectCatalog } from '../src/world-objects.js'
import { achievementCatalogue } from '../src/achievements.js'
import { fieldReclamationValue } from '../src/field-reclamation-progress.js'
import { petPuzzleProgressValue } from '../src/pet-puzzle-progress.js'
import policy from '../configs/pet-puzzle-progress-policy.json' with { type: 'json' }

test('actual new fields and20 actual world puzzles coexist without replacing either authoritative source', () => {
    const f = reclamationFixture('puzzle-reclamation-coexist')
    try {
        const model = achievementCatalogue(f.tables),
            catalog = new WorldObjectCatalog(f.tables)
        assert.equal(model.rows.filter((r) => model.rules.get(r.id).supported).length, 131)
        assert.equal(model.rules.get(2010005).supported, true)
        assert.equal(fieldReclamationValue(f.state(), [12031, 0, 30]), 0)
        assert.equal(petPuzzleProgressValue(f.tables, f.state(), [12048, 0, 0, 20]), 0)
        const opened = f.open()
        assert.equal(fieldReclamationValue(f.state(), [12031, 0, 30]), 1)
        f.close(opened.build.guid)
        const fieldFacts = structuredClone(f.state().home.reclamationProgress)
        const entries = policy.worlds
            .filter((entry) => {
                if (entry.map !== 100) return false
                const { row } = catalog.object(entry.map, entry.id)
                return !row.initialCompleteState && !row.appearCond && !row.disappearCond
            })
            .slice(0, 20)
        assert.equal(entries.length, 20)
        for (const entry of entries) {
            const { pos } = catalog.object(entry.map, entry.id)
            f.edit((s) => {
                s.world.map_id = entry.map
                s.world.pos = pos
            })
            const pet = f
                .state()
                .pets.find((p) =>
                    String(f.tables.find('pet', p.config_id).element).split('|').map(Number).includes(entry.attribute),
                )
            assert.ok(pet)
            f.call('WorldObjInteract', {
                objs: [
                    {
                        obj: { obj_id: entry.id, complete: true, state_data: { step: 1, complete: true } },
                        ext_context: { ext_type: 1, ext_uint32_1: entry.attribute, ext_uint64_1: pet.guid },
                    },
                ],
            })
        }
        assert.equal(petPuzzleProgressValue(f.tables, f.state(), [12048, 0, 0, 20]), 20)
        assert.deepEqual(f.state().home.reclamationProgress, fieldFacts)
        assert.equal(f.state().achievements.entries[3020010].value, 20)
        assert.ok(f.state().achievements.entries[3020010].finishTime > 0)
        f.call('AchievementReward', { u32: 3020010 })
        assert.equal(f.state().achievements.entries[3020010].claimed, true)
        const puzzleFacts = structuredClone(f.state().petPuzzleProgress)
        f.call('EnterHome', { creator_id: f.session.id })
        const second = f.open()
        assert.equal(fieldReclamationValue(f.state(), [12031, 0, 30]), 2)
        f.close(second.build.guid)
        assert.deepEqual(f.state().petPuzzleProgress, puzzleFacts)
    } finally {
        f.store.close()
    }
})
