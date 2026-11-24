import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { mutationCatalog, mutationSlotDomain } from '../src/pet-mutation-catalog.js'
const tables = new Tables(configuration().tables)

test('mutation catalog uses the actual default builder3/pool1001 and keeps all current alternate rule domains', () => {
    const defaults = mutationCatalog(tables)
    assert.equal(defaults.ruleId, Number(tables.get('game').find((r) => r.title === 'PET_DNA_MUTATION_ID').value))
    assert.equal(defaults.pool.length, 201)
    const domain = mutationSlotDomain(defaults, { lv: 1 }, [], 1)
    assert.deepEqual(
        domain.groups.map((r) => [r.rarity, r.weight]),
        [
            [3, 1300],
            [4, 294],
            [5, 107],
        ],
    )
    assert.equal(
        domain.groups.reduce((n, r) => n + r.choices.length, 0),
        96,
    )
    for (const rule of tables
        .get('pet_builder_rule')
        .filter((r) => r.id >= defaults.ruleId && r.id <= defaults.ruleId + 7)) {
        const current = mutationCatalog(tables, rule.id)
        assert(current.pool.length > 0)
        assert(mutationSlotDomain(current, { lv: 1 }, [], 1).groups.every((q) => q.choices.length > 0))
    }
})
test('all real42 ascending innate targets compile as effects while exact self loops are not fake upgrades', () => {
    const catalog = mutationCatalog(tables),
        pairs = [...catalog.dna.values()].filter((d) => d.evoDnaId && d.evoDnaId !== d.id)
    assert.equal(pairs.length, 42)
    for (const old of pairs) {
        const genes = [{ pos: 1, gene_id: old.id, gene_lv: 1 }]
        const domain = mutationSlotDomain(catalog, { lv: 1 }, genes, 1)
        assert.equal(domain.candidate, old.evoDnaId)
        assert.equal(catalog.definition(domain.candidate).skillType, 1)
    }
    for (const old of [...catalog.dna.values()].filter((d) => d.evoDnaId === d.id))
        assert.equal(mutationSlotDomain(catalog, { lv: 1 }, [{ pos: 1, gene_id: old.id, gene_lv: 1 }], 1), null)
})
