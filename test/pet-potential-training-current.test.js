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

test('all324 current type2 tier pairs are guaranteed; local weighted outcomes stay within nonzero current weights and future failure pools close', () => {
    const f = fixture('catalog')
    try {
        const baseline = f.state(),
            target = baseline.pets.find((p) => p.guid === f.ids[0]),
            partner = baseline.pets.find((p) => p.guid === f.ids[1])
        let tested = 0
        for (const rare of new Set(f.tables.get('pet_train').map((r) => r.petrare))) {
            const config = f.tables
                .get('pet')
                .find((row) => row.petrare === rare && row.isSpecial !== 1 && row.isRelease === 1 && row.isRename === 1)
            if (config) target.config_id = partner.config_id = config.id
            for (let level = 1; level <= 8; level++)
                for (let high = level + 1; high <= 9; high++) {
                    tiers(f.tables, target, level)
                    tiers(f.tables, partner, high)
                    const plan = petPotentialDistribution(f.tables, rare, level, high)
                    if (config)
                        assert.deepEqual(
                            petPotentialTrainingPlan({ tables: f.tables, state: baseline, now: f.now() }, f.request(7))
                                .outcomes,
                            plan.outcomes,
                        )
                    assert(plan.outcomes.length > 0)
                    assert(plan.outcomes.every((row) => row.level > level && row.level <= high && row.weight > 0))
                    assert.equal(
                        selectPetPotentialOutcome(plan, () => 0),
                        plan.outcomes[0].level,
                    )
                    assert.equal(
                        selectPetPotentialOutcome(plan, (max) => max - 1),
                        plan.outcomes.at(-1).level,
                    )
                    tested++
                }
        }
        assert.equal(tested, 324)
        const state = f.state(),
            wrapper = Object.create(f.tables)
        wrapper.get = (name) =>
            name === 'pet_train'
                ? f.tables.get(name).map((row) =>
                      row.petrare === 3 && row.starsoulgroupid === 2
                          ? {
                                ...row,
                                weight: row.weight
                                    .split('|')
                                    .map((x, i) => (i === 1 ? '1' : x))
                                    .join('|'),
                            }
                          : row,
                  )
                : f.tables.get(name)
        assert.throws(
            () => petPotentialTrainingPlan({ tables: wrapper, state, now: f.now() }, f.request()),
            (e) => e.code === ErrorCode.FunctionClosed,
        )
        assert.throws(
            () => validatePetPotentialPolicy({ ...policy, origin: 'OFFICIAL' }),
            (e) => e.code === ErrorCode.GameConfig,
        )
        const malformed = Object.create(f.tables)
        malformed.get = (name) =>
            name === 'pet_train'
                ? f.tables.get(name).map((row, i) => (i === 0 ? { ...row, weight: '-1|0' } : row))
                : f.tables.get(name)
        assert.throws(
            () => petPotentialTrainingPlan({ tables: malformed, state, now: f.now() }, f.request()),
            (e) => e.code === ErrorCode.PetTrainConfig,
        )
    } finally {
        f.close()
    }
})

test('real11913 charges recommended and other costs, consumes one partner and publishes native6517 before the success callback', () => {
    const f = fixture('flow')
    try {
        f.edit((state) => {
            const ledger = releaseLedger(state, 'pet', f.now())
            ledger.count = 29
            state.releaseLedgers ??= {}
            state.releaseLedgers.pet = ledger
            state.pets.find((p) => p.guid === f.ids[2]).lv = 6
            state.pets.find((p) => p.guid === f.ids[2]).exp = 25
            state.pets.find((p) => p.guid === f.ids[0]).comprehension.find((row) => row.attr_id === 7).cur_exp = 37
        })
        const hero = f.state().player.heros_info.heros[0]
        const worn = f.call('WearPet', { hero_guid: hero.guid, pet_guid: f.ids[0] }),
            rawLiveAttr = (packets, attr) => {
                const frame = packets.find((packet) => packet.id === 10006),
                    payload = f.protocol.decode(f.protocol.byId.get(10006).rsp, frame.payload),
                    pet = payload.heros.find((row) => row.hero_guid === f.ids[0])
                assert(pet, '10006 includes the actual equipped target pet instance')
                const value = pet.modules
                    .find((module) => module.module_type === 4)
                    .sub_modules[0].attrs.attrs.find((row) => row.attr_id === attr)
                assert(value)
                return BigInt(value.attr_val)
            },
            oldLiveCritical = rawLiveAttr(worn, 7)
        const before = f.state(),
            old = f.pet(),
            packets = f.train(),
            result = published(f, packets, f.ids[1]),
            after = f.state()
        const cost = parseRewards(f.tables.find('pet_train_cost', 3).recommendAttributeCost)[0]
        assert(
            packets.every((packet) => packet.id === 11913 || f.protocol.byId.get(packet.id).rsp !== 'cs.Rewards'),
            'refund popup data exists only in the11913 response; ordinary bag/attribute sync is not a second reward announcement',
        )
        assert.equal(itemNum(before, cost.itemid) - itemNum(after, cost.itemid), cost.itemnum)
        assert.equal(after.pets.length, before.pets.length - 1)
        assert.equal(f.pet(f.ids[1]), undefined)
        assert.equal(result.pet.comprehension.find((x) => x.attr_id === 7).level, 3)
        assert.equal(result.pet.comprehension.find((x) => x.attr_id === 7).cur_exp, 37)
        assert.equal(result.pet.comprehension.find((x) => x.attr_id === 7).init_level, 1)
        assert.equal(
            result.pet.comprehension.find((x) => x.attr_id === 7).value,
            f.tables.get('pet_talent_upgrade').find((row) => row.attrId === 7 && row.level === 3).InterA,
        )
        assert(
            rawLiveAttr(packets, 7) > oldLiveCritical,
            'the current live battle property consumes the newly trained potential, not only its displayed level',
        )
        assert.equal(after.releaseLedgers.pet.count, 30)
        assert.equal(itemNum(after, 402000) - itemNum(before, 402000), 1)
        for (const key of Object.keys(old).filter((key) => key !== 'comprehension'))
            assert.deepEqual(f.pet()[key], old[key], key)
        assert.deepEqual(
            f.pet().comprehension.filter((row) => row.attr_id !== 7),
            old.comprehension.filter((row) => row.attr_id !== 7),
        )
        // Current callback holds the same PetData object; applying6517 updates
        // it before CalcComprehensionDelta and removes only the partner.
        const client = new Map(before.pets.map((pet) => [pet.guid, structuredClone(pet)])),
            held = client.get(f.ids[0])
        for (const pet of result.payload.pet_infos.pets) Object.assign(client.get(pet.guid) ?? {}, pet)
        for (const guid of result.payload.pet_infos.guid) client.delete(guid)
        assert.equal(held.comprehension.find((row) => row.attr_id === 7).level, 3)
        assert.equal(client.has(f.ids[1]), false)
        f.advance(86400)
        const secondBefore = f.state(),
            second = published(f, f.train(f.request(5, f.ids[2])), f.ids[2])
        const other = parseRewards(f.tables.find('pet_train_cost', 3).notRecommendAttributeCost)[0]
        assert.equal(itemNum(secondBefore, other.itemid) - itemNum(f.state(), other.itemid), other.itemnum)
        assert.equal(
            f.state().releaseLedgers.pet.count,
            0,
            'new day resets to an explicit zero; experience refund consumes no daily bonus slot',
        )
        assert.equal(second.payload.free_reward_num, 0, 'Lua zero is truthy and clears its preview counter')
        assert(second.reply.reward.rewards.some((row) => row.itemid >= 402000 && row.itemid <= 402003))
    } finally {
        f.close()
    }
})

test('type2 ownership, current enum/cap, system, locks and genuine equipped partner boundaries reject without mutations', () => {
    const unearned = fixture('boundaries-unearned', { profile: 'normal', playerLevel: 19 })
    try {
        unchanged(
            unearned,
            () => unearned.train(),
            (e) => e.code === ErrorCode.SystemLock,
        )
    } finally {
        unearned.close()
    }

    const f = fixture('boundaries')
    try {
        const baseline = f.state(),
            restore = () =>
                f.edit((state) => {
                    for (const key of Object.keys(state)) delete state[key]
                    Object.assign(state, structuredClone(baseline))
                })
        const cases = [
            [() => {}, { ...f.request(), type: 1 }, ErrorCode.PetTrainTypeErr],
            [() => {}, { ...f.request(), partner_train_pet: f.ids[0] }, ErrorCode.PetTrainClientParam],
            [() => {}, f.request(4), ErrorCode.PetPetTrainCantTrainId],
            [() => {}, { ...f.request(), partner_train_pet: '144115188075999999' }, ErrorCode.PetNotExist],
            [
                (s) => {
                    s.pets.find((p) => p.guid === f.ids[1]).is_lock = true
                },
                f.request(),
                ErrorCode.PetIsLock,
            ],
            [
                (s) => {
                    s.pets.find((p) => p.guid === f.ids[1]).can_not_release = true
                },
                f.request(),
                ErrorCode.PetTrainCantDel,
            ],
            [
                (s) => {
                    tiers(
                        f.tables,
                        s.pets.find((p) => p.guid === f.ids[0]),
                        9,
                    )
                },
                f.request(),
                ErrorCode.PetPetTrainCantTrainId,
            ],
            [
                (s) => {
                    tiers(
                        f.tables,
                        s.pets.find((p) => p.guid === f.ids[1]),
                        2,
                    )
                },
                f.request(),
                ErrorCode.PetPetTrainCantTrainId,
            ],
            [
                (s) => {
                    s.pets.find((p) => p.guid === f.ids[0]).comprehension[0].value = -1
                },
                f.request(),
                ErrorCode.GameConfig,
            ],
            [
                (s) => {
                    s.player.sbag_infos.items = s.player.sbag_infos.items.filter((row) => row.itemid !== 1760000)
                },
                f.request(),
                ErrorCode.ItemNotEnough,
            ],
        ]
        for (const [prepare, request, code] of cases) {
            restore()
            f.edit(prepare)
            unchanged(
                f,
                () => f.train(request),
                (error) => error.code === code,
            )
        }
        restore()
        const otherSession = {},
            enter = f.frame('EnterGame', { open_id: 'candidate-potential-other-owner' })
        f.game.dispatch(otherSession, enter)
        let foreign, different, unsupported
        f.store.transact(otherSession.id, 0, (state) => {
            foreign = createPets(f.tables, state, 500001, 1)[0].guid
        })
        const peer = f.store.load(otherSession.id)
        unchanged(
            f,
            () => f.train({ ...f.request(), partner_train_pet: foreign }),
            (e) => e.code === ErrorCode.PetNotExist,
        )
        assert.deepEqual(f.store.load(otherSession.id), peer)
        f.edit((state) => {
            different = createPets(f.tables, state, 500025, 1)[0].guid
            unsupported = createPets(f.tables, state, 500638, 2).map((pet) => pet.guid)
        })
        unchanged(
            f,
            () => f.train({ ...f.request(), partner_train_pet: different }),
            (e) => e.code === ErrorCode.PetTrainClientParam,
        )
        unchanged(
            f,
            () => f.train({ type: 2, train_pet: unsupported[0], partner_train_pet: unsupported[1], choose_type: 7 }),
            (e) => e.code === ErrorCode.PetPetTrainCantTrainId,
        )
        const hero = f.state().player.heros_info.heros[0]
        f.call('WearPet', { hero_guid: hero.guid, pet_guid: f.ids[1] })
        unchanged(
            f,
            () => f.train(),
            (e) => e.code === ErrorCode.PetInBattle,
        )
        f.call('WearPet', { hero_guid: hero.guid, pet_guid: '0' })
        published(f, f.train(), f.ids[1])
    } finally {
        f.close()
    }
})

test('real6162 working partner cannot be consumed; withdrawing it restores the exact legal training path', () => {
    const f = ranchFixture('candidate-potential-worker', { level: 20, pets: 2 })
    try {
        assert(f.game.handlers.has(f.protocol.byName.get('CSProtoKiboTrain').id))
        f.store.transact(f.session.id, 0, (state) => {
            for (const guid of f.pets)
                tiers(
                    f.tables,
                    state.pets.find((p) => p.guid === guid),
                    guid === f.pets[0] ? 2 : 9,
                )
            grantRewards(f.tables, state, [{ itemtype: 3, itemid: 1760000, itemnum: 1000 }])
        })
        f.call('PetLock', { guid: f.pets[1], lock_operate: false })
        f.assign(f.pets[1], 1, 1)
        const before = f.store.load(f.session.id),
            request = { type: 2, train_pet: f.pets[0], partner_train_pet: f.pets[1], choose_type: 7 }
        assert(f.state().home.ranches[201].product_pets.some((slot) => slot.pet_guid === f.pets[1]))
        assert.throws(
            () => f.call('KiboTrain', request),
            (e) => e.code === ErrorCode.PetTrainCantDel,
        )
        assert.deepEqual(f.store.load(f.session.id), before)
        f.assign(f.pets[1], 1, 1) // Current same-slot click explicitly withdraws.
        const reply = f.call('KiboTrain', request).find((packet) => packet.id === 11913)
        assert.equal(f.protocol.decode(f.protocol.byId.get(11913).rsp, reply.payload).is_success, true)
        assert(!f.state().pets.some((p) => p.guid === f.pets[1]))
    } finally {
        f.close()
    }
})

test('color and star-color refunds use the explicit local relative-weight model once each, preserving pet appearance and ordinary release scope', () => {
    const f = fixture('colors', { count: 4, configId: 500002 })
    try {
        for (const [index, color, colorful, multiplier] of [
            [1, 1, 0, 1],
            [2, 0, 1, 1],
            [3, 1, 1, 2],
        ]) {
            f.edit((state) =>
                Object.assign(
                    state.pets.find((p) => p.guid === f.ids[index]),
                    {
                        color,
                        colorful: colorful ? f.tables.get('pet_color')[0].starcolorId : 0,
                        special: colorful ? 4 : color ? 1 : 0,
                    },
                ),
            )
            const before = f.state(),
                original = f.pet(),
                result = published(f, f.train(f.request(7, f.ids[index])), f.ids[index])
            assert.equal(currency(f.state(), 150) - currency(before, 150), BigInt(200 * multiplier))
            assert.equal(
                result.reply.reward.rewards
                    .filter((row) => row.itemtype === 10 && row.itemid === 150)
                    .reduce((sum, row) => sum + row.itemnum, 0),
                200 * multiplier,
            )
            for (const key of ['color', 'colorful', 'special', 'gene_infos', 'talent_id'])
                assert.deepEqual(f.pet()[key], original[key])
        }
        const bad = Object.create(f.tables)
        bad.get = (name) =>
            name === 'drop'
                ? f.tables.get(name).map((row) => (row.dropId === 810001 ? { ...row, weight: -1 } : row))
                : f.tables.get(name)
        assert.throws(
            () => petReleaseColorRewards(bad, { color: 1 }, () => 0, policy),
            (e) => e.code === ErrorCode.GameConfig,
        )
    } finally {
        f.close()
    }
})

test('receipt replay does not consume twice; codec and SQL failures roll back the full tuple and retry safely before cold reopen', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'potential-current-')),
        file = path.join(directory, 'validation-only.sqlite'),
        f = fixture('rollback', { file, configId: 500002 })
    const encode = f.protocol.encode.bind(f.protocol)
    try {
        f.edit((state) =>
            Object.assign(
                state.pets.find((pet) => pet.guid === f.ids[1]),
                {
                    color: 1,
                    colorful: f.tables.get('pet_color')[0].starcolorId,
                    special: 4,
                },
            ),
        )
        const packet = f.frame('KiboTrain', f.request()),
            before = f.snapshot()
        f.protocol.encode = (name, value) => {
            if (name === f.protocol.byId.get(6517).rsp) throw Error('potential sync codec')
            return encode(name, value)
        }
        unchanged(f, () => f.dispatch(packet), /potential sync codec/)
        f.protocol.encode = encode
        f.store.db.exec(
            "CREATE TEMP TRIGGER fail_potential BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT,'potential SQL rollback'); END",
        )
        unchanged(f, () => f.dispatch(packet), /potential SQL rollback/)
        f.store.db.exec('DROP TRIGGER fail_potential')
        assert.deepEqual(f.snapshot(), before)
        published(f, f.dispatch(packet), f.ids[1])
        const committed = f.state(),
            count = committed.petPotentialTrainReceipts.length
        const again = f.dispatch(packet)
        assert.equal(
            f.protocol.decode(f.protocol.byId.get(11913).rsp, again.find((p) => p.id === 11913).payload).is_success,
            true,
        )
        const replayed = f.state(),
            expected = structuredClone(committed)
        // Direct Game replay still runs its ordinary observers. Current Game
        // notifiesJourney before homePayload lazily finalizes home revision;
        // only this derived signature catches up. Real transport ReplayWindow
        // instead replays the original bytes without dispatching Game again.
        assert.equal(replayed.homeRevision, committed.homeRevision)
        expected.journey.observedSources.home = replayed.homeRevision
        assert.deepEqual(replayed, expected)
        assert.equal(f.state().petPotentialTrainReceipts.length, count)
        const conflict = { ...packet, payload: f.protocol.encode(f.protocol.byId.get(11913).req, f.request(5)) }
        unchanged(
            f,
            () => f.dispatch(conflict),
            (e) => e.code === ErrorCode.InvalidPacket,
        )
        const currencyBeforeLogin = currency(f.state(), 150),
            materialBeforeLogin = itemNum(f.state(), 1760000),
            receipt = structuredClone(f.state().petPotentialTrainReceipts),
            login = f.reopen()
        assert.deepEqual(f.state().petPotentialTrainReceipts, receipt)
        assert.equal(currency(f.state(), 150), currencyBeforeLogin)
        assert.equal(itemNum(f.state(), 1760000), materialBeforeLogin)
        assert(
            login.every((packet) => packet.id !== 11913 && f.protocol.byId.get(packet.id).rsp !== 'cs.Rewards'),
            'cold login does not flush training refunds as a delayed reward announcement',
        )
        const synced = f.protocol.decode(f.protocol.byId.get(6517).rsp, login.find((p) => p.id === 6517).payload)
        assert(!synced.pet_infos.pets.some((pet) => pet.guid === f.ids[1]))
        assert.equal(f.pet().comprehension.find((row) => row.attr_id === 7).level, 3)
        unchanged(
            f,
            () => f.train(),
            (e) => e.code === ErrorCode.PetNotExist,
        )
        f.edit((state) => {
            tiers(
                f.tables,
                state.pets.find((pet) => pet.guid === f.ids[0]),
                8,
            )
            state.pets.find((pet) => pet.guid === f.ids[0]).comprehension.find((row) => row.attr_id === 7).cur_exp = 99
        })
        published(f, f.train(f.request(7, f.ids[2])), f.ids[2])
        assert.equal(f.pet().comprehension.find((row) => row.attr_id === 7).level, 9)
        assert.equal(f.pet().comprehension.find((row) => row.attr_id === 7).cur_exp, 0)
    } finally {
        f.protocol.encode = encode
        f.close()
        assert(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep))
        fs.rmSync(directory, { recursive: true, force: true })
    }
})
