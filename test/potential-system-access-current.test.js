import { preparedSystemAccess } from '../src/system-access.js'
import { playerIsInBattle } from '../src/player-battle-state.js'
import { newStarterProfile } from '../src/starter-profile.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configuration } from '../src/config.js'
import { Tables, seedPlayer } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { createPets } from '../src/pets.js'
import { grantRewards, parseRewards } from '../src/rewards.js'
import { releaseLedger } from '../src/release-ledger.js'
import {
    petPotentialTrainingPlan,
    petPotentialDistribution,
    selectPetPotentialOutcome,
    validatePetPotentialPolicy,
} from '../src/pet-potential-training.js'
import { petReleaseColorRewards } from '../src/pet-release-colors.js'
import policy from '../configs/pet-potential-training-policy.json' with { type: 'json' }
import { ErrorCode } from '../src/error-codes.js'
import { ranchFixture } from './ranch-fixture.js'
import { technologyState, technologyPoints } from '../src/technology.js'

function tiers(tables, pet, level) {
    pet.comprehension = tables.get('pet_learningenum').map((row) => ({
        attr_id: row.attributeEnum,
        level,
        value: tables.get('pet_talent_upgrade').find((x) => x.attrId === row.attributeEnum && x.level === level).InterA,
        init_level: 1,
        cur_exp: 0,
    }))
}
function fixture(name, { file = ':memory:', count = 3, configId = 500001, profile = 'legacy', playerLevel = 20 } = {}) {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        protocol = new Protocol(cfg.base)
    let store = new Store(file),
        now = 1800000000,
        sequence = 1,
        game,
        session = {}
    const start = () => {
        game = new Game(protocol, store, tables, { clock: () => now, rng: () => 0 })
        const entry = protocol.byName.get('CSProtoKiboTrain')
        assert.equal(entry.id, 11913)
        assert(game.handlers.has(entry.id), 'the default Game must register current potential training')
    }
    start()
    const frame = (name, request) => {
        const entry = protocol.byName.get('CSProto' + name)
        return { id: entry.id, seq: sequence++, payload: protocol.encode(entry.req, request) }
    }
    const call = (name, request) => game.dispatch(session, frame(name, request)),
        account = 'candidate-potential-' + name
    store.login(account, (id, openId) => {
        const state = seedPlayer(tables, id, openId)
        if (profile === 'legacy') delete state.starterProfile
        else state.starterProfile = newStarterProfile(profile)
        state.player.basic_info.lv = playerLevel
        return state
    })
    call('EnterGame', { open_id: account })
    let ids
    store.transact(session.id, 0, (state) => {
        // Trusted account/progression baseline. Pet allocation and ownership
        // are produced by the current createPets allocator, not naked GUIDs.
        state.player.basic_info.lv = playerLevel
        state.tasks = []
        state.taskRecords = tables.get('task').map((row) => ({ task_id: row.id, count: 1, time: now - 1 }))
        ids = createPets(tables, state, configId, count, 1001).map((pet) => pet.guid)
        for (const id of ids) {
            const pet = state.pets.find((p) => p.guid === id)
            tiers(tables, pet, id === ids[0] ? 2 : 9)
            pet.lv = 1
            pet.base_lv = 1
            pet.exp = 0
            pet.suppress_lv = 0
            pet.hero_id = '0'
            pet.work_status = 0
            pet.work_build = 0
            pet.capacity_id = 0
            pet.is_lock = false
        }
        grantRewards(tables, state, [{ itemtype: 3, itemid: 1760000, itemnum: 10000 }])
        technologyState(tables, state)
        technologyPoints(tables, state)
    })
    // Ping is transport-only. A current empty popup query legitimately runs
    // ordinary observers without manufacturing or clearing a payment receipt.
    const popupState = store.load(session.id).state
    assert.equal(popupState.mall?.popupQueue?.length ?? 0, 0)
    assert.equal(popupState.mall?.pendingPopup, undefined)
    const popup = call('GetRechargePopupData', {}).find((p) => p.id === 18048)
    assert.equal(protocol.decode(protocol.byId.get(18048).rsp, popup.payload).popup_id ?? 0, 0)
    const state = () => store.load(session.id).state,
        edit = (fn) => store.transact(session.id, 0, fn),
        request = (attr = 7, partner = ids[1]) => ({
            type: 2,
            train_pet: ids[0],
            partner_train_pet: partner,
            choose_type: attr,
        })
    return {
        cfg,
        tables,
        protocol,
        ids,
        state,
        edit,
        request,
        call,
        frame,
        get game() {
            return game
        },
        get store() {
            return store
        },
        get session() {
            return session
        },
        pet: (id = ids[0]) => state().pets.find((pet) => pet.guid === id),
        train: (req = request()) => call('KiboTrain', req),
        dispatch: (packet) => game.dispatch(session, packet),
        now: () => now,
        advance: (seconds) => {
            now += seconds
        },
        snapshot: () => store.load(session.id),
        reopen: () => {
            assert.notEqual(file, ':memory:')
            store.close()
            store = new Store(file)
            start()
            session = {}
            return call('EnterGame', { open_id: account, reconnect: true })
        },
        close: () => store.close(),
    }
}
const itemNum = (state, id) =>
    state.player.sbag_infos.items.filter((x) => x.itemid === id).reduce((sum, x) => sum + x.itemnum, 0)
const currency = (state, id) => BigInt(state.player.attr_infos.attrs.find((row) => row.attr_id === id)?.attr_val ?? '0')
function published(f, packets, removed) {
    const ack = packets.findIndex((x) => x.id === 11913),
        sync = packets.findIndex((x) => x.id === 6517)
    assert(ack >= 0 && sync >= 0 && sync < ack)
    assert(
        packets.some((x, i) => x.id === 10006 && i < ack),
        'derived live combat attributes precede the UI callback',
    )
    const battle = f.protocol.decode(
            f.protocol.byId.get(10006).rsp,
            packets.find((packet) => packet.id === 10006).payload,
        ),
        targetBattle = battle.heros.find((row) => row.hero_guid === f.ids[0])
    assert(targetBattle, 'actual target instance has a live battle-property payload')
    assert.equal(targetBattle.type, 2)
    assert.equal(targetBattle.hero_conf_id, f.pet().config_id)
    assert(
        !battle.heros.some((row) => row.hero_guid === removed),
        'consumed partner is absent from the live battle-property roster',
    )
    const payload = f.protocol.decode(f.protocol.byId.get(6517).rsp, packets[sync].payload),
        reply = f.protocol.decode(f.protocol.byId.get(11913).rsp, packets[ack].payload)
    assert.equal(reply.is_success, true)
    assert(payload.pet_infos.guid.includes(removed))
    assert.equal(payload.free_reward_num, f.state().releaseLedgers.pet.count)
    assert.equal(payload.last_free_time, f.state().releaseLedgers.pet.lastTime)
    return { payload, reply, pet: payload.pet_infos.pets.find((pet) => pet.guid === f.ids[0]) }
}
function unchanged(f, run, predicate) {
    const before = f.snapshot(),
        sql = f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id)
    assert.throws(run, predicate)
    assert.deepEqual(f.snapshot(), before)
    assert.deepEqual(f.store.db.prepare('SELECT state,revision FROM players WHERE account_id=?').get(f.session.id), sql)
}

test('legacy permanent510 open permits real low-level11913 without skipping fees, partner removal, or live metadata', () => {
    const f = fixture('system-legacy', { playerLevel: 1 })
    try {
        assert.equal(preparedSystemAccess(f.tables, f.state(), 510), true)
        assert.equal(f.state().player.basic_info.lv, 1)
        const before = f.state(),
            cost = parseRewards(f.tables.find('pet_train_cost', 3).recommendAttributeCost)[0],
            ps = f.train(),
            ack = ps.find((p) => p.id === 11913)
        assert.equal(f.protocol.decode(f.protocol.byId.get(11913).rsp, ack.payload).is_success, true)
        assert(ps.findIndex((p) => p.id === 6517) < ps.findIndex((p) => p.id === 11913))
        assert(ps.findIndex((p) => p.id === 10006) < ps.findIndex((p) => p.id === 11913))
        assert(!f.state().pets.some((p) => p.guid === f.ids[1]))
        assert.equal(itemNum(before, cost.itemid) - itemNum(f.state(), cost.itemid), cost.itemnum)
    } finally {
        f.close()
    }
})
test('normal19 is unearned; actual level20 observer notification permits training and later level19 cannot relock permanent510', () => {
    const f = fixture('system-normal', { profile: 'normal', playerLevel: 19 })
    try {
        assert.equal(preparedSystemAccess(f.tables, f.state(), 510), false)
        unchanged(
            f,
            () => f.train(),
            (e) => e.code === ErrorCode.SystemLock,
        )
        // Authoritative explicit GM level change is a controlled level-event fixture,
        // not a claim that this test earns all prior account experience naturally.
        const opened = f.call('GMCommand', { command: Buffer.from('level 20').toString('base64') })
        const notified = opened
            .filter((p) => p.id === 10600)
            .flatMap((p) => f.protocol.decode(f.protocol.byId.get(10600).rsp, p.payload).unlock_id ?? [])
        assert(notified.includes(510))
        assert.equal(preparedSystemAccess(f.tables, f.state(), 510), true)
        assert.equal(
            f.protocol.decode(f.protocol.byId.get(11913).rsp, f.train().find((p) => p.id === 11913).payload).is_success,
            true,
        )
        f.call('GMCommand', { command: Buffer.from('level 19').toString('base64') })
        assert.equal(preparedSystemAccess(f.tables, f.state(), 510), true)
        assert.equal(
            f.protocol.decode(
                f.protocol.byId.get(11913).rsp,
                f.train(f.request(5, f.ids[2])).find((p) => p.id === 11913).payload,
            ).is_success,
            true,
        )
    } finally {
        f.close()
    }
})
test('strict prepared null/stale/projection guards and pre-bootstrap level fallback preserve original training authority', () => {
    const f = fixture('system-integrity')
    try {
        const good = f.state(),
            restore = () =>
                f.edit((s) => {
                    for (const k of Object.keys(s)) delete s[k]
                    Object.assign(s, structuredClone(good))
                })
        for (const mutate of [
            (s) => {
                s.systemUnlockProgress = null
            },
            (s) => {
                s.systemUnlockProgress.sourceHash = 'bad'
            },
            (s) => {
                s.player.basic_info.lock_system.push(510)
            },
        ]) {
            restore()
            f.edit(mutate)
            unchanged(
                f,
                () => f.train(),
                (e) => e.code === ErrorCode.GameConfig,
            )
        }
        restore()
        f.edit((s) => {
            delete s.systemUnlockProgress
            s.player.basic_info.lv = 19
        })
        unchanged(
            f,
            () => f.train(),
            (e) => e.code === ErrorCode.SystemLock,
        )
        f.edit((s) => {
            s.player.basic_info.lv = 20
        })
        assert.equal(
            f.protocol.decode(f.protocol.byId.get(11913).rsp, f.train().find((p) => p.id === 11913).payload).is_success,
            true,
        )
        assert.equal(f.state().systemUnlockProgress, undefined, 'training does not invent a missing system ledger')
    } finally {
        f.close()
    }
})

test('permanently open510 does not skip the independent out-of-battle guard', () => {
    const f = fixture('system-combat', { playerLevel: 1 })
    try {
        const current = f.state(),
            before = structuredClone(current),
            player = String(current.player.basic_info.id)
        current.combat ??= {}
        current.combat.map_id = current.world.map_id
        // A declared authoritative relation-graph fixture proves guard placement;
        // it does not claim to play or manufacture a combat encounter through UI.
        current.combat.hatred = {
            players: { [player]: { id: player, target_obj_ids: ['216172782114383809'], player_obj_ids: [] } },
            objects: {},
        }
        assert.equal(preparedSystemAccess(f.tables, current, 510), true)
        assert(playerIsInBattle(current))
        assert.throws(
            () => petPotentialTrainingPlan({ tables: f.tables, state: current, now: f.now() }, f.request()),
            (e) => e.code === ErrorCode.PlayerInFight,
        )
        assert.deepEqual(f.state(), before)
    } finally {
        f.close()
    }
})
