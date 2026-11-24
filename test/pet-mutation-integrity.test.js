import test from 'node:test'
import assert from 'node:assert/strict'
import { ErrorCode } from '../src/error-codes.js'
import { addItems } from '../src/inventory.js'
import { taskResourcePlan } from '../src/task-resource-consumption.js'
import { confirmMutation } from '../src/pet-mutation.js'
import { mutationFixture, mutationTestGuid } from './pet-mutation-fixture.js'

test('manual no-credit, malformed counter/layout, unknown-level and invalid RNG preserve actual stored state', () => {
    const f = mutationFixture('mutation-invalid')
    try {
        for (const [change, code] of [
            [
                (p) => {
                    p.mutation_times = 0
                },
                ErrorCode.PetNoMutationTimes,
            ],
            [
                (p) => {
                    p.mutation_times = 'bad'
                },
                ErrorCode.GameConfig,
            ],
            [
                (p) => {
                    p.mutation_times = 3
                    p.gene_infos[0].pos = 2
                },
                ErrorCode.GameConfig,
            ],
            [
                (p) => {
                    p.gene_infos[0].pos = 1
                    p.gene_infos[0].gene_lv = 2
                },
                ErrorCode.FunctionClosed,
            ],
        ]) {
            f.edit((s) => change(s.pets.find((p) => p.guid === mutationTestGuid)))
            f.setRolls([0, 0])
            const before = f.store.load(f.session.id)
            assert.throws(
                () => f.generate(),
                (e) => e.code === code,
            )
            assert.deepEqual(f.store.load(f.session.id), before)
            assert.equal(f.draws.length, 0)
        }
        f.edit((s) => {
            s.pets.find((p) => p.guid === mutationTestGuid).gene_infos[0].gene_lv = 1
        })
        f.setRolls([0xffffffff])
        const before = f.store.load(f.session.id)
        assert.throws(
            () => f.generate(),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.store.load(f.session.id), before)
    } finally {
        f.close()
    }
})
test('legal old credits above cap can be spent without clamping, and append preserves an old higher gene_state', () => {
    const f = mutationFixture('mutation-old-count', { count: 150 })
    try {
        f.edit((s) => {
            s.pets.find((p) => p.guid === mutationTestGuid).gene_state = 9
        })
        f.generate()
        assert.equal(f.target().mutation_times, 149)
        assert.equal(f.target().gene_state, 9)
    } finally {
        f.close()
    }
})
test('UR replacement clears only its selected marker and retains current phenotype fields', () => {
    const f = mutationFixture('mutation-ur', { genes: 8 })
    try {
        const used = new Set(f.target().gene_infos.map((g) => g.gene_id))
        const old = f.tables
            .get('pet_dna')
            .find(
                (d) =>
                    d.rarity === 6 &&
                    d.talentDnaType === 2 &&
                    !used.has(d.id) &&
                    f.tables.find('skill', d.id) &&
                    f.tables.get('skill_level').some((l) => l.skillId === d.id && l.level === 1),
            )
        assert(old)
        f.edit((s) => {
            const p = s.pets.find((p) => p.guid === mutationTestGuid)
            p.gene_infos[1] = { pos: 2, gene_id: old.id, gene_lv: 1 }
            p.ur_pos = 2
            p.special = 3
            p.color = 2
            p.colorful = 3
            p.original_type = 2
        })
        f.setRolls([1, 0, 0])
        f.generate()
        assert.equal(f.target().mutation_info.pos, 2)
        f.choose(true)
        assert.equal(f.target().ur_pos, 0)
        assert.deepEqual(
            [f.target().special, f.target().color, f.target().colorful, f.target().original_type],
            [3, 2, 3, 2],
        )
        assert.equal(f.target().mutation_times, 2)
    } finally {
        f.close()
    }
})
test('pending blocks existing fruit/evolution without a carry prohibition, while both real deletion paths cancel the owned proposal', () => {
    const f = mutationFixture('mutation-lifecycle', { genes: 8 })
    try {
        const fruit = f.tables
            .get('pet_feed_item')
            .find((r) => r.type === 3 && !f.target().gene_infos.some((g) => g.gene_id === r.dnaParam))
        f.edit((s) => addItems(s, [{ itemid: fruit.id, itemnum: 1 }]))
        f.generate()
        const before = f.store.load(f.session.id)
        assert.throws(
            () => f.call('UseGeneFruitReq', { pet_id: mutationTestGuid, item_id: fruit.id, slot_pos: 2 }),
            (e) => e.code === ErrorCode.InvalidLogic,
        )
        assert.deepEqual(f.store.load(f.session.id), before)
        assert.throws(
            () => f.call('RankUpPet', { u64: mutationTestGuid }),
            (e) => e.code === ErrorCode.InvalidLogic,
        )
        assert.deepEqual(f.store.load(f.session.id), before)
        const generation = f.state().petMutation.pets[mutationTestGuid].pending.generation
        f.call('DelPet', { pet_list: [mutationTestGuid] })
        assert.equal(f.target(), undefined)
        assert.equal(f.state().petMutation.pets[mutationTestGuid].pending, null)
        assert.equal(
            f.state().petMutation.pets[mutationTestGuid].resolutions[generation].kind,
            'cancelled-instance-removed',
        )
    } finally {
        f.close()
    }
    const g = mutationFixture('mutation-task-delete', { genes: 8 })
    try {
        g.generate()
        const generation = g.state().petMutation.pets[mutationTestGuid].pending.generation
        g.store.transact(g.session.id, 0, (state) => {
            const plan = taskResourcePlan({ tables: g.tables, state, now: g.now() }, [
                { item_type: 5, item_id: g.target().config_id, item_guid: mutationTestGuid, item_count: 1 },
            ])
            plan()
        })
        assert.equal(g.target(), undefined)
        assert.equal(
            g.state().petMutation.pets[mutationTestGuid].resolutions[generation].kind,
            'cancelled-instance-removed',
        )
    } finally {
        g.close()
    }
})
test('changed base genome cannot be accepted; explicit keep cancels without restoring foreign changes or refunding', () => {
    const f = mutationFixture('mutation-base-change', { genes: 8 })
    try {
        f.generate()
        const original = structuredClone(f.target().gene_infos)
        const next = f.tables
            .get('pet_dna')
            .find(
                (d) =>
                    d.talentDnaType === 2 &&
                    d.rarity === 3 &&
                    !original.some((r) => r.gene_id === d.id) &&
                    f.tables.find('skillsub_attrup', d.id) &&
                    f.tables.get('skill_level').some((r) => r.skillId === d.id && r.level === 1),
            )
        f.edit((s) => {
            s.pets.find((p) => p.guid === mutationTestGuid).gene_infos[1].gene_id = next.id
        })
        const before = f.store.load(f.session.id)
        assert.throws(
            () => f.choose(true),
            (e) => e.code === ErrorCode.InvalidLogic,
        )
        assert.deepEqual(f.store.load(f.session.id), before)
        f.choose(false)
        assert.equal(f.target().gene_infos[1].gene_id, next.id)
        assert.equal(f.target().mutation_times, 2)
    } finally {
        f.close()
    }
})
test('real6539 codec fault and late SQLite failure roll back borrowed pending references, genes, credit and proposal state', () => {
    for (const kind of ['codec', 'sql']) {
        const f = mutationFixture('mutation-rollback-' + kind, { genes: 8 })
        const originalPacket = f.game.packet.bind(f.game),
            originalSave = f.store.savePlayer.run.bind(f.store.savePlayer)
        const fault = Error('controlled mutation ' + kind + ' failure')
        try {
            f.call('BattleInfoReduce', { battle_info: [] })
            const pending = f.store.pending.get(f.session.id)
            assert(pending)
            const before = f.store.load(f.session.id),
                sqlBefore = f.store.db
                    .prepare('SELECT state,revision FROM players WHERE account_id=?')
                    .get(f.session.id)
            f.setRolls([0])
            if (kind === 'codec')
                f.game.packet = (name, ...args) => {
                    if (name === 'CSProtoPetInfoSync') throw fault
                    return originalPacket(name, ...args)
                }
            else
                f.store.savePlayer.run = (...args) => {
                    originalSave(...args)
                    throw fault
                }
            assert.throws(
                () => f.generate(),
                (e) => e === fault,
            )
            assert(f.draws.length > 0)
            assert.deepEqual(f.store.load(f.session.id), before)
            assert.strictEqual(f.store.pending.get(f.session.id), pending)
            assert.strictEqual(f.store.pending.get(f.session.id).state, pending.state)
            assert.deepEqual(
                f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
                sqlBefore,
            )
        } finally {
            f.game.packet = originalPacket
            f.store.savePlayer.run = originalSave
            f.close()
        }
    }
})
test('semantic table reload cannot silently accept or redraw an older persisted proposal', () => {
    const f = mutationFixture('mutation-config-change', { genes: 8 })
    try {
        f.generate()
        const builders = f.tables
            .get('pet_builder')
            .map((r) => (r.ID === 3 ? { ...r, geneQuality: r.geneQuality.replace('3#1300', '3#1301') } : r))
        const changed = {
            get: (name) => (name === 'pet_builder' ? builders : f.tables.get(name)),
            find: (name, id) => f.tables.find(name, id),
        }
        const before = f.store.load(f.session.id),
            draws = f.draws.length
        assert.throws(
            () =>
                f.store.transact(f.session.id, 6544, (s) =>
                    confirmMutation(changed, s, mutationTestGuid, true, f.now()),
                ),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.store.load(f.session.id), before)
        assert.equal(f.draws.length, draws)
        f.choose(false)
        assert.equal(f.target().mutation_info.pos, 0)
        assert.equal(f.target().mutation_times, 2)
    } finally {
        f.close()
    }
})
test('a proposal cannot reuse a resolved generation or exceed committed high water', () => {
    const f = mutationFixture('mutation-generation-ownership', { genes: 8 })
    try {
        f.generate()
        const original = structuredClone(f.state().petMutation)
        for (const damage of ['highwater', 'resolved']) {
            f.edit((s) => {
                s.petMutation = structuredClone(original)
                const row = s.petMutation.pets[mutationTestGuid]
                if (damage === 'highwater') s.petMutation.generationHighWater = '0'
                else
                    row.resolutions[row.pending.generation] = {
                        version: 1,
                        generation: row.pending.generation,
                        kind: 'accepted',
                    }
            })
            const before = f.store.load(f.session.id)
            assert.throws(
                () => f.choose(true),
                (e) => e.code === ErrorCode.GameConfig,
            )
            assert.deepEqual(f.store.load(f.session.id), before)
        }
    } finally {
        f.close()
    }
})
