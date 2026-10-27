import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { petModelFixture, modelCommand } from './pet-model-fixture.js'
import { petModelEligibility, repairPetModelBindings } from '../src/pet-model-eligibility.js'
import { createPets } from '../src/pets.js'
import { ErrorCode } from '../src/error-codes.js'

test('5001 new seed omits unavailable models and permanent reward creation rejects before allocation without partial batch effects', () => {
    const f = petModelFixture('pet-model-new')
    try {
        assert.equal(petModelEligibility(f.tables, 500638).reason, 'missing-unit')
        assert(!f.state().pets.some((pet) => pet.config_id === 500638))
        assert(f.state().pets.every((pet) => petModelEligibility(f.tables, pet.config_id).eligible))
        const direct = f.state(),
            before = structuredClone(direct)
        let draws = 0
        assert.throws(
            () => createPets(f.tables, direct, 500638, 1, 1001, () => (++draws, 0)),
            (error) => error.code === ErrorCode.GameConfig,
        )
        assert.equal(draws, 0)
        assert.deepEqual(direct, before)
        assert.throws(
            () =>
                f.call('GMCommands', {
                    cmds: [modelCommand('gold', [10]), modelCommand('give', [5, 500638, 1])],
                }),
            (error) => error.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
        const ids = new Set(before.pets.map((pet) => pet.guid))
        f.call('GMCommand', modelCommand('give', [5, 500261, 1]))
        const added = f.state().pets.filter((pet) => !ids.has(pet.guid))
        assert.equal(added.length, 1)
        assert.equal(added[0].config_id, 500261)
        assert(petModelEligibility(f.tables, added[0].config_id).eligible)
        const broken = Object.create(f.tables)
        broken.get = (name) => (name === 'unit' ? [] : f.tables.get(name))
        const saved = f.state(),
            copy = structuredClone(saved)
        assert.throws(
            () => repairPetModelBindings(broken, saved),
            (error) => error.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(saved, copy, 'A missing whole catalog never clears saved bindings')
        const emptyModels = Object.create(f.tables)
        emptyModels.get = (name) =>
            name === 'unit' ? f.tables.get(name).map((row) => ({ ...row, model: '' })) : f.tables.get(name)
        assert.throws(
            () => repairPetModelBindings(emptyModels, saved),
            (error) => error.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(saved, copy, 'A damaged complete model column never clears every pet binding')
    } finally {
        f.store.close()
    }
})

test('5001 repairs saved invalid normal bindings before login packets, preserves the legacy pet, and survives SQLite reopen', () => {
    const parent = path.resolve(os.tmpdir()),
        directory = fs.mkdtempSync(path.join(parent, 'pet-model-login-')),
        file = path.join(directory, 'state.sqlite')
    let f = petModelFixture('pet-model-legacy', file)
    try {
        const legacy = f.legacyBad(),
            before = f.state(),
            packets = f.call('EnterGame', { open_id: f.name }, {}),
            after = f.state(),
            kept = after.pets.find((pet) => pet.guid === legacy.guid)
        assert.equal(after.pets.length, before.pets.length)
        assert.deepEqual(kept, { ...legacy, hero_id: '0' })
        assert(after.player.heros_info.heros.every((hero) => hero.pet_id !== legacy.guid))
        for (const group of after.player.group_mgrs.find((row) => row.type === 1).groups)
            if (group.id !== 0) assert(group.heros.every((slot) => slot.pet_id !== legacy.guid))
        const entry = packets.find((packet) => packet.id === f.protocol.byName.get('CSProtoEnterGame').id)
        assert(entry)
        const player = f.protocol.decode(f.protocol.byName.get('CSProtoEnterGame').rsp, entry.payload).data
        assert(player.heros_info.heros.every((hero) => hero.pet_id !== legacy.guid))
        for (const manager of player.group_mgrs ?? [])
            if (manager.type === 1)
                for (const group of manager.groups ?? [])
                    if (group.id !== 0) assert(group.heros.every((slot) => slot.pet_id !== legacy.guid))
        const revision = after.petRevision
        f.call('EnterGame', { open_id: f.name }, {})
        assert.equal(f.state().petRevision, revision)
        f.store.close()
        f = petModelFixture('pet-model-legacy', file)
        assert.deepEqual(
            f.state().pets.find((pet) => pet.guid === legacy.guid),
            kept,
        )
        assert.equal(f.state().petRevision, revision)
    } finally {
        f.store.close()
        assert.equal(path.dirname(path.resolve(directory)), parent)
        assert(path.basename(directory).startsWith('pet-model-login-'))
        fs.rmSync(directory, { recursive: true, force: true })
    }
})

test('5001 model-binding repair rolls back codec and SQL failures including a retained pending draft, then commits once', () => {
    const f = petModelFixture('pet-model-atomic')
    try {
        f.legacyBad({ defer: true })
        const before = f.state(),
            pending = f.store.pending.get(f.session.id),
            disk = f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
            encode = f.protocol.encode.bind(f.protocol),
            type = f.protocol.byName.get('CSProtoPetInfoSync').rsp
        f.protocol.encode = (name, value) => {
            if (name === type) throw Error('pet-model-codec')
            return encode(name, value)
        }
        assert.throws(() => f.call('EnterGame', { open_id: f.name }, {}), /pet-model-codec/)
        f.protocol.encode = encode
        assert.strictEqual(f.store.pending.get(f.session.id), pending)
        assert.deepEqual(f.state(), before)
        assert.deepEqual(
            f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id),
            disk,
        )
        f.store.db.exec(
            "CREATE TEMP TRIGGER pet_model_abort BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'pet-model-sql'); END",
        )
        assert.throws(() => f.call('EnterGame', { open_id: f.name }, {}), /pet-model-sql/)
        f.store.db.exec('DROP TRIGGER pet_model_abort')
        assert.strictEqual(f.store.pending.get(f.session.id), pending)
        assert.deepEqual(f.state(), before)
        f.call('EnterGame', { open_id: f.name }, {})
        assert.equal(f.store.pending.has(f.session.id), false)
        assert.equal(
            f.store.db.prepare('SELECT revision FROM players WHERE account_id=?').get(f.session.id).revision,
            disk.revision + 1,
        )
        assert.equal(f.state().pets.find((pet) => pet.guid === '500638').hero_id, '0')
    } finally {
        f.store.close()
    }
})
