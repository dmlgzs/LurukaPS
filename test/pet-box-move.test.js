import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'

test('6541 moves only the selected pet to a table-bounded empty slot, updates its box and survives reconnect', () => {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base),
        store = new Store(':memory:'),
        game = new Game(protocol, store, tables),
        session = {}
    let seq = 1
    const call = (name, data, who = session) => {
        const entry = protocol.byName.get('CSProto' + name)
        return game.dispatch(who, { id: entry.id, seq: seq++, payload: protocol.encode(entry.req, data) })
    }
    const state = () => store.load(session.id).state
    try {
        call('EnterGame', { open_id: 'pet-box-move' })
        const maxBox = Number(tables.get('game').find((row) => row.title === 'PET_BOX_NUM').value)
        const maxSlot = Number(tables.get('game').find((row) => row.title === 'PET_BOX_LIMIT').value)
        const first = state().pets[0],
            second = state().pets[1]
        store.transact(session.id, 0, (s) => {
            s.pets = s.pets.slice(0, 2)
            s.petBoxes = s.petBoxes.filter((box) => box.id !== maxBox)
        })
        const target = maxBox * 100 + maxSlot
        const packets = call('SetPetBoxInfo', { guid: first.guid, box_id: target })
        assert.equal(packets.at(-1).id, 6541)
        assert.ok(packets.slice(0, -1).some((packet) => packet.id === protocol.byName.get('CSProtoPetInfoSync').id))
        assert.ok(packets.slice(0, -1).some((packet) => packet.id === protocol.byName.get('CSProtoPetBoxInfoSync').id))
        assert.equal(state().pets.find((row) => row.guid === first.guid).box_id, target)
        assert.equal(state().pets.find((row) => row.guid === second.guid).box_id, second.box_id)
        call('SetPetBoxInfo', { guid: first.guid, box_id: target })
        call('EnterGame', { open_id: 'pet-box-move' }, {})
        assert.equal(state().pets.find((row) => row.guid === first.guid).box_id, target)
        for (const box_id of [0, 100, maxBox * 100 + maxSlot + 1, (maxBox + 1) * 100 + 1]) {
            const before = structuredClone(state())
            assert.throws(
                () => call('SetPetBoxInfo', { guid: first.guid, box_id }),
                (error) => error.code === ErrorCode.PetBoxNumLimimt,
            )
            assert.deepEqual(state(), before)
        }
        assert.throws(
            () => call('SetPetBoxInfo', { guid: first.guid, box_id: second.box_id }),
            (error) => error.code === ErrorCode.PetBoxIdIsExist,
        )
        assert.throws(
            () => call('SetPetBoxInfo', { guid: '99999999', box_id: 101 }),
            (error) => error.code === ErrorCode.PetNotExist,
        )
    } finally {
        store.close()
    }
})
