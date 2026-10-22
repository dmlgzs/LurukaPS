import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { petCosmeticsFixture } from './pet-cosmetics-fixture.js'
import { ErrorCode } from '../src/error-codes.js'
import { grantRewards } from '../src/rewards.js'

const command = (f, text) => f.call('GMCommand', { command: Buffer.from(text).toString('base64') })
const pet = (f, config) => f.state().pets.find((p) => p.config_id === config)
const special = (f) => f.tables.get('pet_skin').filter((r) => r.isNormal === 0)

test('all configured special skins unlock through shared type 37 awards and emit real 6549 before acknowledgement', () => {
    const f = petCosmeticsFixture('skin-grants')
    try {
        assert.deepEqual(f.decode(f.packets, 6549).skin_infos, [])
        for (const row of special(f)) {
            const packets = command(f, `give 37 ${row.id} 1`)
            assert(
                packets.findIndex((p) => p.id === 6549) <
                    packets.findIndex((p) => p.id === f.protocol.byName.get('CSProtoGMCommand').id),
            )
            assert(f.decode(packets, 6549).skin_infos.some((s) => s.skin_id === row.id))
            assert(f.state().petSkins.includes(row.id))
            assert(!command(f, `give 37 ${row.id} 1`).some((p) => p.id === 6549))
        }
        const before = f.state()
        assert.throws(
            () => command(f, `give 37 ${special(f)[0].id} 2`),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(), before)
        const result = grantRewards(f.tables, structuredClone(before), [
            { itemtype: 37, itemid: special(f)[0].id, itemnum: 1 },
        ])
        assert.deepEqual(result, [])
    } finally {
        f.store.close()
    }
})

test('wear and restore update the same pet before ACK while keeping formation, skills, stats, mount and combat intact', () => {
    const f = petCosmeticsFixture('skin-wear')
    try {
        const row = special(f)[0],
            target = pet(f, row.kiboId)
        assert(target, 'actual initial pet catalogue includes skin target')
        command(f, `give 37 ${row.id} 1`)
        const old = f.state(),
            packets = f.call('WearPetSkin', { pet_guid: target.guid, skin_id: row.id })
        assert(packets.findIndex((p) => p.id === 6517) < packets.findIndex((p) => p.id === 6548))
        assert.deepEqual(f.decode(packets, 6548), { pet_guid: target.guid, skin_id: row.id })
        assert.equal(f.decode(packets, 6517).pet_infos.pets[0].wear_skin_id, row.id)
        const current = f.state(),
            updated = current.pets.find((p) => p.guid === target.guid)
        const { wear_skin_id, ...rest } = updated
        const { wear_skin_id: oldSkin, ...oldRest } = target
        assert.deepEqual(rest, oldRest)
        for (const key of ['player', 'battle', 'mounts', 'mount', 'world', 'trialGroup'])
            assert.deepEqual(current[key], old[key])
        assert.throws(
            () => f.call('WearPetSkin', { pet_guid: target.guid, skin_id: row.id }),
            (e) => e.code === ErrorCode.PetSkinWearRepeated,
        )
        const restored = f.call('WearPetSkin', { pet_guid: target.guid, skin_id: 0 })
        assert.equal(f.decode(restored, 6548).skin_id, 0)
        assert.equal(f.state().pets.find((p) => p.guid === target.guid).wear_skin_id, 0)
    } finally {
        f.store.close()
    }
})

test('skin ownership, matching and configuration use dedicated errors; encode failures roll back awards and wear', () => {
    const f = petCosmeticsFixture('skin-invalid')
    try {
        const row = special(f)[0],
            target = pet(f, row.kiboId),
            other = f.state().pets.find((p) => p.config_id !== row.kiboId)
        const wear = (pet_guid, skin_id) => f.call('WearPetSkin', { pet_guid, skin_id })
        assert.throws(
            () => wear(target.guid, row.id),
            (e) => e.code === ErrorCode.PetSkinNotActive,
        )
        assert.throws(
            () => wear(other.guid, row.id),
            (e) => e.code === ErrorCode.PetSkinNotMatchPet,
        )
        assert.throws(
            () => wear(target.guid, 0xffffffff),
            (e) => e.code === ErrorCode.PetSkinConfNotExist,
        )
        assert.throws(
            () => wear('18446744073709551615', row.id),
            (e) => e.code === ErrorCode.PetNotExist,
        )
        const encode = f.protocol.encode.bind(f.protocol),
            before = f.state()
        f.protocol.encode = (name, value) => {
            if (name === 'cs.SCPetSkinInfoSync') throw Error('skin unlock wire failed')
            return encode(name, value)
        }
        assert.throws(() => command(f, `give 37 ${row.id} 1`), /wire failed/)
        assert.deepEqual(f.state(), before)
        f.protocol.encode = encode
        command(f, `give 37 ${row.id} 1`)
        const unlocked = f.state()
        f.protocol.encode = (name, value) => {
            if (name === 'cs.SCPetWearPetSkinRsp') throw Error('skin wear wire failed')
            return encode(name, value)
        }
        assert.throws(() => wear(target.guid, row.id), /wire failed/)
        assert.deepEqual(f.state(), unlocked)
    } finally {
        f.store.close()
    }
})

test('owned and equipped skins survive SQLite close/reopen and login; ordinary appearance does not require ownership', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luruka-pet-skins-')),
        file = path.join(dir, 'test.sqlite')
    let f = petCosmeticsFixture('skin-durable', file)
    try {
        const row = special(f)[0],
            target = pet(f, row.kiboId)
        command(f, `give 37 ${row.id} 1`)
        f.call('WearPetSkin', { pet_guid: target.guid, skin_id: row.id })
        f.store.close()
        f = petCosmeticsFixture('skin-durable', file)
        assert(f.decode(f.packets, 6549).skin_infos.some((s) => s.skin_id === row.id))
        assert.equal(f.decode(f.packets, 6517).pet_infos.pets.find((p) => p.guid === target.guid).wear_skin_id, row.id)
        const normal = f.tables.get('pet_skin').find((r) => r.isNormal === 1 && r.kiboId === row.kiboId)
        assert(normal)
        const packets = f.call('WearPetSkin', { pet_guid: target.guid, skin_id: normal.id })
        assert.equal(f.decode(packets, 6548).skin_id, 0)
    } finally {
        f.store.close()
        assert.equal(path.dirname(dir), os.tmpdir())
        assert(path.basename(dir).startsWith('luruka-pet-skins-'))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
