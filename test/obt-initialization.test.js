import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'

test('a fresh 1.0.0 account enters with strict new schemas and preserves legacy records on reconnect', () => {
    const config = configuration(),
        tables = new Tables(config.tables)
    const protocol = new Protocol(config.base),
        store = new Store(':memory:')
    const now = 1800000000
    try {
        const game = new Game(protocol, store, tables, { clock: () => now })
        const login = (seq) => {
            const session = {},
                entry = protocol.byName.get('CSProtoEnterGame')
            const packets = game.dispatch(session, {
                id: entry.id,
                seq,
                payload: protocol.encode(entry.req, { open_id: 'obt-current-initialization-only' }),
            })
            const reply = packets.find((packet) => packet.id === entry.id)
            assert(reply)
            assert(protocol.decode(entry.rsp, reply.payload).data)
            assert(session.id)
            for (const packet of packets) {
                const type = protocol.byId.get(packet.id)?.rsp
                assert(type, `Missing current response schema ${packet.id}`)
                protocol.decode(type, packet.payload)
            }
            // 5907 now names MailboxDelta, not the retired old MailSync.
            assert.equal(
                packets.some((packet) => packet.id === 5907),
                false,
            )
            return { session, packets }
        }
        const first = login(1)
        const initial = store.load(first.session.id).state
        assert.equal(initial.home.builds.length, 3)
        const wolf = initial.pets.find((pet) => pet.config_id === 500001)
        assert(wolf)
        assert.deepEqual(wolf.labor_infos, [{ labor_id: 3, labor_grade: 20, upper_labor_grade: 20, labor_exp: 0 }])
        const oldProgress = { claimedTasks: { 101: true }, claimedGroups: { 1: true }, completedTasks: { 101: true } }
        const oldMail = [{ id: 900001, is_read: false, is_get: false, end_time: 4102444800, attachments: [] }]
        store.transact(first.session.id, 0, (state) => {
            state.noviceTasks = structuredClone(oldProgress)
            state.mail = structuredClone(oldMail)
        })
        const second = login(2)
        assert.equal(second.session.id, first.session.id)
        const saved = store.load(second.session.id).state
        assert.deepEqual(saved.noviceTasks, oldProgress)
        assert.deepEqual(saved.mail, oldMail)
        assert.equal(saved.home.builds.length, 3)
    } finally {
        store.close()
    }
})
