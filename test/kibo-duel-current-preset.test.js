import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { ErrorCode } from '../src/error-codes.js'
import { selectedArenaGroup } from '../src/npc-kibo-duel.js'
const config = configuration(),
    tables = new Tables(config.tables),
    protocol = new Protocol(config.base)
function setup() {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables, { clock: () => 1792682000 })
    let session = {},
        seq = 1
    const call = (name, r) => {
        const e = protocol.byName.get('CSProto' + name)
        return game.dispatch(session, { id: e.id, seq: seq++, payload: protocol.encode(e.req, r) })
    }
    const login = () => {
        session = {}
        return call('EnterGame', { open_id: 'duel-current-preset' })
    }
    login()
    return {
        store,
        call,
        login,
        state: () => store.load(session.id).state,
        saved: () => JSON.parse(store.db.prepare('SELECT state FROM players WHERE account_id=?').get(session.id).state),
    }
}
const snapshot = (packets) => {
    const e = protocol.byName.get('CSProtoKiboDuelGroupInfoSync'),
        p = packets.find((p) => p.id === e.id)
    assert.ok(p)
    return protocol.decode(e.rsp, p.payload)
}
test('10743 selects a valid empty preset, persists it and syncs before ACK without changing ordinary or arena selection', () => {
    const f = setup()
    try {
        const before = f.state(),
            packets = f.call('KiboDuelSetCurGroup', { u32: 5 }),
            data = snapshot(packets)
        assert.equal(data.use_slot, 5)
        const group = data.groups.find((g) => g.slot === 5)
        assert.equal(group.hero, '0')
        assert.ok(group.pet_guids.every((p) => p.id === '0'))
        assert.equal(f.state().kiboDuelGroups, before.kiboDuelGroups)
        assert.deepEqual(f.state().player.group_mgrs, before.player.group_mgrs)
        const push = packets.findIndex((p) => p.id === 10740),
            ack = packets.findIndex((p) => p.id === 10743)
        assert.ok(push >= 0 && ack >= 0 && push < ack)
        f.store.flushPending()
        assert.equal(f.saved().kiboDuelSlot, 5)
        assert.equal(snapshot(f.login()).use_slot, 5)
    } finally {
        f.store.close()
    }
})
test('opening a configured duel preparation no longer overwrites the chosen normal preset with slot1', () => {
    const f = setup()
    try {
        f.call('KiboDuelSetCurGroup', { u32: 3 })
        const prepared = f.call('KiboDuelGetGroup', { u32: 501 })
        assert.equal(snapshot(prepared).use_slot, 3)
        assert.equal(f.state().kiboDuelSlot, 3)
        f.call('KiboDuelSetCurGroup', { u32: 98 })
        assert.equal(f.state().kiboDuelSlot, 98)
        assert.equal(snapshot(f.call('KiboDuelGetGroup', { u32: 501 })).use_slot, 98)
    } finally {
        f.store.close()
    }
})
test('invalid and unprepared reserved selectors fail atomically without manufacturing a borrowed roster', () => {
    const f = setup()
    try {
        for (const [slot, code] of [
            [0, ErrorCode.InvalidArgument],
            [6, ErrorCode.KiboDuelGroupExceedMaxNum],
            [98, ErrorCode.KiboDuelCurGroupNotSet],
            [99, ErrorCode.KiboDuelGroupExceedMaxNum],
        ]) {
            const before = f.state()
            assert.throws(
                () => f.call('KiboDuelSetCurGroup', { u32: slot }),
                (e) => e.code === code,
            )
            assert.deepEqual(f.state(), before)
        }
    } finally {
        f.store.close()
    }
})
test('selecting another future preset during an NPC battle preserves its current formation and actors', () => {
    const f = setup()
    try {
        const state = f.state(),
            hero = state.player.heros_info.heros[0].guid
        f.call('KiboDuelGroupInfoChange', {
            slot: 1,
            duel_id: 2,
            hero,
            pet_guids: state.pets.slice(0, 8).map((p) => ({ id: p.guid })),
            hero_skills: [
                { skill_id: 19999901, skill_lv: 1, skill_slot: 701, type: 1 },
                { skill_id: 19999902, skill_lv: 1, skill_slot: 702, type: 1 },
            ],
        })
        f.call('SetKiboDuelCurGroup', { type: 6, cur_group: 1 })
        f.call('MultiCampaignCreate', { dungeon_id: 40001 })
        const before = f.state()
        f.call('KiboDuelSetCurGroup', { u32: 5 })
        const after = f.state()
        assert.equal(after.kiboDuelSlot, 5)
        assert.equal(after.multiCampaign.formation_slot, 1)
        assert.deepEqual(selectedArenaGroup(after), selectedArenaGroup(before))
        assert.deepEqual(after.combat.npcDuel.actors, before.combat.npcDuel.actors)
    } finally {
        f.store.close()
    }
})
test('selector notification encoding failure rolls back the chosen slot', () => {
    const f = setup()
    try {
        f.call('KiboDuelSetCurGroup', { u32: 2 })
        const before = f.state(),
            old = protocol.encode
        protocol.encode = function (name, r) {
            if (name === protocol.byName.get('CSProtoKiboDuelGroupInfoSync').rsp) throw Error('selection codec failed')
            return old.call(this, name, r)
        }
        try {
            assert.throws(() => f.call('KiboDuelSetCurGroup', { u32: 4 }), /selection codec failed/)
        } finally {
            protocol.encode = old
        }
        assert.deepEqual(f.state(), before)
    } finally {
        f.store.close()
    }
})
