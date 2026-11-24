import test from 'node:test'
import assert from 'node:assert/strict'
import { mutationFixture, mutationTestGuid } from './pet-mutation-fixture.js'
import { mutationCatalog, mutationSlotDomain } from '../src/pet-mutation-catalog.js'

test('controlled real6539 requests can reach every current positive ordinary candidate without a hand-written DNA whitelist', () => {
    const f = mutationFixture('mutation-all-ordinary', { genes: 0 })
    try {
        const catalog = mutationCatalog(f.tables)
        const domain = mutationSlotDomain(catalog, f.target(), [], 1)
        let qualityOffset = 0,
            covered = 0
        for (const group of domain.groups) {
            let geneOffset = 0
            for (const choice of group.choices) {
                // Controlled existing credits/genome, not a claimed natural source.
                f.edit((s) => {
                    const p = s.pets.find((p) => p.guid === mutationTestGuid)
                    p.gene_infos = []
                    p.gene_state = 0
                    p.ur_pos = 0
                    p.mutation_times = 1
                })
                f.setRolls([qualityOffset, geneOffset])
                const packets = f.generate()
                assert.equal(f.target().gene_infos[0].gene_id, choice.dna)
                assert.equal(f.target().mutation_times, 0)
                assert.equal(f.draws.length, 2)
                assert(packets.some((p) => p.id === 6517))
                covered++
                geneOffset += choice.weight
            }
            qualityOffset += group.weight
        }
        assert.equal(covered, 96)
    } finally {
        f.close()
    }
})
test('all42 table-defined innate evolutions pass real proposal and confirmation flows with full effect descriptors', () => {
    const f = mutationFixture('mutation-all-evo', { genes: 8 })
    try {
        const catalog = mutationCatalog(f.tables)
        const ordinary = mutationSlotDomain(catalog, { lv: 1 }, [], 1)
            .groups[0].choices.slice(0, 7)
            .map((r, i) => ({ pos: i + 2, gene_id: r.dna, gene_lv: 1 }))
        let covered = 0
        for (const source of [...catalog.dna.values()].filter((r) => r.evoDnaId && r.evoDnaId !== r.id)) {
            // Existing canonical layouts exercise the generic path; this does
            // not claim natural acquisition of every species or Unity execution.
            f.edit((s) => {
                const p = s.pets.find((p) => p.guid === mutationTestGuid)
                p.gene_infos = [{ pos: 1, gene_id: source.id, gene_lv: 1 }, ...ordinary.map((r) => ({ ...r }))]
                p.gene_state = 4
                p.ur_pos = 0
                p.mutation_times = 1
            })
            f.setRolls([0])
            f.generate()
            const pending = f.state().petMutation.pets[mutationTestGuid].pending
            assert.equal(pending.pos, 1)
            assert.equal(pending.candidate.gene_id, source.evoDnaId)
            assert.equal(f.target().gene_infos[0].gene_id, source.id)
            f.choose(true)
            assert.equal(f.target().gene_infos[0].gene_id, source.evoDnaId)
            assert.equal(f.target().mutation_times, 0)
            assert.equal(f.draws.length, 1)
            const resolved = f.state().petMutation.pets[mutationTestGuid].resolutions[pending.generation]
            assert(resolved.projection.old.some((r) => r.skill_id === source.id))
            assert(resolved.projection.next.some((r) => r.skill_id === source.evoDnaId))
            covered++
        }
        assert.equal(covered, 42)
    } finally {
        f.close()
    }
})
