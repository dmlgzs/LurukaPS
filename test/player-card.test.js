import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { chatShieldFixture } from './chat-shield-fixture.js'
import { ErrorCode } from '../src/error-codes.js'
import { grantPlayerCardItem } from '../src/player-card-items.js'
import { publicProfile } from '../src/public-profile.js'
const fixture = (name, file) => chatShieldFixture('player-card-' + name, file)
const stand = (f, who = f.a) => f.state(who).player.basic_info.stand_plates

test('6141 accepts table defaults, publishes sync before null ACK, and preserves omitted slots/counts', () => {
    const f = fixture('partial')
    try {
        f.store.transact(f.a.id, 0, (s) => {
            s.player.basic_info.stand_plates = { achievement_point: 9, hero_count: 2, pet_count: 3 }
        })
        const packets = f.call(f.a, 'ChangeStandPlates', {
            backboard: 20201,
            baseboard: 20101,
            pet_accessory: 20401,
            role: { config: 20305, url: '' },
        })
        const syncId = f.protocol.byName.get('CSProtoSyncPlayerData').id
        const replyId = f.protocol.byName.get('CSProtoChangeStandPlates').id
        const syncIndex = packets.findIndex((p) => p.id === syncId)
        const replyIndex = packets.findIndex((p) => p.id === replyId)
        assert(syncIndex >= 0, 'Actual player-data synchronization must exist')
        assert(replyIndex >= 0, 'Actual ChangeStandPlates acknowledgement must exist')
        assert(syncIndex < replyIndex, 'Player-data synchronization must precede acknowledgement')
        const changed = f.protocol.decode(f.protocol.byId.get(syncId).rsp, packets[syncIndex].payload)
        assert.equal(changed.basic_info.stand_plates.baseboard, 20101)
        assert.equal(changed.basic_info.stand_plates.role.config, 20305)
        assert.deepEqual(f.protocol.decode('ProtoNullRsp', packets[replyIndex].payload), {})
        f.call(f.a, 'ChangeStandPlates', {
            profile: 10101,
            profile_frame: 10201,
            achievement_point: 999,
            hero_count: 999,
            pet_count: 999,
        })
        assert.deepEqual(stand(f), {
            achievement_point: 9,
            hero_count: 2,
            pet_count: 3,
            backboard: 20201,
            baseboard: 20101,
            pet_accessory: 20401,
            role: { config: 20305, url: '' },
            profile: 10101,
            profile_frame: 10201,
        })
        assert.deepEqual(publicProfile(f.state(f.a).player.basic_info).stand_plates, stand(f))
        assert.equal(stand(f, f.b), undefined)
    } finally {
        f.store.close()
    }
})
test('6141 checks category and ownership with actual localized error codes, transaction rollback is atomic', () => {
    const f = fixture('errors')
    try {
        const rows = f.tables.get('playercard_dress')
        for (const [field, type, missing, unowned] of [
            ['backboard', 202, ErrorCode.CardDressConfNoStandPlates, ErrorCode.CardDressBackBoardNone],
            ['baseboard', 201, ErrorCode.CardDressConfNoBackBoard, ErrorCode.CardDressBaseBoardNone],
            ['pet_accessory', 204, ErrorCode.CardDressConfNoBaseBoard, ErrorCode.CardDressPetAccessoryNone],
            ['role', 203, ErrorCode.CardDressConfNoPetAccessory, ErrorCode.CardDressStandPlatesNone],
            ['profile', 101, ErrorCode.CardDressConfNoProfile, ErrorCode.CardDressProfileNone],
            ['profile_frame', 102, ErrorCode.CardDressConfNoProFrame, ErrorCode.CardDressProFrameNone],
        ]) {
            const payload = (id) => (field === 'role' ? { role: { config: id, url: '' } } : { [field]: id })
            const before = f.state(f.a)
            assert.throws(
                () => f.call(f.a, 'ChangeStandPlates', payload(999999)),
                (e) => e.code === missing,
            )
            assert.throws(
                () => f.call(f.a, 'ChangeStandPlates', payload(type === 101 ? 10201 : 10101)),
                (e) => e.code === missing,
            )
            const locked = rows.find((r) => r.type === type && r.defaultComponent !== 1)
            if (locked)
                assert.throws(
                    () => f.call(f.a, 'ChangeStandPlates', payload(locked.id)),
                    (e) => e.code === unowned,
                )
            assert.deepEqual(f.state(f.a), before)
        }
        const available = rows.find((r) => r.type === 101 && r.defaultComponent !== 1)
        f.store.transact(f.a.id, 0, (s) => grantPlayerCardItem(f.tables, s, available.id))
        f.call(f.a, 'ChangeStandPlates', { profile: available.id })
        assert.equal(stand(f).profile, available.id)
    } finally {
        f.store.close()
    }
})
test('6141 cannot replace role image URL or change another account, codec failure rolls back', () => {
    const f = fixture('codec')
    const encode = f.protocol.encode
    try {
        const before = f.state(f.a),
            other = f.state(f.b)
        assert.throws(
            () =>
                f.call(f.a, 'ChangeStandPlates', { role: { config: 20305, url: 'https://example.invalid/fake.png' } }),
            (e) => e.code === ErrorCode.InvalidArgument,
        )
        for (const failure of [f.protocol.byName.get('CSProtoSyncPlayerData').rsp, 'cs.ProtoNullRsp']) {
            f.protocol.encode = function (name, ...args) {
                if (name === failure) throw Error('card wire failed: ' + failure)
                return encode.call(this, name, ...args)
            }
            assert.throws(() => f.call(f.a, 'ChangeStandPlates', { profile: 10101 }), /card wire failed/)
            assert.deepEqual(f.state(f.a), before)
            assert.deepEqual(f.state(f.b), other)
        }
    } finally {
        f.protocol.encode = encode
        f.store.close()
    }
})
test('6141 card selection persists in SQLite and actual login reply after reopen', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-player-card-'))
    let f
    try {
        const file = path.join(dir, 'state.sqlite')
        f = fixture('reopen', file)
        f.call(f.a, 'ChangeStandPlates', { profile: 10101, profile_frame: 10201, role: { config: 20305, url: '' } })
        const before = stand(f)
        f.store.close()
        f = fixture('reopen', file)
        assert.deepEqual(stand(f), before)
        const packets = f.call({}, 'EnterGame', { open_id: 'shield-player-card-reopen-a' })
        const basic = f.protocol.decode(f.protocol.byId.get(5001).rsp, packets.find((p) => p.id === 5001).payload).data
            .basic_info
        assert.deepEqual(basic.stand_plates, before)
    } finally {
        f?.store.close()
        assert.equal(path.dirname(dir), os.tmpdir())
        assert(path.basename(dir).startsWith('lurukaps-player-card-'))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('6141 first partial avatar change initializes all table defaults without clobbering statistics', () => {
    const f = fixture('first-avatar')
    try {
        f.call(f.a, 'ChangeStandPlates', { profile: 10101 })
        const rows = f.tables.get('playercard_dress')
        for (const [field, type] of Object.entries({
            profile: 101,
            profile_frame: 102,
            baseboard: 201,
            backboard: 202,
            role: 203,
            pet_accessory: 204,
        })) {
            const row = rows.find((r) => r.type === type && r.defaultComponent === 1)
            assert.equal(field === 'role' ? stand(f).role.config : stand(f)[field], row.id)
        }
        const before = stand(f)
        f.call(f.a, 'ChangeStandPlates', {})
        assert.deepEqual(stand(f), before)
        f.tables.cache.set(
            'playercard_dress',
            rows.filter((r) => r.type !== 204),
        )
        f.store.transact(f.a.id, 0, (s) => {
            delete s.player.basic_info.stand_plates.pet_accessory
        })
        const saved = f.state(f.a)
        assert.throws(
            () => f.call(f.a, 'ChangeStandPlates', { profile: 10101 }),
            (e) => e.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(f.state(f.a), saved)
    } finally {
        f.store.close()
    }
})
