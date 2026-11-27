import test from 'node:test'
import assert from 'node:assert/strict'
import { createNormalStarterFixture } from './normal-starter-current-fixture.js'
import { ErrorCode } from '../src/error-codes.js'

const bytes = (text) => Buffer.from(text, 'utf8').toString('base64')

test('current creation6135 check1 only validates before5010 and does not consume the normal rename cooldown', () => {
    const f = createNormalStarterFixture('current-name-preflight')
    try {
        f.login()
        f.call('PinchFaceDataUp', { sex: 1 })
        const before = structuredClone(f.state().player.basic_info),
            persona = structuredClone(f.state().normalStarterAvatar),
            pending = structuredClone(f.state().pendingCharacterTask),
            name = bytes('初见123456'),
            replies = f.call('ChangeName', { name, check: 1 }),
            ack = replies.find((packet) => packet.id === 6135)
        assert(ack, 'PageCreatePlayer waits for this6135 success callback before continuing its timeline')
        assert.deepEqual(f.protocol.decode(f.protocol.byId.get(6135).rsp, ack.payload), {})
        assert.deepEqual(
            f.state().player.basic_info,
            before,
            'Checking a candidate must not rename or write a cooldown',
        )
        assert.deepEqual(f.state().normalStarterAvatar, persona)
        assert.deepEqual(f.state().pendingCharacterTask, pending, 'Preflight does not complete character customization')
        assert.notEqual(f.state().characterCustomized, true)
        assert(
            !replies.some(
                (packet) =>
                    packet.id === 5008 &&
                    f.protocol.decode(f.protocol.byId.get(5008).rsp, packet.payload).basic_info?.name === name,
            ),
        )
        assert.throws(
            () => f.call('ChangeName', { name: bytes('A1234567'), check: 1 }),
            (error) => error.code === ErrorCode.InvalidNick,
        )
        assert.deepEqual(f.state().player.basic_info, before)
        f.call('PlayerCustomData', { name, wardrobe_info: { ...f.state().player.basic_info.wardrobe, sex: 1 } })
        assert.equal(f.state().player.basic_info.name, name)
        assert.equal(f.state().characterCustomized, true)
        assert.equal(f.state().player.basic_info.last_change_name_time ?? 0, before.last_change_name_time ?? 0)
        // Current user rename sender omits check; that mutation still records
        // the table-defined cooldown. check1 cannot bypass it into a mutation.
        f.call('ChangeName', { name: bytes('再次相逢') })
        const afterRename = structuredClone(f.state().player.basic_info)
        f.call('ChangeName', { name: bytes('另一名字'), check: 1 })
        f.call('ChangeName', { name: afterRename.name, check: 1 })
        assert.deepEqual(f.state().player.basic_info, afterRename)
        assert.throws(
            () => f.call('ChangeName', { name: bytes('另一名字') }),
            (error) => error.code === ErrorCode.ChangeNameTimeLimit,
        )
        assert.throws(
            () => f.call('ChangeName', { name: bytes('另一名字'), check: 2 }),
            (error) => error.code === ErrorCode.FunctionClosed,
        )
        assert.deepEqual(f.state().player.basic_info, afterRename)
    } finally {
        f.close()
    }
})
