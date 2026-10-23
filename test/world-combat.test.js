import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Protocol } from '../src/protocol.js'
import { Tables } from '../src/player.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { afterBattlePassBeforePush, fixtureNow } from './battle-pass-packet-fixture.js'
const config = configuration(),
    protocol = new Protocol(config.base),
    tables = new Tables(config.tables)
// Stay within a known season and reset period. The first ordinary request
// publishes the complete battle-pass task state before its own reply/relay.
const gameOptions = { clock: () => fixtureNow }
function initialSummonReply(f, packets, battle_index) {
    assert.deepEqual(
        packets.map((p) => p.id),
        [18006, 11148],
    )
    const replies = afterBattlePassBeforePush(packets, tables, f.state())
    assert.deepEqual(
        replies.map((p) => p.id),
        [11148],
    )
    assert.deepEqual(Object.keys(replies[0].data).sort(), ['battle_index', 'unit_id'])
    assert.equal(replies[0].data.battle_index, battle_index)
    return replies[0]
}
function fixture() {
    const store = new Store(':memory:'),
        game = new Game(protocol, store, tables, gameOptions),
        session = {}
    const call = (name, r = {}) => {
        const e = protocol.byName.get('CSProto' + name)
        return game
            .dispatch(session, { id: e.id, seq: 88, pushSeq: 0, payload: protocol.encode(e.req, r) })
            .map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) }))
    }
    call('EnterGame', { open_id: 'world-combat' })
    return { store, session, call, state: () => store.load(session.id).state }
}
test('hatred deltas merge/remove edges and node resets remove incoming references', () => {
    const f = fixture()
    try {
        const hero = f.state().player.heros_info.heros[0].guid,
            enemy = ((3n << 56n) | (300001n << 32n) | 123n).toString()
        const packets = f.call('ObjHatredIncSync', {
            inc: true,
            info: { id: enemy, target_obj_ids: [hero, hero], player_obj_ids: [f.session.id] },
        })
        assert.equal(packets.length, 1)
        assert.equal(packets[0].id, 10805)
        assert.equal(packets.at(-1).id, 10805)
        assert.deepEqual(f.state().combat.hatred.objects[enemy].target_obj_ids, [hero])
        f.call('PlayerHatredIncSync', { inc: true, info: { id: String(f.session.id), target_obj_ids: [enemy] } })
        f.call('ObjHatredIncSync', { inc: false, info: { id: enemy, target_obj_ids: [hero] } })
        assert.deepEqual(f.state().combat.hatred.objects[enemy].target_obj_ids, [])
        f.call('HatredResetToHomeSync', { obj_id: enemy })
        assert.deepEqual(f.state().combat.hatred, { objects: {}, players: {} })
        const before = f.store.load(f.session.id)
        assert.throws(() => f.call('ObjHatredIncSync', { inc: true, info: { id: enemy, target_obj_ids: ['0'] } }))
        assert.deepEqual(f.store.load(f.session.id), before)
    } finally {
        f.store.close()
    }
})
test('summon acknowledgement maps the client battle index to a stable server identity', () => {
    const f = fixture()
    try {
        const [hero, other] = f.state().player.heros_info.heros,
            request = {
                unit_id: hero.guid,
                summon_info: { config_id: 300001, summon_type: 1, skill_id: 20011, lv: 1, pos_x: 123 },
                verify_info: { battle_index: '9007199254740993' },
                op_time: '1000',
            }
        const first = f.call('CreateSummon', request)
        const firstReply = initialSummonReply(f, first, '9007199254740993')
        const id = firstReply.data.unit_id
        assert.equal(BigInt(id) >> 56n, 17n)
        assert.equal(BigInt(id) & 0xffffffffn, BigInt(f.session.id))
        assert.equal(f.state().combat.summons[id].owner_id, hero.guid)
        assert.deepEqual(f.call('CreateSummon', request), [firstReply])
        assert.equal(Object.keys(f.state().combat.summons).length, 1)
        const before = f.store.load(f.session.id)
        assert.throws(() => f.call('CreateSummon', { ...request, unit_id: other.guid }))
        assert.deepEqual(f.store.load(f.session.id), before)
        f.call('CreateBullet', { unit_id: id, bullet_info: [{ bullet_id: '555', config_id: 100 }] })
        f.call('SkillStart', { unit_id: id, skill: { skill_id: 20011 } })
        const removed = f.call('RemoveSummon', { unit_id: id, op: 1, op_time: '2000' })
        assert.equal(removed.at(-1).id, 11107)
        assert.equal(f.state().combat.summons[id], undefined)
        assert.equal(f.state().combat.skills[id], undefined)
        assert.equal(f.state().combat.bullets['555'], undefined)
        assert.deepEqual(f.call('RemoveSummon', { unit_id: id }), [])
        assert.deepEqual(f.call('CreateSummon', request), [
            { id: 11148, data: { unit_id: '0', battle_index: request.verify_info.battle_index } },
        ])
    } finally {
        f.store.close()
    }
})
test('independent summons preserve valid client IDs and reject another account namespace', () => {
    const f = fixture()
    try {
        const hero = f.state().player.heros_info.heros[0].guid,
            id = ((17n << 56n) | (1n << 32n) | BigInt(f.session.id)).toString()
        const request = {
            unit_id: hero,
            summon_info: { unit_id: id, config_id: 123, summon_type: 3 },
            verify_info: { battle_index: '7' },
        }
        assert.deepEqual(initialSummonReply(f, f.call('CreateSummon', request), '7'), {
            id: 11148,
            data: { unit_id: id, battle_index: '7' },
        })
        const before = f.store.load(f.session.id)
        assert.throws(() =>
            f.call('CreateSummon', {
                ...request,
                verify_info: { battle_index: '8' },
                summon_info: { ...request.summon_info, unit_id: (BigInt(id) + 1n).toString() },
            }),
        )
        assert.deepEqual(f.store.load(f.session.id), before)
    } finally {
        f.store.close()
    }
})

test('reconnecting permits restarted summon indices while preserving enemy HP', () => {
    const f = fixture()
    try {
        const [hero, other] = f.state().player.heros_info.heros
        const request = {
            unit_id: hero.guid,
            summon_info: { config_id: 300001, summon_type: 1, skill_id: 20011 },
            verify_info: { battle_index: '4294967304' },
        }
        const first = initialSummonReply(f, f.call('CreateSummon', request), '4294967304').data.unit_id
        f.store.transact(f.session.id, 0, (s) => {
            s.combat.entities['enemy-fixture'] = { hp: 82 }
        })
        const game = new Game(protocol, f.store, tables, gameOptions),
            session = {},
            enter = protocol.byName.get('CSProtoEnterGame')
        game.dispatch(session, {
            id: enter.id,
            seq: 1,
            payload: protocol.encode(enter.req, { open_id: 'world-combat' }),
        })
        const e = protocol.byName.get('CSProtoCreateSummon'),
            packets = game.dispatch(session, {
                id: e.id,
                seq: 2,
                payload: protocol.encode(e.req, {
                    ...request,
                    unit_id: other.guid,
                    summon_info: { config_id: 480056, summon_type: 2, skill_id: 10700161 },
                }),
            })
        assert.deepEqual(
            packets.map((p) => p.id),
            [11148],
        )
        const secondReply = protocol.decode(protocol.byId.get(packets[0].id).rsp, packets[0].payload)
        assert.equal(secondReply.battle_index, '4294967304')
        const second = secondReply.unit_id
        assert.notEqual(second, first)
        assert.equal(f.state().combat.summons[first], undefined)
        assert.equal(f.state().combat.entities['enemy-fixture'].hp, 82)
    } finally {
        f.store.close()
    }
})
test('fight break updates are local values, not skill cancellation or rewards', () => {
    const f = fixture()
    try {
        const hero = f.state().player.heros_info.heros[0].guid
        f.call('SkillStart', { unit_id: hero, skill: { skill_id: 20011 } })
        assert.deepEqual(
            f.call('FightBreak', { infos: [{ tarId: hero, val: { val: 17, chg_time_p: '9007199254740993' } }] }),
            [],
        )
        assert.equal(f.state().combat.breakValues[hero].val, 17)
        assert(f.state().combat.skills[hero])
    } finally {
        f.store.close()
    }
})

test('logged independent skill summons allow zero config and retain owner and retry checks', () => {
    const f = fixture()
    try {
        const request = {
            unit_id: '72521459095830529',
            summon_info: {
                unit_id: '1224979102939742209',
                config_id: 0,
                summon_type: 3,
                skill_id: 10800203,
                skill_track_id: '0',
                pos_x: 1197,
                pos_y: 3118,
                pos_z: -7909,
                dir_y: 274,
                skill_start_frame: 25,
            },
            verify_info: { battle_index: '4294967354' },
        }
        const packets = f.call('CreateSummon', request)
        const firstReply = initialSummonReply(f, packets, '4294967354')
        assert.equal(firstReply.data.unit_id, request.summon_info.unit_id)
        assert.deepEqual(f.call('CreateSummon', request), [firstReply])
        const before = f.store.load(f.session.id)
        for (const changes of [
            { skill_id: 10800213 },
            { skill_id: 0 },
            { summon_type: 1 },
            { unit_id: '1224979102939742210' },
        ]) {
            assert.throws(() =>
                f.call('CreateSummon', { ...request, summon_info: { ...request.summon_info, ...changes } }),
            )
            assert.deepEqual(f.store.load(f.session.id), before)
        }
    } finally {
        f.store.close()
    }
})

test('logged duel behavior-tree report is bounded uint64 telemetry without a response or reward', () => {
    const f = fixture()
    try {
        const guids = ['216172790703918911', '216172786408951615', '216172782113984319'],
            before = f.state().player
        assert.deepEqual(f.call('KiboDuelBTTreeRunning', { guids }), [])
        assert.deepEqual(f.state().combat.kiboDuelTreeReport.guids, guids)
        assert.deepEqual(f.state().player, before)
        for (const invalid of [['0'], Array(257).fill(guids[0])]) {
            const snapshot = f.store.load(f.session.id)
            assert.throws(() => f.call('KiboDuelBTTreeRunning', { guids: invalid }))
            assert.deepEqual(f.store.load(f.session.id), snapshot)
        }
        f.call('KiboDuelBTTreeRunning', { guids: [] })
        assert.deepEqual(f.state().combat.kiboDuelTreeReport.guids, [])
    } finally {
        f.store.close()
    }
})

test('pet presentation relays only to map peers without echo or ownership changes', () => {
    const f = fixture()
    try {
        const pet = f.state().pets[0],
            player = f.state().player,
            beforePet = structuredClone(pet)
        for (const type of [1, 2, 0]) {
            const e = protocol.byName.get('CSProtoSwitchPetAction')
            const game = new Game(protocol, f.store, tables, gameOptions)
            const packets = game.dispatch(f.session, {
                id: e.id,
                seq: 123,
                payload: protocol.encode(e.req, { uuid: pet.guid, type }),
            })
            assert.deepEqual(
                packets.map((p) => p.id),
                type === 1 ? [18006, 11062] : [11062],
            )
            if (type === 1) {
                assert.equal(packets[0].audience, undefined)
                assert.equal(packets[0].recipient, undefined)
            }
            const relays = afterBattlePassBeforePush(
                packets.map((p) => ({ id: p.id, data: protocol.decode(protocol.byId.get(p.id).rsp, p.payload) })),
                tables,
                f.state(),
            )
            assert.deepEqual(
                relays.map((p) => p.id),
                [11062],
            )
            const relay = packets.at(-1)
            assert.deepEqual(relay.audience, { kind: 'map', map: f.state().world.map_id, sender: f.session.id })
            assert.equal(relay.recipient, undefined)
            assert.deepEqual(protocol.decode('SwitchPetAction', relay.payload), { uuid: pet.guid, type })
            assert.equal(f.state().combat.petPresentation[pet.guid].type, type)
        }
        assert.deepEqual(f.state().pets[0], beforePet)
        assert.deepEqual(f.state().player, player)
        const before = f.store.load(f.session.id)
        assert.throws(() => f.call('SwitchPetAction', { uuid: '18446744073709551615', type: 1 }), /not owned/)
        assert.deepEqual(f.store.load(f.session.id), before)
    } finally {
        f.store.close()
    }
})

test('frequent hatred deltas preserve battle relations without global10808 or immediate SQLite writes', () => {
    const f = fixture()
    try {
        const hero = f.state().player.heros_info.heros[0].guid,
            enemy = '216172782118283809'
        const db = () => f.store.db.prepare('select state,revision from players where account_id=?').get(f.session.id)
        const before = db(),
            count = f.store.db.prepare('select count(*) n from request_log').get().n
        for (let i = 0; i < 20; i++) {
            const packets = f.call('ObjHatredIncSync', { inc: true, info: { id: enemy, target_obj_ids: [hero] } })
            assert.deepEqual(
                packets.map((p) => p.id),
                [10805],
            )
            assert.deepEqual(packets[0].data.info.target_obj_ids, [hero])
            assert.equal(packets[0].data.inc, true)
        }
        assert.deepEqual(db(), before)
        assert.equal(f.store.db.prepare('select count(*) n from request_log').get().n, count)
        const committed = f.store.load(f.session.id)
        assert.throws(() => f.call('ObjHatredIncSync', { inc: false, info: { id: enemy, target_obj_ids: ['0'] } }))
        assert.deepEqual(f.store.load(f.session.id), committed)
        assert.deepEqual(
            f.call('HatredResetToHomeSync', { obj_id: enemy }).map((p) => p.id),
            [10809],
        )
        assert.deepEqual(f.state().combat.hatred, { objects: {}, players: {} })
    } finally {
        f.store.close()
    }
})
