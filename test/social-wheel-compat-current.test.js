import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setup } from './social-wheel-fixture.js'
import { socialWheelSnapshot } from '../src/social-wheel.js'
import { projectSavedSocialWheel } from '../src/social-wheel-compatibility.js'
import { ErrorCode } from '../src/error-codes.js'

const oldSlots = () => [7, 12, 1, 7, 999, 0, 8, 6].map((id, i) => ({ index: i + 1, id }))
test('current login migrates saved CBT3 social action slots by actual action meaning while retaining the original wheel', () => {
    const f = setup()
    try {
        f.store.transact(f.session.id, 0, (state) => {
            state.socialWheel.slots = oldSlots()
            delete state.socialWheel.catalogVersion
        })
        const before = f.state(),
            result = f.sync(f.call('EnterGame', { open_id: 'social-wheel' }, {}))
        assert.deepEqual(
            result.social_wheel.map((row) => row.id),
            [37, 42, 1, 37, 0, 0, 38, 6],
        )
        assert.deepEqual(
            f.state().socialWheel.slots.map((row) => row.id),
            [37, 42, 1, 37, 999, 0, 38, 6],
        )
        assert.deepEqual(f.state().socialWheel.legacyCatalog.slots, oldSlots())
        assert.equal(f.state().socialWheel.catalogVersion, '1.0.0/3217420')
        assert.deepEqual(f.state().player.sbag_infos, before.player.sbag_infos)
        assert.deepEqual(f.state().pets, before.pets)
        const saved = f.state().socialWheel
        f.call('EnterGame', { open_id: 'social-wheel' }, {})
        assert.deepEqual(f.state().socialWheel, saved)
    } finally {
        f.close()
    }
})

test('legacy wheel projection and actual visual playback stay read-only; current requests cannot address old IDs', () => {
    const f = setup()
    try {
        f.store.transact(f.session.id, 0, (state) => {
            state.socialWheel.slots = oldSlots()
            delete state.socialWheel.catalogVersion
        })
        const before = f.state(),
            token = f.store.readCacheToken(f.session.id),
            writes = () => f.store.db.prepare('SELECT total_changes() AS n').get().n,
            count = writes()
        const projected = socialWheelSnapshot(f.tables, before)
        assert.equal(projected.social_wheel[0].id, 37)
        assert.equal(f.sync(f.call('SelectEmoticons', { u32: 37 })).cur_emoticons_id, 37)
        assert.throws(
            () => f.call('SelectEmoticons', { u32: 7 }),
            (error) => error.code === ErrorCode.SocialEmotionsConfError,
        )
        assert.equal(writes(), count)
        assert.equal(f.store.readCacheToken(f.session.id), token)
        assert.deepEqual(f.state(), before)
        const marked = structuredClone(before)
        marked.socialWheel.catalogVersion = '1.0.0/3217420'
        assert.equal(socialWheelSnapshot(f.tables, marked).social_wheel[0].id, 0)
        assert.equal(marked.socialWheel.slots[0].id, 7)
    } finally {
        f.close()
    }
})

test('actual login codec rollback preserves raw legacy slots; SQLite reopen migrates once and explicit clears never restore archived actions', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lurukaps-social-compat-')),
        file = path.join(directory, 'private.sqlite')
    let f = setup(file)
    try {
        f.store.transact(f.session.id, 0, (state) => {
            state.socialWheel.slots = oldSlots()
            delete state.socialWheel.catalogVersion
        })
        const before = f.state(),
            packet = f.game.packet
        try {
            f.game.packet = function (name, ...args) {
                if (name === 'SCProtoSocialEmoticonsSyncInfo') throw Error('social-migration-codec')
                return packet.call(this, name, ...args)
            }
            assert.throws(() => f.call('EnterGame', { open_id: 'social-wheel' }, {}), /social-migration-codec/)
            assert.deepEqual(f.state(), before)
        } finally {
            f.game.packet = packet
        }
        f.close()
        f = setup(file)
        assert.equal(f.sync(f.login).social_wheel[0].id, 37)
        assert.deepEqual(f.state().socialWheel.legacyCatalog.slots, oldSlots())
        f.call('UpdateEmoticonsWheel', { wheel_data: f.sync(f.login).social_wheel, del_all: true })
        f.close()
        f = setup(file)
        assert(f.sync(f.login).social_wheel.every((row) => row.id === 0))
        assert.deepEqual(f.state().socialWheel.legacyCatalog.slots, oldSlots())
    } finally {
        f.close()
        fs.rmSync(directory, { recursive: true, force: true })
    }
})

test('catalogue migration does not unlock a locked system or grant a disabled current action', () => {
    const f = setup(':memory:', false)
    try {
        f.store.transact(f.session.id, 0, (state) => {
            state.socialWheel.slots = oldSlots()
            delete state.socialWheel.catalogVersion
        })
        const response = f.sync(f.call('EnterGame', { open_id: 'social-wheel' }, {}))
        assert.deepEqual(response.infos, [])
        assert(response.social_wheel.every((row) => row.id === 0))
        assert.equal(f.state().socialWheel.slots[0].id, 37)
        assert.throws(
            () => f.call('SelectEmoticons', { u32: 37 }),
            (error) => error.code === ErrorCode.FunctionClosed,
        )
        f.store.transact(f.session.id, 0, (state) => {
            ;(state.taskRecords ??= []).push({ task_id: 106010, count: 1 })
        })
        assert.equal(f.sync(f.call('ChatRoomNum', { chat_type: 2 })).social_wheel[0].id, 37)
        const row = f.tables.find('social_wheel', 37),
            previous = row.state
        try {
            row.state = 0
            assert.equal(socialWheelSnapshot(f.tables, f.state()).social_wheel[0].id, 0)
            assert.throws(
                () => f.call('SelectEmoticons', { u32: 37 }),
                (error) => error.code === ErrorCode.InvalidSocialWheelData,
            )
        } finally {
            row.state = previous
        }
    } finally {
        f.close()
    }
})

test('incompatible current action identity or a malformed saved version cannot rewrite slots', () => {
    const f = setup()
    try {
        const rows = structuredClone(f.tables.get('social_wheel'))
        rows.find((row) => row.id === 37).action = 'different-current-action'
        const fake = {
                get(name) {
                    assert.equal(name, 'social_wheel')
                    return rows
                },
            },
            slots = oldSlots(),
            before = structuredClone(slots)
        assert.throws(
            () => projectSavedSocialWheel(fake, {}, slots),
            (error) => error.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(slots, before)
        assert.throws(
            () => projectSavedSocialWheel(f.tables, { catalogVersion: 123 }, slots),
            (error) => error.code === ErrorCode.GameConfig,
        )
        assert.deepEqual(slots, before)
    } finally {
        f.close()
    }
})
