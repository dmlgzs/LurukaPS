import test from 'node:test'
import assert from 'node:assert/strict'
import { mainEntrustFixture } from './main-entrust-clear-fixture.js'
import { mutationTemporaryDatabase } from './pet-mutation-fixture.js'
import { registerPetMutations } from '../src/handlers/pet-mutation.js'
import { createMutationSourceRuntime } from '../src/pet-mutation-source.js'
import { createPets } from '../src/pets.js'
import { confirmMutation } from '../src/pet-mutation.js'

function connect(name, file) {
    const f = mainEntrustFixture(name, file)
    assert.equal(f.game.handlers.has(6539), false, 'Default Game must not enable mutation')
    assert.equal(f.game.handlers.has(6544), false, 'Default Game must not enable mutation')
    registerPetMutations(
        (name, handler) => {
            const entry = f.protocol.byName.get('CSProto' + name)
            assert(entry && !f.game.handlers.has(entry.id))
            f.game.handlers.set(entry.id, handler)
        },
        f.tables,
        { privateEnabled: true },
    )
    f.game.mutationSourceRuntime = createMutationSourceRuntime()
    f.game.rng = () => 0
    return f
}
function bind(f) {
    let ids
    f.edit((s) => {
        const pets = createPets(f.tables, s, 500001, 2, 1001, () => 0)
        ids = pets.map((p) => p.guid)
        const manager = s.player.group_mgrs.find((m) => m.type === 1)
        const slots = manager.groups.find((g) => g.id === manager.cur_group).heros
        slots[1].hero_id = s.player.heros_info.heros.find((h) => h.guid !== slots[0].hero_id).guid
        for (let i = 0; i < pets.length; i++) {
            const hero = s.player.heros_info.heros.find((h) => h.guid === slots[i].hero_id)
            const old = s.pets.find((p) => p.guid === hero.pet_id)
            if (old) old.hero_id = '0'
            hero.pet_id = pets[i].guid
            slots[i].pet_id = pets[i].guid
            pets[i].hero_id = hero.guid
            pets[i].mutation_times = 0
            assert.equal(pets[i].gene_infos.length, 8)
        }
    })
    return ids
}
const pet = (f, id) => f.state().pets.find((p) => p.guid === id)
const ledger = (f, id) => f.state().petMutation.pets[id]
const receipts = (f) => Object.values(f.state().petMutation?.claimResults ?? {})
const sequence = (f) =>
    f.store.db.prepare('SELECT value FROM sequences WHERE name=?').get('mutation-source-paid-claim:' + f.id())?.value ??
    0
const stamina = (f) => BigInt(f.state().player.attr_infos.attrs.find((a) => a.attr_id === 3).attr_val)
const claim = (f) => f.call('StaminaBoxGet', { box_id: f.chest().id, times: 2 })
const generate = (f, id) => f.call('UseMutationTimes', { pet_guid: id })
const choose = (f, id, is_accept) => f.call('ChoseMutation', { pet_guid: id, is_accept })
function wirePets(f, packets) {
    return packets
        .filter((p) => p.id === 6517)
        .flatMap((p) => f.protocol.decode(f.protocol.byId.get(6517).rsp, p.payload).pet_infos.pets)
}

test('combined real paid claims earn, persist proposal, skip only pending pet, retain, earn again and accept across SQLite reopen', () => {
    const db = mutationTemporaryDatabase(),
        name = 'mutation-combined-lifecycle'
    let f = connect(name, db.file)
    try {
        const [a, b] = bind(f),
            original = structuredClone(pet(f, a).gene_infos)
        f.win(1)
        const balance = stamina(f),
            initialPackets = claim(f)
        assert.equal(stamina(f), balance - 60n)
        assert.equal(f.run().chest_claimed, true)
        assert.equal(sequence(f), 1)
        for (const id of [a, b]) {
            assert.equal(pet(f, id).mutation_times, 1)
            assert.equal(ledger(f, id).remainder, 20)
            assert.equal(wirePets(f, initialPackets).find((p) => p.guid === id).mutation_times, 1)
        }
        assert.equal(generate(f, a).find((p) => p.id === 6539).payload.length, 0)
        const first = structuredClone(ledger(f, a).pending)
        assert.equal(pet(f, a).mutation_times, 0)
        assert.deepEqual(pet(f, a).gene_infos, original)
        f.win(1)
        const pendingPackets = claim(f),
            secondReceipt = receipts(f)[1]
        assert.equal(sequence(f), 2)
        assert.equal(secondReceipt.pets.find((p) => p.pet_guid === a).reason, 'pending')
        assert.deepEqual(ledger(f, a).pending, first)
        assert.equal(ledger(f, a).remainder, 20)
        assert.equal(pet(f, a).mutation_times, 0)
        assert.equal(pet(f, b).mutation_times, 3)
        assert.equal(ledger(f, b).remainder, 0)
        assert.equal(wirePets(f, pendingPackets).find((p) => p.guid === b).mutation_times, 3)
        choose(f, a, false)
        assert.equal(pet(f, a).mutation_times, 0, 'Keep must not refund')
        assert.deepEqual(pet(f, a).gene_infos, original)
        assert.equal(ledger(f, a).resolutions[first.generation].kind, 'retained')
        f.win(1)
        claim(f)
        assert.equal(sequence(f), 3)
        assert.equal(pet(f, a).mutation_times, 2)
        assert.equal(ledger(f, a).remainder, 0)
        generate(f, a)
        const second = structuredClone(ledger(f, a).pending)
        assert.notEqual(second.generation, first.generation)
        assert.equal(pet(f, a).mutation_times, 1)
        const savedReceipts = structuredClone(f.state().petMutation.claimResults)
        f.close()
        f = null
        f = connect(name, db.file)
        assert.deepEqual(ledger(f, a).pending, second)
        assert.deepEqual(f.state().petMutation.claimResults, savedReceipts)
        f.game.rng = () => {
            throw Error('Confirm must not redraw')
        }
        const acceptedPackets = choose(f, a, true)
        assert.equal(acceptedPackets.find((p) => p.id === 6544).payload.length, 0)
        assert.deepEqual(pet(f, a).gene_infos[second.pos - 1], second.candidate)
        assert.equal(pet(f, a).mutation_times, 1)
        assert.equal(ledger(f, a).pending, null)
        assert.equal(ledger(f, a).resolutions[second.generation].kind, 'accepted')
        const acceptedGenes = structuredClone(pet(f, a).gene_infos)
        assert.deepEqual(f.state().petMutation.claimResults, savedReceipts, 'Old claim snapshots are immutable audit')
        const oldAudit = receipts(f)[0].primary.qualification_snapshot.beneficiaries.find((p) => p.pet_guid === a).audit
            .gene_infos.value
        assert.deepEqual(oldAudit, original)
        f.game.rng = () => 0
        f.win(1)
        claim(f)
        assert.equal(sequence(f), 4)
        assert.equal(pet(f, a).mutation_times, 2)
        assert.deepEqual(pet(f, a).gene_infos, acceptedGenes, 'Later source must not restore its older audit genome')
        const latestAudit = receipts(f)[3].primary.qualification_snapshot.beneficiaries.find((p) => p.pet_guid === a)
            .audit.gene_infos.value
        assert.deepEqual(latestAudit, acceptedGenes)
        f.login()
        assert.deepEqual(pet(f, a).gene_infos, acceptedGenes)
        assert.equal(pet(f, a).mutation_times, 2)
        assert.equal(sequence(f), 4)
        f.close()
        f = null
        f = connect(name, db.file)
        assert.deepEqual(pet(f, a).gene_infos, acceptedGenes)
        assert.equal(ledger(f, a).resolutions[second.generation].kind, 'accepted')
        assert.equal(receipts(f).length, 4)
    } finally {
        if (f) f.close()
        db.cleanup()
    }
})

test('combined failed new paid claim preserves durable pending and completed old receipt; failed acceptance preserves new receipt', () => {
    const f = connect('mutation-combined-rollback')
    try {
        const [a, b] = bind(f)
        f.win(1)
        claim(f)
        generate(f, a)
        f.win(1)
        const before = f.state(),
            oldSql = f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.id())
        const oldSequence = sequence(f),
            packet = f.game.packet
        f.game.packet = function (name, ...rest) {
            if (name === 'CSProtoPetInfoSync') throw Error('combined-credit-codec')
            return packet.call(this, name, ...rest)
        }
        assert.throws(() => claim(f), /combined-credit-codec/)
        f.game.packet = packet
        assert.deepEqual(f.state(), before)
        assert.equal(sequence(f), oldSequence)
        assert.deepEqual(
            f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.id()),
            oldSql,
        )
        assert.equal(f.run().chest_claimed, before.entrust.run.chest_claimed)
        claim(f)
        assert.equal(pet(f, b).mutation_times, 3)
        const earned = f.state(),
            earnedSql = f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.id())
        const pending = structuredClone(ledger(f, a).pending),
            save = f.store.savePlayer.run.bind(f.store.savePlayer)
        f.store.savePlayer.run = (...args) => {
            save(...args)
            throw Error('combined-accept-SQL')
        }
        assert.throws(() => choose(f, a, true), /combined-accept-SQL/)
        f.store.savePlayer.run = save
        assert.deepEqual(f.state(), earned)
        assert.deepEqual(
            f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.id()),
            earnedSql,
        )
        assert.equal(sequence(f), 2)
        assert.deepEqual(ledger(f, a).pending, pending)
        choose(f, a, true)
        assert.deepEqual(pet(f, a).gene_infos[pending.pos - 1], pending.candidate)
        assert.equal(pet(f, a).mutation_times, 0)
        assert.equal(receipts(f).length, 2, 'A failed later request cannot undo an earlier committed claim')
    } finally {
        f.close()
    }
})

test('controlled source callback interleaving audits the early genome without overwriting a later accepted candidate', () => {
    const f = connect('mutation-combined-early-snapshot')
    try {
        const [a, b] = bind(f)
        f.win(1)
        claim(f)
        generate(f, a)
        const pending = structuredClone(ledger(f, a).pending),
            original = structuredClone(pet(f, a).gene_infos)
        f.win(1)
        const runtime = createMutationSourceRuntime()
        let reached = false
        // Deliberate test interleaving, not a claim that the network dispatcher
        // concurrently runs 6544 inside a chest request. Both runtime operations
        // borrow the same actual claim transaction; the earlier source snapshot
        // is audit only and must never be restored as live genome authority.
        f.game.mutationSourceRuntime = {
            ...runtime,
            complete(c, handle) {
                assert.deepEqual(c.state.pets.find((p) => p.guid === a).gene_infos, original)
                confirmMutation(c.tables, c.state, a, true, c.now)
                reached = true
                return runtime.complete(c, handle)
            },
        }
        const packets = claim(f)
        assert.equal(reached, true)
        assert.equal(f.run().chest_claimed, true)
        assert.deepEqual(pet(f, a).gene_infos[pending.pos - 1], pending.candidate)
        assert.equal(ledger(f, a).pending, null)
        assert.equal(pet(f, a).mutation_times, 2)
        assert.equal(pet(f, b).mutation_times, 3)
        const receipt = receipts(f)[1]
        const audit = receipt.primary.qualification_snapshot.beneficiaries.find((p) => p.pet_guid === a).audit
        assert.deepEqual(audit.gene_infos.value, original)
        assert.equal(receipt.pets.find((p) => p.pet_guid === a).status, 'planned')
        assert.deepEqual(wirePets(f, packets).find((p) => p.guid === a).gene_infos[pending.pos - 1], pending.candidate)
    } finally {
        f.close()
    }
})

test('combined cap boundary preserves pending remainder and historical receipts cannot resurrect a released proposal target', () => {
    const f = connect('mutation-combined-cap-release')
    try {
        const [a] = bind(f)
        f.win(1)
        claim(f)
        f.edit((s) => {
            // Explicit legacy cap fixture; no historical fee or earned credit
            // is invented. The real first claim supplied this row's remainder.
            s.pets.find((p) => p.guid === a).mutation_times = 100
        })
        assert.equal(ledger(f, a).remainder, 20)
        generate(f, a)
        assert.equal(pet(f, a).mutation_times, 99)
        f.win(1)
        claim(f)
        assert.equal(receipts(f)[1].pets.find((p) => p.pet_guid === a).reason, 'pending')
        assert.equal(pet(f, a).mutation_times, 99)
        assert.equal(ledger(f, a).remainder, 20)
        choose(f, a, false)
        f.win(1)
        claim(f)
        const result = receipts(f)[2].pets.find((p) => p.pet_guid === a).plan
        assert.equal(result.status, 'cap-reached')
        assert.equal(result.trials, 1)
        assert.equal(result.discarded, 40)
        assert.equal(pet(f, a).mutation_times, 100)
        assert.equal(ledger(f, a).remainder, 0)
        generate(f, a)
        const generation = ledger(f, a).pending.generation
        f.edit((s) => {
            const target = s.pets.find((p) => p.guid === a)
            target.is_lock = false
            target.hero_id = '0'
            for (const hero of s.player.heros_info.heros) if (hero.pet_id === a) hero.pet_id = '0'
            for (const manager of s.player.group_mgrs)
                for (const group of manager.groups)
                    for (const slot of group.heros) if (slot.pet_id === a) slot.pet_id = '0'
        })
        const oldReceipts = structuredClone(f.state().petMutation.claimResults)
        f.call('DelPet', { pet_list: [a] })
        assert.equal(pet(f, a), undefined)
        assert.equal(ledger(f, a).pending, null)
        assert.equal(ledger(f, a).resolutions[generation].kind, 'cancelled-instance-removed')
        assert.deepEqual(f.state().petMutation.claimResults, oldReceipts)
        f.win(1)
        claim(f)
        assert.equal(pet(f, a), undefined)
        assert.equal(
            receipts(f)[3].pets.some((p) => p.pet_guid === a),
            false,
        )
        assert.equal(ledger(f, a).resolutions[generation].kind, 'cancelled-instance-removed')
        f.login()
        assert.equal(pet(f, a), undefined)
    } finally {
        f.close()
    }
})
